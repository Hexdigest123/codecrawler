import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { promisify } from "node:util";
import { createLangChainClient, fetchModelCatalog, resolveProvider } from "@codecrawler/ai";
import { db, schema } from "@codecrawler/db";
import { computeReviewCost, creditsFromSpend } from "@codecrawler/quotas";
import type { BillingMode, CoverageStrategy, DepthTier, Severity } from "@codecrawler/shared";
import {
  DEFAULT_COVERAGE_STRATEGY,
  DEFAULT_NODE_MODELS,
  env,
  resolveDepthFromMode,
} from "@codecrawler/shared";
import type { Diff, DiffFile, PR, VcsAuth } from "@codecrawler/vcs";
import { getVcsProvider } from "@codecrawler/vcs";
import {
  type AIMessage,
  type BaseMessage,
  HumanMessage,
  isAIMessage,
  isToolMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { buildRepoMap } from "./repo-map";
import { createRepoTools, type ToolStats } from "./tools";

const execFileAsync = promisify(execFile);

export type ReviewNodeKey = "orchestrator" | "reviewer" | "summarizer";

export interface NodeModels {
  orchestrator: string;
  reviewer: string;
  summarizer: string;
}

export interface ReviewUnit {
  id: string;
  slice: string;
  files: string[];
  focus?: string;
  instructions?: string;
}

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  category: string;
  message: string;
  suggestion?: string;
}

export interface ReviewInput {
  orgId: string;
  projectId: string;
  prNumber: number;
  repo: { owner: string; name: string };
  repoPath?: string;
  ephemeralRepoPath?: string;
  nodeModels?: NodeModels;
  auth?: VcsAuth;
  coverageStrategy?: CoverageStrategy;
  syntheticPr?: { pr: PR; diff: Diff };
  triggerUserId?: string;
  reviewId?: string;
  profileId?: string;
  /** Origin of the run, surfaced on the review page + used to keep the meter honest. */
  source?: "webhook" | "manual" | "synthetic" | "comment";
  /**
   * Agentic depth tier for this run. When undefined the tier is resolved from
   * REVIEW_AGENT_MODE (auto → DEFAULT_DEPTH_TIER). "static" selects the legacy
   * single-shot path; "quick"/"deep" enable the ReAct agent loop with read-only
   * repo tools. Deep is plan-gated at enqueue time by the API.
   */
  depth?: DepthTier;
}

export interface ReviewResult {
  status: "completed" | "failed";
  walkthrough: string;
  findings: Finding[];
  billingMode: BillingMode;
  creditsCost: number;
  tokenSpendUsd: number;
  modelIds: string[];
  sliceCount: number;
  depth: DepthTier;
  agentSteps: number;
  toolCalls: number;
  error?: string;
}

export interface AgentProfileLike {
  id?: string;
  nodeModels: NodeModels;
  coverageStrategy: CoverageStrategy;
}

export const REVIEW_GRAPH_NODES = [
  "INGEST",
  "PLAN",
  "REVIEW",
  "SYNTHESIZE",
  "POST",
  "DONE",
] as const;

export interface GraphNodeDescriptor {
  key: string;
  label: string;
  role: "orchestrator" | "reviewer" | "summarizer" | "fixed";
  modelBearing: boolean;
  modelId?: string;
  modelDisplayName?: string;
  vendor?: string;
  gateway?: "openrouter" | "saia";
  byok?: boolean;
  weight?: number;
}

export interface GraphEdgeDescriptor {
  from: string;
  to: string;
  label?: string;
  conditional?: boolean;
}

export interface GraphDescriptor {
  graphType: "pr_review";
  nodes: GraphNodeDescriptor[];
  edges: GraphEdgeDescriptor[];
}

async function buildModelNode(
  key: string,
  label: string,
  role: "orchestrator" | "reviewer" | "summarizer",
  modelId: string,
  orgId?: string,
): Promise<GraphNodeDescriptor> {
  const node: GraphNodeDescriptor = { key, label, role, modelBearing: true, modelId };
  try {
    const r = await resolveProvider(modelId, orgId);
    node.modelDisplayName = r.displayName;
    node.vendor = r.vendor;
    node.gateway = r.gateway;
    node.byok = r.billingMode === "byok";
    node.weight = r.weight;
  } catch {
    node.vendor = undefined;
  }
  return node;
}

export async function getReviewGraphDescriptor(opts: {
  orgId?: string;
  nodeModels?: { orchestrator?: string; reviewer?: string; summarizer?: string };
}): Promise<GraphDescriptor> {
  const orch = opts.nodeModels?.orchestrator ?? DEFAULT_NODE_MODELS.orchestrator;
  const rev = opts.nodeModels?.reviewer ?? DEFAULT_NODE_MODELS.reviewer;
  const summ = opts.nodeModels?.summarizer ?? DEFAULT_NODE_MODELS.summarizer;
  const [plan, review, synthesize] = await Promise.all([
    buildModelNode("PLAN", "Plan", "orchestrator", orch, opts.orgId),
    buildModelNode("REVIEW", "Review", "reviewer", rev, opts.orgId),
    buildModelNode("SYNTHESIZE", "Synthesize", "summarizer", summ, opts.orgId),
  ]);
  const nodes: GraphNodeDescriptor[] = [
    { key: "INGEST", label: "Ingest", role: "fixed", modelBearing: false },
    { key: "INDEX", label: "Index", role: "fixed", modelBearing: false },
    plan,
    review,
    synthesize,
    { key: "POST", label: "Post", role: "fixed", modelBearing: false },
  ];
  const edges: GraphEdgeDescriptor[] = [
    { from: "INGEST", to: "INDEX", label: "ok", conditional: true },
    { from: "INDEX", to: "PLAN" },
    { from: "PLAN", to: "REVIEW", label: "fan-out · per unit", conditional: true },
    { from: "PLAN", to: "SYNTHESIZE", label: "if 0 units", conditional: true },
    { from: "REVIEW", to: "SYNTHESIZE", label: "join" },
    { from: "SYNTHESIZE", to: "POST" },
  ];
  return { graphType: "pr_review", nodes, edges };
}

interface Usage {
  promptTokens: number;
  completionTokens: number;
  spendUsd: number;
}

type ReviewCategory = "possible_issue" | "security" | "performance" | "nitpick" | "praise";

const FindingSchema = z.object({
  file: z.string(),
  line: z.number(),
  severity: z.enum(["critical", "high", "medium", "low", "nitpick"]),
  category: z.string(),
  message: z.string(),
  suggestion: z.string().optional(),
});

const FindingsOutputSchema = z.object({ findings: z.array(FindingSchema) });

const PlanTaskSchema = z.object({
  files: z.array(z.string()),
  focus: z.string().optional(),
  instructions: z.string().optional(),
});

const PlanSchema = z.object({
  groups: z.array(z.array(z.string())).optional(),
  tasks: z.array(PlanTaskSchema).optional(),
});

function zeroUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, spendUsd: 0 };
}

function sumUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    spendUsd: a.spendUsd + b.spendUsd,
  };
}

function unionIds(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "unknown error";
}

function resolveNodeModels(input: ReviewInput | undefined): NodeModels {
  return (
    input?.nodeModels ?? {
      orchestrator: DEFAULT_NODE_MODELS.orchestrator,
      reviewer: DEFAULT_NODE_MODELS.reviewer,
      summarizer: DEFAULT_NODE_MODELS.summarizer,
    }
  );
}

/**
 * Resolve the agentic depth tier for a run. Delegates to the shared
 * {@link resolveDepthFromMode} so the API preflight, this graph, and the quota
 * projection all agree; the per-run override comes from ReviewInput.depth (set
 * by the API when the trigger pins a tier, e.g. `/codecrawler deep`).
 */
function resolveDepth(input: ReviewInput | undefined): DepthTier {
  return resolveDepthFromMode(input?.depth);
}

function tierMaxSteps(depth: DepthTier): number {
  if (depth === "deep") return Math.max(1, env.REVIEW_AGENT_MAX_STEPS_DEEP);
  return Math.max(1, env.REVIEW_AGENT_MAX_STEPS_QUICK);
}

function tierBudgetUsd(depth: DepthTier): number {
  if (depth === "deep") return Math.max(0, env.REVIEW_AGENT_BUDGET_USD_DEEP);
  return Math.max(0, env.REVIEW_AGENT_BUDGET_USD_QUICK);
}

/** Race a promise against a hard timeout so a stuck agent loop can't hang a worker slot. */
function withAgentTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`agent timed out after ${ms}ms`)),
        Math.max(1000, ms),
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Sum real token usage across every AIMessage produced by an agent run and
 * price it against the live model catalog. Each intermediate AIMessage carries
 * the token cost of its own (growing) input + output, so summing gives the true
 * spend for the loop — the basis for metered billing.
 */
async function summarizeMessagesUsage(
  messages: BaseMessage[],
  modelId: string,
  orgId: string,
): Promise<Usage> {
  let promptTokens = 0;
  let completionTokens = 0;
  for (const m of messages) {
    if (!isAIMessage(m)) continue;
    const meta = (m as AIMessage).usage_metadata;
    promptTokens += meta?.input_tokens ?? 0;
    completionTokens += meta?.output_tokens ?? 0;
  }
  const pricing = await lookupPricePer1k(modelId, orgId);
  const spendUsd = (promptTokens * pricing.prompt + completionTokens * pricing.completion) / 1000;
  return { promptTokens, completionTokens, spendUsd };
}

interface AgentRunResult {
  content: string;
  usage: Usage;
  /** Number of model (agent) turns in the loop. */
  steps: number;
  /** Number of tool executions in the loop. */
  toolCalls: number;
  stats: ToolStats;
}

/**
 * Run a ReAct agent (model + read-only repo tools) bounded by a step cap and a
 * hard timeout. Returns the final assistant text, cumulative token usage, and
 * step/tool-call counts for observability + metered billing.
 */
async function runAgent(opts: {
  modelId: string;
  orgId: string;
  system: string;
  user: string;
  repoPath: string;
  depth: DepthTier;
}): Promise<AgentRunResult> {
  const { tools, stats } = createRepoTools(opts.repoPath);
  const model = await createLangChainClient({ modelId: opts.modelId, orgId: opts.orgId });
  const agent = createReactAgent({ llm: model, tools, prompt: opts.system });
  const maxSteps = tierMaxSteps(opts.depth);
  // Each agent turn + its tool batch costs ~2 graph transitions, plus a final
  // turn → recursionLimit = 2 * maxSteps + 2 keeps the loop inside the cap.
  const recursionLimit = maxSteps * 2 + 2;
  const result = (await withAgentTimeout(
    agent.invoke({ messages: [new HumanMessage(opts.user)] }, { recursionLimit }),
    env.REVIEW_AGENT_TIMEOUT_MS,
  )) as { messages: BaseMessage[] };
  const messages = result.messages ?? [];
  let content = "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (isAIMessage(m)) {
      content = extractText((m as AIMessage).content);
      break;
    }
  }
  const usage = await summarizeMessagesUsage(messages, opts.modelId, opts.orgId);
  const steps = messages.filter(isAIMessage).length;
  const toolCalls = messages.filter(isToolMessage).length;
  return { content, usage, steps, toolCalls, stats };
}

function normalizeCategory(raw: string): ReviewCategory {
  const c = (raw ?? "").toLowerCase();
  if (c.includes("secur")) return "security";
  if (c.includes("perf")) return "performance";
  if (c.includes("nit")) return "nitpick";
  if (c.includes("praise") || c.includes("positive") || c.includes("good")) return "praise";
  return "possible_issue";
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    if (!f?.file || !Number.isFinite(f.line) || f.line <= 0) continue;
    const key = `${f.file}:${f.line}:${f.message}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function aggregateBilling(modes: BillingMode[]): BillingMode {
  if (modes.length === 0) return "hosted";
  if (modes.every((m) => m === "byok")) return "byok";
  if (modes.every((m) => m === "hosted")) return "hosted";
  return "mixed";
}

async function resolvedOf(
  modelId: string,
  orgId: string,
): Promise<{ weight: number; billingMode: BillingMode }> {
  const r = await resolveProvider(modelId, orgId);
  const weight = typeof r.weight === "number" && Number.isFinite(r.weight) ? r.weight : 1;
  const billingMode = (r.billingMode ?? "hosted") as BillingMode;
  return { weight, billingMode };
}

function extractText(content: AIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) {
          const v = (b as { text?: unknown }).text;
          return typeof v === "string" ? v : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

function extractJson(text: string): unknown {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) t = fence[1].trim();
  const firstObj = t.indexOf("{");
  const lastObj = t.lastIndexOf("}");
  if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) {
    t = t.slice(firstObj, lastObj + 1);
  } else {
    const firstArr = t.indexOf("[");
    const lastArr = t.lastIndexOf("]");
    if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) {
      t = t.slice(firstArr, lastArr + 1);
    } else {
      return null;
    }
  }
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function callModel(
  modelId: string,
  orgId: string,
  system: string,
  user: string,
): Promise<{ text: string; usage: Usage }> {
  const model = await createLangChainClient({ modelId, orgId });
  const res = await model.invoke([new SystemMessage(system), new HumanMessage(user)]);
  const ai = res as AIMessage;
  const meta = ai.usage_metadata;
  const promptTokens = meta?.input_tokens ?? 0;
  const completionTokens = meta?.output_tokens ?? 0;
  const pricing = await lookupPricePer1k(modelId, orgId);
  const spendUsd = (promptTokens * pricing.prompt + completionTokens * pricing.completion) / 1000;
  return {
    text: extractText(ai.content),
    usage: { promptTokens, completionTokens, spendUsd },
  };
}

async function lookupPricePer1k(
  modelId: string,
  orgId: string,
): Promise<{ prompt: number; completion: number }> {
  try {
    const catalog = await fetchModelCatalog(orgId);
    const m = catalog.find((c) => c.id === modelId);
    if (m) {
      return { prompt: m.promptPricePer1k, completion: m.completionPricePer1k };
    }
  } catch {
    // fall through to zero pricing
  }
  return { prompt: 0, completion: 0 };
}

function toFinding(raw: z.infer<typeof FindingSchema>): Finding | null {
  if (!raw?.file || !Number.isFinite(raw.line) || raw.line <= 0) return null;
  return {
    file: raw.file,
    line: Math.floor(raw.line),
    severity: raw.severity,
    category: raw.category || "possible_issue",
    message: raw.message,
    suggestion: raw.suggestion,
  };
}

function buildUnit(
  id: string,
  paths: string[],
  byPath: Map<string, DiffFile>,
  focus?: string,
  instructions?: string,
): ReviewUnit {
  const parts: string[] = [];
  for (const p of paths) {
    const f = byPath.get(p);
    if (!f) continue;
    const header = `--- ${p} (${f.status}, +${f.additions}/-${f.deletions})`;
    parts.push(f.patch ? `${header}\n${f.patch}` : header);
  }
  return { id, files: paths, slice: parts.join("\n\n"), focus, instructions };
}

function capUnits(units: ReviewUnit[], max: number): ReviewUnit[] {
  if (units.length <= max) return units;
  const head = units.slice(0, max - 1);
  const tail = units.slice(max - 1);
  head.push({
    id: `slice-${max}`,
    files: tail.flatMap((u) => u.files),
    slice: tail.map((u) => u.slice).join("\n\n"),
  });
  return head;
}

function truncatePatch(patch: string, maxBytes: number): string {
  if (patch.length <= maxBytes) return patch;
  return `${patch.slice(0, maxBytes)}\n[truncated]`;
}

/** Cap the persisted diff snapshot so we don't blow up the jsonb column. */
const REVIEW_DIFF_SNAPSHOT_MAX_BYTES = 512 * 1024;

function capDiffForStorage(diff: Diff | undefined): Diff | undefined {
  if (!diff?.files?.length) return diff;
  let budget = REVIEW_DIFF_SNAPSHOT_MAX_BYTES;
  const cappedFiles = diff.files.map((f) => {
    const file: DiffFile = { ...f };
    if (file.patch && file.patch.length > budget) {
      file.patch = `${file.patch.slice(0, Math.max(0, budget))}\n[truncated]`;
      budget = 0;
    } else if (file.patch) {
      budget -= file.patch.length;
    }
    return file;
  });
  return { files: cappedFiles };
}

function reviewRepoUrl(input: ReviewInput): string {
  switch (input.auth?.provider) {
    case "github":
      return `https://github.com/${input.repo.owner}/${input.repo.name}.git`;
    case "gitlab":
      return `https://gitlab.com/${input.repo.owner}/${input.repo.name}.git`;
    case "gitea": {
      const base = (input.auth.baseUrl ?? "").replace(/\/$/, "");
      if (!base) throw new Error("gitea checkout requires auth.baseUrl");
      return `${base}/${input.repo.owner}/${input.repo.name}.git`;
    }
    default:
      throw new Error("missing vcs auth for checkout");
  }
}

function prRefCandidates(input: ReviewInput, pr: PR): string[] {
  const refs = [pr.headSha].filter(Boolean);
  switch (input.auth?.provider) {
    case "github":
      refs.push(`refs/pull/${input.prNumber}/head`);
      break;
    case "gitlab":
      refs.push(`refs/merge-requests/${input.prNumber}/head`);
      break;
    case "gitea":
      refs.push(`refs/pull/${input.prNumber}/head`);
      break;
  }
  return Array.from(new Set(refs));
}

async function git(args: string[], cwd: string, token?: string): Promise<void> {
  const gitArgs = token ? ["-c", `http.extraheader=Authorization: Bearer ${token}`, ...args] : args;
  await execFileAsync("git", gitArgs, { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 });
}

async function materializePrCheckout(
  input: ReviewInput,
  pr: PR,
  targetPath: string,
): Promise<void> {
  if (!input.auth) throw new Error("missing vcs auth for checkout");
  await fs.mkdir(targetPath, { recursive: true });
  await git(["init"], targetPath);
  await git(["remote", "add", "origin", reviewRepoUrl(input)], targetPath);
  let lastError = "unknown fetch error";
  for (const ref of prRefCandidates(input, pr)) {
    try {
      await git(["fetch", "--depth=1", "origin", ref], targetPath, input.auth.token);
      await git(["checkout", "--detach", "FETCH_HEAD"], targetPath);
      return;
    } catch (e) {
      lastError = errMsg(e);
    }
  }
  throw new Error(`failed to fetch PR checkout: ${lastError}`);
}

async function buildProjectContext(repoPath: string | undefined, files: string[]): Promise<string> {
  if (!repoPath) return "Project checkout unavailable; review from diff only.";
  const snippets: string[] = [];
  for (const file of files.slice(0, 8)) {
    try {
      const full = nodePath.join(repoPath, file);
      const stat = await fs.stat(full);
      if (!stat.isFile() || stat.size > 200_000) continue;
      const content = await fs.readFile(full, "utf8");
      snippets.push(
        `### ${file}\n\`\`\`\n${content.slice(0, 4000)}${content.length > 4000 ? "\n[truncated]" : ""}\n\`\`\``,
      );
    } catch {}
  }
  if (snippets.length === 0)
    return "Project checkout available, but no changed file snippets were readable.";
  return snippets.join("\n\n");
}

async function buildUnits(
  nodeModels: NodeModels,
  orgId: string,
  strategy: CoverageStrategy,
  files: DiffFile[],
  maxSlices: number,
): Promise<{ units: ReviewUnit[]; usage: Usage }> {
  const perFile = (): ReviewUnit[] =>
    files.map((f, i) => ({
      id: `slice-${i + 1}`,
      files: [f.path],
      slice: f.patch || `@@ ${f.path} ${f.status} +${f.additions}/-${f.deletions}`,
    }));

  if (strategy !== "by_filegroup" || files.length <= 1) {
    return { units: capUnits(perFile(), maxSlices), usage: zeroUsage() };
  }

  let groups: string[][] | null = null;
  let usage = zeroUsage();
  try {
    const fileList = files
      .map((f) => `- ${f.path} [${f.status}, +${f.additions}/-${f.deletions}]`)
      .join("\n");
    const system =
      'You are the orchestrator for an agentic pull request review. Choose specialist review tasks for reviewer subagents based on changed files, risk, and coupling. Respond with ONLY compact JSON: {"tasks":[{"files":["path"],"focus":"short specialist focus","instructions":"specific things this subagent should verify"}]}. Every changed file MUST appear in at least one task. Prefer cohesive tasks, and create extra focused tasks for high-risk areas like auth, data loss, security, migrations, concurrency, billing, or API contracts.';
    const user = `Strategy: ${strategy}\nChanged files:\n${fileList}`;
    const { text, usage: u } = await callModel(nodeModels.orchestrator, orgId, system, user);
    usage = u;
    const parsed = PlanSchema.safeParse(extractJson(text));
    if (parsed.success && parsed.data.tasks?.length) {
      const known = new Set(files.map((f) => f.path));
      const byPath = new Map(files.map((f) => [f.path, f]));
      const units: ReviewUnit[] = [];
      const used = new Set<string>();
      for (let i = 0; i < parsed.data.tasks.length; i += 1) {
        const task = parsed.data.tasks[i];
        const paths = task.files.filter((p) => known.has(p));
        if (paths.length === 0) continue;
        for (const p of paths) used.add(p);
        units.push(buildUnit(`slice-${i + 1}`, paths, byPath, task.focus, task.instructions));
      }
      for (const f of files) {
        if (!used.has(f.path)) {
          used.add(f.path);
          units.push(
            buildUnit(
              `slice-${units.length + 1}`,
              [f.path],
              byPath,
              "Completeness fallback",
              "Review this file because the orchestrator did not assign it to a specialist task.",
            ),
          );
        }
      }
      return { units: capUnits(units, maxSlices), usage };
    }
    if (parsed.success && parsed.data.groups?.length) {
      groups = parsed.data.groups;
    }
  } catch {
    groups = null;
  }

  const known = new Set(files.map((f) => f.path));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const units: ReviewUnit[] = [];
  const used = new Set<string>();
  if (groups) {
    for (let gi = 0; gi < groups.length; gi += 1) {
      const paths = (groups[gi] ?? []).filter((p) => known.has(p) && !used.has(p));
      if (paths.length === 0) continue;
      for (const p of paths) used.add(p);
      units.push(buildUnit(`slice-${gi + 1}`, paths, byPath));
    }
  }
  for (const f of files) {
    if (!used.has(f.path)) {
      used.add(f.path);
      units.push(buildUnit(`slice-${units.length + 1}`, [f.path], byPath));
    }
  }
  return { units: capUnits(units, maxSlices), usage };
}

const ReviewState = Annotation.Root({
  input: Annotation<ReviewInput>,
  pr: Annotation<PR | undefined>({ reducer: (_a, b) => b, default: () => undefined }),
  diff: Annotation<Diff | undefined>({ reducer: (_a, b) => b, default: () => undefined }),
  repoPath: Annotation<string | undefined>({ reducer: (_a, b) => b, default: () => undefined }),
  units: Annotation<ReviewUnit[]>({ reducer: (_a, b) => b ?? [], default: () => [] }),
  currentUnit: Annotation<ReviewUnit | undefined>({
    reducer: (a, b) => b ?? a,
    default: () => undefined,
  }),
  findings: Annotation<Finding[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  walkthrough: Annotation<string | undefined>({ reducer: (_a, b) => b, default: () => undefined }),
  usage: Annotation<Usage>({ reducer: sumUsage, default: zeroUsage }),
  modelIds: Annotation<string[]>({ reducer: unionIds, default: () => [] }),
  billingMode: Annotation<BillingMode | undefined>({
    reducer: (_a, b) => b,
    default: () => undefined,
  }),
  creditsCost: Annotation<number | undefined>({ reducer: (_a, b) => b, default: () => undefined }),
  status: Annotation<string>({ reducer: (_a, b) => b ?? "running", default: () => "running" }),
  error: Annotation<string | undefined>({ reducer: (a, b) => a ?? b, default: () => undefined }),
  // Agentic workflow state.
  repoMap: Annotation<string>({ reducer: (_a, b) => b ?? "", default: () => "" }),
  depth: Annotation<DepthTier>({ reducer: (_a, b) => b ?? "static", default: () => "static" }),
  agentSteps: Annotation<number>({ reducer: (a, b) => a + (b ?? 0), default: () => 0 }),
  toolCalls: Annotation<number>({ reducer: (a, b) => a + (b ?? 0), default: () => 0 }),
});

type State = typeof ReviewState.State;

function envMaxDiffBytes(): number {
  return Math.max(1000, env.REVIEW_MAX_DIFF_BYTES ?? 1500000);
}

function envMaxSlices(): number {
  return Math.max(1, env.REVIEW_MAX_SLICES ?? 16);
}

async function ingestNode(state: State): Promise<Partial<State>> {
  const input = state.input;
  try {
    let pr: PR;
    let diff: Diff;
    if (input.syntheticPr) {
      pr = input.syntheticPr.pr;
      diff = input.syntheticPr.diff;
    } else {
      if (!input.auth) throw new Error("missing vcs auth");
      const vcs = await getVcsProvider(input.auth);
      const [prData, diffData] = await Promise.all([
        vcs.getPullRequest(input.repo.owner, input.repo.name, input.prNumber),
        vcs.getDiff(input.repo.owner, input.repo.name, input.prNumber),
      ]);
      pr = prData;
      diff = diffData;
    }
    const maxBytes = envMaxDiffBytes();
    const files = diff.files.map((f) => ({ ...f, patch: truncatePatch(f.patch, maxBytes) }));
    let repoPath = input.repoPath;
    if (!repoPath && input.ephemeralRepoPath && !input.syntheticPr) {
      try {
        await materializePrCheckout(input, pr, input.ephemeralRepoPath);
        repoPath = input.ephemeralRepoPath;
      } catch (checkoutErr) {
        console.warn(
          `PR checkout unavailable; continuing diff-only review: ${errMsg(checkoutErr)}`,
        );
      }
    }
    return { pr, diff: { files }, repoPath, status: "ingested" };
  } catch (e) {
    return { status: "failed", error: `ingest failed: ${errMsg(e)}` };
  }
}

async function planNode(state: State): Promise<Partial<State>> {
  const input = state.input;
  const nodeModels = resolveNodeModels(input);
  const depth = state.depth;
  const diff = state.diff ?? { files: [] };
  const strategy = input.coverageStrategy ?? DEFAULT_COVERAGE_STRATEGY;
  try {
    // The orchestrator's value is choosing coupled specialist tasks; only the
    // by_filegroup strategy calls a model at all, and only with a real checkout
    // can the agent actually explore. Everything else fans out per-file.
    if (
      depth !== "static" &&
      state.repoPath &&
      strategy === "by_filegroup" &&
      diff.files.length > 1
    ) {
      const built = await buildUnitsAgentic(
        nodeModels,
        input.orgId,
        strategy,
        diff.files,
        envMaxSlices(),
        state.repoMap ?? "",
        state.repoPath,
        depth,
      );
      return {
        units: built.units,
        usage: built.usage,
        modelIds: [nodeModels.orchestrator],
        agentSteps: built.steps,
        toolCalls: built.toolCalls,
        status: "planned",
      };
    }
    const { units, usage } = await buildUnits(
      nodeModels,
      input.orgId,
      strategy,
      diff.files,
      envMaxSlices(),
    );
    return {
      units,
      usage,
      modelIds: [nodeModels.orchestrator],
      status: "planned",
    };
  } catch (e) {
    return { status: "failed", error: `plan failed: ${errMsg(e)}` };
  }
}

/**
 * Agentic planner: the orchestrator explores the real checkout with read-only
 * tools (guided by the repo map) to understand coupling and risk, then emits
 * specialist review tasks. Mirrors {@link buildUnits}' grouping + completeness
 * fallback but sources the plan from a ReAct loop instead of a single shot.
 */
async function buildUnitsAgentic(
  nodeModels: NodeModels,
  orgId: string,
  strategy: CoverageStrategy,
  files: DiffFile[],
  maxSlices: number,
  repoMap: string,
  repoPath: string,
  depth: DepthTier,
): Promise<{ units: ReviewUnit[]; usage: Usage; steps: number; toolCalls: number }> {
  const fileList = files
    .map((f) => `- ${f.path} [${f.status}, +${f.additions}/-${f.deletions}]`)
    .join("\n");
  const system = [
    "You are the orchestrator for an agentic pull request review.",
    "You have read-only tools (read_file, search_code, list_dir) bound to the PR checkout.",
    "Explore the changed files and the surrounding code to understand real coupling and risk before assigning tasks.",
    "Every changed file MUST appear in at least one task.",
    "Prefer cohesive tasks; create extra focused tasks for high-risk areas like auth, data loss, security, migrations, concurrency, billing, or API contracts.",
    'Respond with ONLY compact JSON: {"tasks":[{"files":["path"],"focus":"short specialist focus","instructions":"specific things this subagent should verify"}]}.',
  ].join(" ");
  const user = `Strategy: ${strategy}\n\nRepository map:\n${repoMap}\n\nChanged files:\n${fileList}`;
  const { content, usage, steps, toolCalls } = await runAgent({
    modelId: nodeModels.orchestrator,
    orgId,
    system,
    user,
    repoPath,
    depth,
  });
  const parsed = PlanSchema.safeParse(extractJson(content));
  const known = new Set(files.map((f) => f.path));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const units: ReviewUnit[] = [];
  const used = new Set<string>();
  if (parsed.success && parsed.data.tasks?.length) {
    for (let i = 0; i < parsed.data.tasks.length; i += 1) {
      const task = parsed.data.tasks[i];
      const paths = (task.files ?? []).filter((p) => known.has(p));
      if (paths.length === 0) continue;
      for (const p of paths) used.add(p);
      units.push(buildUnit(`slice-${i + 1}`, paths, byPath, task.focus, task.instructions));
    }
  }
  for (const f of files) {
    if (!used.has(f.path)) {
      used.add(f.path);
      units.push(
        buildUnit(
          `slice-${units.length + 1}`,
          [f.path],
          byPath,
          "Completeness fallback",
          "Review this file because the orchestrator did not assign it to a specialist task.",
        ),
      );
    }
  }
  return { units: capUnits(units, maxSlices), usage, steps, toolCalls };
}

async function reviewNode(state: State): Promise<Partial<State>> {
  const input = state.input;
  const unit = state.currentUnit;
  if (!unit) return {};
  const nodeModels = resolveNodeModels(input);
  const depth = state.depth;
  const focus = unit.focus ? `\nTask focus: ${unit.focus}` : "";
  const instructions = unit.instructions ? `\nOrchestrator instructions: ${unit.instructions}` : "";
  try {
    if (depth !== "static" && state.repoPath) {
      // Budget is shared across the whole run (plan + all reviewers + synthesize).
      // Once cumulative spend reaches the tier ceiling, drop to the static single
      // shot so a runaway loop can never blow past REVIEW_AGENT_BUDGET_USD_*.
      const priorSpend = state.usage?.spendUsd ?? 0;
      const budgetRemaining = tierBudgetUsd(depth) - priorSpend;
      if (budgetRemaining > 0) {
        const projectContext = await buildProjectContext(state.repoPath, unit.files);
        const system = [
          "You are an expert code review subagent with read-only tools (read_file, search_code, list_dir) bound to the PR checkout.",
          "Use the tools to read surrounding code and confirm each suspected issue is real before reporting it.",
          "Report concrete, actionable issues anchored to real changed-line numbers from the diff.",
          "Severity must be one of: critical, high, medium, low, nitpick.",
          "If the task is clean, return an empty findings array.",
          'Respond with ONLY JSON: {"findings":[{"file":string,"line":number,"severity":"critical|high|medium|low|nitpick","category":string,"message":string,"suggestion":string}]}.',
        ].join(" ");
        const user = `Review unit ${unit.id} covering files:\n${unit.files.join("\n")}${focus}${instructions}\n\nProject checkout context:\n${projectContext}\n\nDiff:\n${unit.slice}`;
        const { content, usage, steps, toolCalls } = await runAgent({
          modelId: nodeModels.reviewer,
          orgId: input.orgId,
          system,
          user,
          repoPath: state.repoPath,
          depth,
        });
        const parsed = FindingsOutputSchema.safeParse(extractJson(content));
        let findings: Finding[] = [];
        if (parsed.success) {
          findings = parsed.data.findings.map(toFinding).filter((f): f is Finding => f !== null);
        }
        return { findings, usage, modelIds: [nodeModels.reviewer], agentSteps: steps, toolCalls };
      }
    }
    const projectContext = await buildProjectContext(state.repoPath ?? input.repoPath, unit.files);
    const system = [
      "You are an expert code review subagent.",
      "Execute only the orchestrator-assigned task and use the project checkout context to understand surrounding code.",
      "Report concrete, actionable issues anchored to real changed-line numbers from the diff.",
      "Severity must be one of: critical, high, medium, low, nitpick.",
      "If the task is clean, return an empty findings array.",
      'Respond with ONLY JSON: {"findings":[{"file":string,"line":number,"severity":"critical|high|medium|low|nitpick","category":string,"message":string,"suggestion":string}]}.',
    ].join(" ");
    const user = `Review unit ${unit.id} covering files:\n${unit.files.join("\n")}${focus}${instructions}\n\nProject checkout context:\n${projectContext}\n\nDiff:\n${unit.slice}`;
    const { text, usage } = await callModel(nodeModels.reviewer, input.orgId, system, user);
    const parsed = FindingsOutputSchema.safeParse(extractJson(text));
    let findings: Finding[] = [];
    if (parsed.success) {
      findings = parsed.data.findings.map(toFinding).filter((f): f is Finding => f !== null);
    }
    return { findings, usage, modelIds: [nodeModels.reviewer] };
  } catch (e) {
    return { error: `review failed for ${unit.id}: ${errMsg(e)}` };
  }
}

async function synthesizeNode(state: State): Promise<Partial<State>> {
  const input = state.input;
  const nodeModels = resolveNodeModels(input);
  try {
    const deduped = dedupeFindings(state.findings ?? []);
    const diff = state.diff ?? { files: [] };
    const fileList = diff.files
      .map((f) => `- ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`)
      .join("\n");
    const findingsText =
      deduped.length === 0
        ? "(no issues found)"
        : deduped
            .map((f) => `- [${f.severity}] ${f.file}:${f.line} (${f.category}) — ${f.message}`)
            .join("\n");
    const system =
      "You are a tech lead writing a concise PR review walkthrough in Markdown. Include: a one-paragraph summary of what changed, an overall 'Risk level: Low|Medium|High|Critical' with a one-line rationale, and a short bullet list of the most important highlights or concerns. Only reference the findings provided; do not invent new issues.";
    const user = `Changed files:\n${fileList}\n\nFindings:\n${findingsText}`;
    const { text, usage } = await callModel(nodeModels.summarizer, input.orgId, system, user);
    return {
      findings: deduped,
      walkthrough: text || "Review complete.",
      usage,
      modelIds: [nodeModels.summarizer],
      status: "synthesized",
    };
  } catch (e) {
    return { status: "failed", error: `synthesize failed: ${errMsg(e)}` };
  }
}

async function ensurePullRequest(input: ReviewInput, pr: PR): Promise<string> {
  const existing = await db
    .select({ id: schema.pullRequests.id })
    .from(schema.pullRequests)
    .where(
      and(
        eq(schema.pullRequests.projectId, input.projectId),
        eq(schema.pullRequests.externalNumber, input.prNumber),
      ),
    )
    .limit(1);
  if (existing[0]?.id) {
    // Back-fill metadata (title/author/SHAs/htmlUrl) in case the row was
    // inserted at enqueue time before the PR was fetched.
    await db
      .update(schema.pullRequests)
      .set({
        title: pr.title,
        author: pr.author,
        baseSha: pr.baseSha,
        headSha: pr.headSha,
        state: pr.state,
        htmlUrl: pr.htmlUrl || null,
      })
      .where(eq(schema.pullRequests.id, existing[0].id));
    return existing[0].id;
  }
  const [row] = await db
    .insert(schema.pullRequests)
    .values({
      projectId: input.projectId,
      externalNumber: input.prNumber,
      title: pr.title,
      author: pr.author,
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      state: pr.state,
      htmlUrl: pr.htmlUrl || null,
    })
    .returning({ id: schema.pullRequests.id });
  if (!row?.id) throw new Error("failed to insert pull_request");
  return row.id;
}

async function persistReview(
  input: ReviewInput,
  pr: PR,
  reviewStatus: "completed" | "failed",
  walkthrough: string,
  billingMode: BillingMode,
  creditsCost: number,
  spendUsd: number,
  modelIds: string[],
  findings: Finding[],
  depth: DepthTier,
  agentSteps: number,
  toolCalls: number,
  diffSnapshot: Diff | undefined,
): Promise<string> {
  const source = input.source ?? (input.syntheticPr ? "synthetic" : "manual");
  if (input.reviewId) {
    const rid = input.reviewId;
    await db
      .update(schema.reviews)
      .set({
        status: reviewStatus,
        walkthrough,
        billingMode,
        creditsCost: creditsCost.toFixed(4),
        tokenSpendUsd: spendUsd.toFixed(4),
        modelIds,
        source,
        depth,
        agentSteps,
        toolCalls,
        diff: diffSnapshot ?? null,
        completedAt: new Date(),
      })
      .where(eq(schema.reviews.id, rid));
    await db.delete(schema.reviewFindings).where(eq(schema.reviewFindings.reviewId, rid));
    if (findings.length > 0) {
      await db.insert(schema.reviewFindings).values(
        findings.map((f) => ({
          reviewId: rid,
          file: f.file,
          line: f.line,
          severity: f.severity,
          category: normalizeCategory(f.category),
          message: f.message,
          suggestion: f.suggestion ?? null,
        })),
      );
    }
    return rid;
  }

  const prId = await ensurePullRequest(input, pr);
  const [review] = await db
    .insert(schema.reviews)
    .values({
      prId,
      projectId: input.projectId,
      profileId: input.profileId ?? null,
      status: reviewStatus,
      walkthrough,
      billingMode,
      creditsCost: creditsCost.toFixed(4),
      tokenSpendUsd: spendUsd.toFixed(4),
      modelIds,
      source,
      depth,
      agentSteps,
      toolCalls,
      diff: diffSnapshot ?? null,
      completedAt: new Date(),
    })
    .returning({ id: schema.reviews.id });
  const reviewId = review?.id;
  if (reviewId && findings.length > 0) {
    await db.insert(schema.reviewFindings).values(
      findings.map((f) => ({
        reviewId,
        file: f.file,
        line: f.line,
        severity: f.severity,
        category: normalizeCategory(f.category),
        message: f.message,
        suggestion: f.suggestion ?? null,
      })),
    );
  }
  return reviewId ?? "";
}

async function postNode(state: State): Promise<Partial<State>> {
  const input = state.input;
  const pr = state.pr;
  if (!pr) {
    return { status: "failed", error: state.error ?? "missing pr" };
  }
  const nodeModels = resolveNodeModels(input);
  try {
    const findings = state.findings ?? [];
    const sliceCount = (state.units ?? []).length;
    const orch = await resolvedOf(nodeModels.orchestrator, input.orgId);
    const rev = await resolvedOf(nodeModels.reviewer, input.orgId);
    const summ = await resolvedOf(nodeModels.summarizer, input.orgId);
    const billingMode = aggregateBilling([orch.billingMode, rev.billingMode, summ.billingMode]);
    const failed = Boolean(state.error);
    const depth = resolveDepth(input);
    const spendUsd = state.usage?.spendUsd ?? 0;
    // Metered billing: agentic runs charge real token spend at the metered rate
    // (spendUsd × CREDITS_PER_USD); the static path keeps the model-weight
    // formula. BYOK runs are free of platform charges; failed runs cost nothing.
    let creditsCost: number;
    if (failed || billingMode === "byok") {
      creditsCost = 0;
    } else if (depth !== "static") {
      creditsCost = creditsFromSpend(spendUsd, billingMode);
    } else {
      creditsCost = computeReviewCost({
        orchestratorWeight: orch.weight,
        reviewerWeight: rev.weight,
        summarizerWeight: summ.weight,
        sliceCount,
      });
    }
    const modelIds = Array.from(
      new Set([nodeModels.orchestrator, nodeModels.reviewer, nodeModels.summarizer]),
    );
    const walkthrough = state.walkthrough ?? "";
    const reviewStatus: "completed" | "failed" = failed ? "failed" : "completed";
    const agentSteps = state.agentSteps ?? 0;
    const toolCalls = state.toolCalls ?? 0;

    await persistReview(
      input,
      pr,
      reviewStatus,
      walkthrough,
      billingMode,
      creditsCost,
      spendUsd,
      modelIds,
      findings,
      depth,
      agentSteps,
      toolCalls,
      capDiffForStorage(state.diff),
    );

    if (input.syntheticPr) {
      console.log("synthetic review: skipped VCS post");
    } else if (!failed && input.auth) {
      try {
        const vcs = await getVcsProvider(input.auth);
        const hasHigh = findings.some((f) => f.severity === "critical" || f.severity === "high");
        await vcs.postReview(input.repo.owner, input.repo.name, input.prNumber, {
          status: hasHigh ? "request_changes" : "comment",
          summary: walkthrough,
          comments: findings.map((f) => ({
            path: f.file,
            line: f.line,
            side: "RIGHT",
            body: `**[${f.severity}] ${normalizeCategory(f.category).replace("_", " ")}**: ${f.message}${f.suggestion ? `\n\nSuggestion: ${f.suggestion}` : ""}`,
          })),
        });
      } catch (postErr) {
        console.warn(`vcs postReview failed: ${errMsg(postErr)}`);
      }
    }

    return { status: reviewStatus, billingMode, creditsCost, modelIds };
  } catch (e) {
    return { status: "failed", error: `post failed: ${errMsg(e)}` };
  }
}

/**
 * Build (or fetch from Redis) the compact repo map and resolve the depth tier
 * once for the whole run. Runs on every review — for the static path it's a
 * near-free no-op (no checkout, empty map); for the agentic path the cached map
 * is the token-cheap structural context every downstream agent starts from.
 */
async function indexNode(state: State): Promise<Partial<State>> {
  const depth = resolveDepth(state.input);
  if (depth === "static" || !state.repoPath) {
    return { depth, repoMap: state.repoMap ?? "" };
  }
  try {
    const sha = state.pr?.headSha;
    const map = await buildRepoMap(state.repoPath, sha ?? undefined);
    return { depth, repoMap: map.text };
  } catch (e) {
    console.warn(`[agents] repo map build failed: ${errMsg(e)}`);
    return { depth, repoMap: state.repoMap ?? "" };
  }
}

function ingestRouter(state: State): string {
  return state.error ? END : "INDEX";
}

function planFanOut(state: State): string | Send[] {
  if (state.error) return END;
  const units = state.units ?? [];
  if (units.length === 0) return "SYNTHESIZE";
  const input = state.input;
  return units.map((u) => new Send("REVIEW", { currentUnit: u, input }));
}

let defaultSaver: PostgresSaver | null = null;

async function getDefaultSaver(): Promise<PostgresSaver> {
  const connStr = process.env.DATABASE_URL ?? "";
  if (!connStr) throw new Error("DATABASE_URL is not set");
  if (!defaultSaver) {
    defaultSaver = PostgresSaver.fromConnString(connStr);
    await defaultSaver.setup();
  }
  return defaultSaver;
}

export async function createReviewGraph(checkpointer?: PostgresSaver) {
  const saver = checkpointer ?? (await getDefaultSaver());
  const builder = new StateGraph(ReviewState)
    .addNode("INGEST", ingestNode)
    .addNode("INDEX", indexNode)
    .addNode("PLAN", planNode)
    .addNode("REVIEW", reviewNode)
    .addNode("SYNTHESIZE", synthesizeNode)
    .addNode("POST", postNode)
    .addEdge(START, "INGEST")
    .addConditionalEdges("INGEST", ingestRouter)
    .addEdge("INDEX", "PLAN")
    .addConditionalEdges("PLAN", planFanOut)
    .addEdge("REVIEW", "SYNTHESIZE")
    .addEdge("SYNTHESIZE", "POST")
    .addEdge("POST", END);
  return builder.compile({ checkpointer: saver });
}

function toResult(state: State): ReviewResult {
  const failed = state.status === "failed" || Boolean(state.error);
  return {
    status: failed ? "failed" : "completed",
    walkthrough: state.walkthrough ?? "",
    findings: state.findings ?? [],
    billingMode: state.billingMode ?? "hosted",
    creditsCost: state.creditsCost ?? 0,
    tokenSpendUsd: state.usage?.spendUsd ?? 0,
    modelIds: state.modelIds ?? [],
    sliceCount: state.units?.length ?? 0,
    depth: state.depth ?? "static",
    agentSteps: state.agentSteps ?? 0,
    toolCalls: state.toolCalls ?? 0,
    error: state.error,
  };
}

function failedResult(error: string): ReviewResult {
  return {
    status: "failed",
    walkthrough: "",
    findings: [],
    billingMode: "hosted",
    creditsCost: 0,
    tokenSpendUsd: 0,
    modelIds: [],
    sliceCount: 0,
    depth: "static",
    agentSteps: 0,
    toolCalls: 0,
    error,
  };
}

export async function runReview(input: ReviewInput): Promise<ReviewResult> {
  const wantsCheckout = !input.syntheticPr && !input.repoPath && Boolean(input.auth);
  const ephemeralRepoPath = wantsCheckout
    ? nodePath.join(os.tmpdir(), `cc-review-${input.projectId}-${input.prNumber}-${Date.now()}`)
    : undefined;
  const runInput: ReviewInput = ephemeralRepoPath ? { ...input, ephemeralRepoPath } : input;
  try {
    const graph = await createReviewGraph();
    const threadId = `review-${input.projectId}-${input.prNumber}-${Date.now()}`;
    const init: State = {
      input: runInput,
      pr: undefined,
      diff: undefined,
      repoPath: input.repoPath,
      units: [],
      currentUnit: undefined,
      findings: [],
      walkthrough: undefined,
      usage: zeroUsage(),
      modelIds: [],
      billingMode: undefined,
      creditsCost: undefined,
      status: "running",
      error: undefined,
      repoMap: "",
      depth: resolveDepth(runInput),
      agentSteps: 0,
      toolCalls: 0,
    };
    const final = (await graph.invoke(init, {
      configurable: { thread_id: threadId },
      recursionLimit: 250,
    })) as State;
    return toResult(final);
  } catch (e) {
    return failedResult(errMsg(e));
  } finally {
    if (ephemeralRepoPath) {
      await fs
        .rm(ephemeralRepoPath, { recursive: true, force: true })
        .catch((cleanupErr: unknown) =>
          console.warn(`[agents] failed to remove ephemeral checkout: ${errMsg(cleanupErr)}`),
        );
    }
  }
}

export type { RepoMapResult } from "./repo-map";
export { buildRepoMap } from "./repo-map";
export type { RepoToolName, RepoTools, ToolStats } from "./tools";
export { createRepoTools, REPO_TOOL_NAMES } from "./tools";
