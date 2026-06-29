import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import nodePath from "node:path";
import { createLangChainClient, fetchModelCatalog, resolveProvider } from "@codecrawler/ai";
import { db, schema } from "@codecrawler/db";
import { computeReviewCost, computeSecurityCost } from "@codecrawler/quotas";
import type { RawSecurityFinding } from "@codecrawler/security";
import { runSecretScan, runSnykScan } from "@codecrawler/security";
import type { BillingMode, CoverageStrategy, Severity } from "@codecrawler/shared";
import { DEFAULT_COVERAGE_STRATEGY, DEFAULT_NODE_MODELS, env } from "@codecrawler/shared";
import type { Diff, DiffFile, PR, VcsAuth } from "@codecrawler/vcs";
import { getVcsProvider } from "@codecrawler/vcs";
import { type AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

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
  nodeModels?: NodeModels;
  auth?: VcsAuth;
  coverageStrategy?: CoverageStrategy;
  syntheticPr?: { pr: PR; diff: Diff };
  triggerUserId?: string;
  reviewId?: string;
  profileId?: string;
  /** Origin of the run, surfaced on the review page + used to keep the meter honest. */
  source?: "webhook" | "manual" | "synthetic" | "comment";
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
  error?: string;
}

export interface AgentProfileLike {
  id?: string;
  nodeModels: NodeModels;
  coverageStrategy: CoverageStrategy;
}

export const REVIEW_GRAPH_NODES = [
  "INGEST",
  "SECURITY",
  "PLAN",
  "REVIEW",
  "SYNTHESIZE",
  "POST",
  "DONE",
] as const;

export const SECURITY_GRAPH_NODES = [
  "INDEX",
  "PLAN",
  "SNYK",
  "SECRETS",
  "AI",
  "SYNTHESIZE",
  "REPORT",
] as const;

export interface GraphNodeDescriptor {
  key: string;
  label: string;
  role: "orchestrator" | "reviewer" | "summarizer" | "securityAnalyst" | "fixed";
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
  graphType: "pr_review" | "security";
  nodes: GraphNodeDescriptor[];
  edges: GraphEdgeDescriptor[];
}

async function buildModelNode(
  key: string,
  label: string,
  role: "orchestrator" | "reviewer" | "summarizer" | "securityAnalyst",
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
    { key: "SECURITY", label: "Security tools", role: "fixed", modelBearing: false },
    plan,
    review,
    synthesize,
    { key: "POST", label: "Post", role: "fixed", modelBearing: false },
  ];
  const edges: GraphEdgeDescriptor[] = [
    { from: "INGEST", to: "SECURITY", label: "ok", conditional: true },
    { from: "SECURITY", to: "PLAN" },
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

const PlanSchema = z.object({
  groups: z.array(z.array(z.string())),
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

function buildUnit(id: string, paths: string[], byPath: Map<string, DiffFile>): ReviewUnit {
  const parts: string[] = [];
  for (const p of paths) {
    const f = byPath.get(p);
    if (!f) continue;
    const header = `--- ${p} (${f.status}, +${f.additions}/-${f.deletions})`;
    parts.push(f.patch ? `${header}\n${f.patch}` : header);
  }
  return { id, files: paths, slice: parts.join("\n\n") };
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
      'You are a staff engineer planning a code review. Group the changed files into cohesive review units so related changes stay together. Respond with ONLY compact JSON: {"groups":[["path","path"],["path"]]} — an array of groups, each an array of file paths. Every listed file MUST appear in exactly one group. Prefer fewer, cohesive groups.';
    const user = `Strategy: ${strategy}\nChanged files:\n${fileList}`;
    const { text, usage: u } = await callModel(nodeModels.orchestrator, orgId, system, user);
    usage = u;
    const parsed = PlanSchema.safeParse(extractJson(text));
    if (parsed.success && parsed.data.groups.length > 0) {
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
  units: Annotation<ReviewUnit[]>({ reducer: (_a, b) => b ?? [], default: () => [] }),
  currentUnit: Annotation<ReviewUnit | undefined>({
    reducer: (a, b) => b ?? a,
    default: () => undefined,
  }),
  findings: Annotation<Finding[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  securityFindings: Annotation<RawSecurityFinding[]>({
    reducer: (_a, b) => b ?? [],
    default: () => [],
  }),
  securitySummary: Annotation<string | undefined>({
    reducer: (_a, b) => b,
    default: () => undefined,
  }),
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
    return { pr, diff: { files }, status: "ingested" };
  } catch (e) {
    return { status: "failed", error: `ingest failed: ${errMsg(e)}` };
  }
}

async function planNode(state: State): Promise<Partial<State>> {
  const input = state.input;
  const nodeModels = resolveNodeModels(input);
  try {
    const diff = state.diff ?? { files: [] };
    const strategy = input.coverageStrategy ?? DEFAULT_COVERAGE_STRATEGY;
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

function securityFindingToReviewFinding(f: RawSecurityFinding): Finding | null {
  if (!f.file || !Number.isFinite(f.line) || !f.line || f.line <= 0) return null;
  return {
    file: f.file,
    line: Math.floor(f.line),
    severity: f.severity ?? "low",
    category: "security",
    message: `[${f.kind}] ${f.message}`,
    suggestion: f.fixedVersion ? `Update to ${f.fixedVersion}.` : undefined,
  };
}

function buildPrSecurityToolSummary(findings: RawSecurityFinding[], toolNotes: string[]): string {
  const ranked = rankSecurityFindings(dedupeSecurityFindings(findings));
  const counts = countBySeverity(ranked);
  const total = ranked.length;
  const lines = [
    "## Security tools",
    `- Findings: ${total} total; critical ${counts.critical}, high ${counts.high}, medium ${counts.medium}, low ${counts.low}, nitpick ${counts.nitpick}.`,
    ...toolNotes.map((note) => `- ${note}`),
  ];
  if (ranked.length > 0) {
    lines.push("", "Top security findings:");
    for (const finding of ranked.slice(0, 10)) lines.push(formatSecurityFinding(finding));
  }
  return lines.join("\n");
}

async function securityToolsNode(state: State): Promise<Partial<State>> {
  const repoPath = state.input.repoPath;
  const toolNotes: string[] = [];
  const findings: RawSecurityFinding[] = [];

  if (!repoPath) {
    return {
      securityFindings: [],
      securitySummary: buildPrSecurityToolSummary(
        [],
        ["Snyk and secret scanning skipped because this PR review has no local repoPath."],
      ),
      status: "security_checked",
    };
  }

  try {
    const [snyk, secrets] = await Promise.all([
      runSnykScan(repoPath).catch((e) => ({ error: errMsg(e), depFindings: [], sastFindings: [] })),
      runSecretScan(repoPath).catch(() => []),
    ]);

    findings.push(...(snyk.depFindings ?? []), ...(snyk.sastFindings ?? []), ...secrets);
    const snykSource = "source" in snyk ? snyk.source : "error";
    toolNotes.push(
      `Snyk completed with source ${snykSource}${snyk.error ? ` (${snyk.error})` : ""}.`,
    );
    toolNotes.push(
      `Secret scan completed with ${secrets.length} finding${secrets.length === 1 ? "" : "s"}.`,
    );

    return {
      findings: findings
        .map(securityFindingToReviewFinding)
        .filter((f): f is Finding => f !== null),
      securityFindings: findings,
      securitySummary: buildPrSecurityToolSummary(findings, toolNotes),
      status: "security_checked",
    };
  } catch (e) {
    return {
      securityFindings: findings,
      securitySummary: buildPrSecurityToolSummary(findings, [
        `Security tools failed: ${errMsg(e)}`,
      ]),
      status: "security_checked",
    };
  }
}

async function reviewNode(state: State): Promise<Partial<State>> {
  const input = state.input;
  const unit = state.currentUnit;
  if (!unit) return {};
  const nodeModels = resolveNodeModels(input);
  try {
    const system =
      'You are an expert code reviewer. Review the diff slice below and report concrete, actionable issues anchored to real line numbers from the diff. Severity must be one of: critical, high, medium, low, nitpick. If the change is clean, return an empty findings array. Respond with ONLY JSON: {"findings":[{"file":string,"line":number,"severity":"critical|high|medium|low|nitpick","category":string,"message":string,"suggestion":string}]}.';
    const user = `Review unit ${unit.id} covering files:\n${unit.files.join("\n")}\n\nDiff:\n${unit.slice}`;
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
    const securitySummary =
      state.securitySummary?.trim() || "## Security tools\n- No security tool output.";
    const system =
      "You are a tech lead writing a concise PR review walkthrough in Markdown. Include: a one-paragraph summary of what changed, an overall 'Risk level: Low|Medium|High|Critical' with a one-line rationale, a short bullet list of the most important highlights or concerns, and a compact security tools section. Only reference the findings and tool output provided; do not invent new issues.";
    const user = `Changed files:\n${fileList}\n\nFindings:\n${findingsText}\n\n${securitySummary}`;
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
    const projected = failed
      ? 0
      : computeReviewCost({
          orchestratorWeight: orch.weight,
          reviewerWeight: rev.weight,
          summarizerWeight: summ.weight,
          sliceCount,
        });
    const creditsCost = billingMode === "byok" ? 0 : projected;
    const modelIds = Array.from(
      new Set([nodeModels.orchestrator, nodeModels.reviewer, nodeModels.summarizer]),
    );
    const walkthrough = state.walkthrough ?? "";
    const reviewStatus: "completed" | "failed" = failed ? "failed" : "completed";
    const spendUsd = state.usage?.spendUsd ?? 0;

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

function ingestRouter(state: State): string {
  return state.error ? END : "SECURITY";
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
    .addNode("SECURITY", securityToolsNode)
    .addNode("PLAN", planNode)
    .addNode("REVIEW", reviewNode)
    .addNode("SYNTHESIZE", synthesizeNode)
    .addNode("POST", postNode)
    .addEdge(START, "INGEST")
    .addConditionalEdges("INGEST", ingestRouter)
    .addEdge("SECURITY", "PLAN")
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
    error,
  };
}

export async function runReview(input: ReviewInput): Promise<ReviewResult> {
  try {
    const graph = await createReviewGraph();
    const threadId = `review-${input.projectId}-${input.prNumber}-${Date.now()}`;
    const init: State = {
      input,
      pr: undefined,
      diff: undefined,
      units: [],
      currentUnit: undefined,
      findings: [],
      securityFindings: [],
      securitySummary: undefined,
      walkthrough: undefined,
      usage: zeroUsage(),
      modelIds: [],
      billingMode: undefined,
      creditsCost: undefined,
      status: "running",
      error: undefined,
    };
    const final = (await graph.invoke(init, {
      configurable: { thread_id: threadId },
      recursionLimit: 250,
    })) as State;
    return toResult(final);
  } catch (e) {
    return failedResult(errMsg(e));
  }
}

export interface SecurityNodeModels {
  orchestrator: string;
  securityAnalyst: string;
  summarizer: string;
}

export interface SecurityInput {
  orgId: string;
  projectId: string;
  reportId?: string;
  profileId?: string;
  repoPath?: string;
  repo?: { owner: string; name: string };
  auth?: VcsAuth;
  nodeModels?: SecurityNodeModels;
  triggerEmail?: string;
}

export interface SecurityResult {
  status: "completed" | "failed";
  summary: string;
  findings: RawSecurityFinding[];
  billingMode: BillingMode;
  creditsCost: number;
  tokenSpendUsd: number;
  modelIds: string[];
  snykSource: string;
  scopeCount: number;
  error?: string;
}

const IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  ".turbo",
  ".output",
  "target",
  "vendor",
  ".vercel",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".swift",
  ".scala",
  ".clj",
  ".ex",
  ".exs",
  ".heex",
  ".vue",
  ".svelte",
  ".sh",
  ".tf",
]);

const AiFindingSchema = z.object({
  kind: z.enum(["sast", "dep", "secret", "ai"]).default("ai"),
  severity: z.enum(["critical", "high", "medium", "low", "nitpick"]),
  file: z.string().optional(),
  line: z.number().optional(),
  package: z.string().optional(),
  vulnVersion: z.string().optional(),
  fixedVersion: z.string().optional(),
  message: z.string(),
  rule: z.string().optional(),
});

const AiFindingsOutputSchema = z.object({ findings: z.array(AiFindingSchema) });

const SecurityPlanSchema = z.object({ scopes: z.array(z.string()) });

function resolveSecurityNodeModels(input: SecurityInput | undefined): SecurityNodeModels {
  const nm = (input?.nodeModels ?? {}) as Record<string, string | undefined>;
  return {
    orchestrator: nm.orchestrator ?? DEFAULT_NODE_MODELS.orchestrator,
    securityAnalyst: nm.securityAnalyst ?? nm.reviewer ?? DEFAULT_NODE_MODELS.securityAnalyst,
    summarizer: nm.summarizer ?? DEFAULT_NODE_MODELS.summarizer,
  };
}

function severityRank(sev: Severity | undefined): number {
  switch (sev) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function dedupeSecurityFindings(findings: RawSecurityFinding[]): RawSecurityFinding[] {
  const seen = new Set<string>();
  const out: RawSecurityFinding[] = [];
  for (const f of findings) {
    if (!f?.message) continue;
    const key =
      `${f.kind ?? "ai"}:${f.file ?? ""}:${f.line ?? ""}:${f.package ?? ""}:${f.message}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function rankSecurityFindings(findings: RawSecurityFinding[]): RawSecurityFinding[] {
  return [...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function countBySeverity(findings: RawSecurityFinding[]): Record<string, number> {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, nitpick: 0 };
  for (const f of findings) {
    const sev = (f.severity ?? "low") as keyof typeof counts;
    if (sev in counts) counts[sev] += 1;
  }
  return counts;
}

function formatSecurityFinding(f: RawSecurityFinding): string {
  const where = [f.file, f.line].filter((v) => v !== undefined && v !== null && v !== "").join(":");
  const pkg = f.package
    ? ` ${f.package}${f.vulnVersion ? `@${f.vulnVersion}` : ""}${f.fixedVersion ? ` (fix: ${f.fixedVersion})` : ""}`
    : "";
  return `- [${f.severity ?? "low"}][${f.kind ?? "ai"}] ${where || "(unknown location)"}${pkg} — ${f.message}`;
}

function buildSecurityFallbackSummary(
  counts: Record<string, number>,
  ranked: RawSecurityFinding[],
): string {
  const total = ranked.length;
  const risk =
    counts.critical > 0
      ? "Critical"
      : counts.high > 0
        ? "High"
        : counts.medium > 0
          ? "Medium"
          : "Low";
  const lines: string[] = [
    "# Security Report",
    "",
    `**Overall risk: ${risk}** — ${total} finding${total === 1 ? "" : "s"} across Snyk (deps/SAST), secret scan, and AI analyst.`,
    "",
    "## Counts by severity",
    `- Critical: ${counts.critical}`,
    `- High: ${counts.high}`,
    `- Medium: ${counts.medium}`,
    `- Low: ${counts.low}`,
    `- Nitpick: ${counts.nitpick}`,
    "",
    "## Top concerns",
  ];
  if (total === 0) {
    lines.push("(no issues found)");
  } else {
    for (const f of ranked.slice(0, 15)) lines.push(formatSecurityFinding(f));
  }
  return lines.join("\n");
}

function toSecurityFindingRow(reportId: string) {
  return (f: RawSecurityFinding) => ({
    reportId,
    kind: (f.kind ?? "ai") as "sast" | "dep" | "secret" | "ai",
    severity: (f.severity ?? "low") as Severity,
    file: f.file ?? null,
    line: f.line ?? null,
    packageName: f.package ?? null,
    vulnVersion: f.vulnVersion ?? null,
    fixedVersion: f.fixedVersion ?? null,
    message: f.message,
  });
}

async function listRepoFiles(repoPath: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length > 500 || depth > 3) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = nodePath.join(dir, entry.name);
      const rel = nodePath.relative(repoPath, full);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(rel);
      }
      if (out.length > 500) return;
    }
  }
  await walk(repoPath, 0);
  return out;
}

async function readScopeSnippets(repoPath: string | undefined, scope: string): Promise<string> {
  if (!repoPath) return "";
  const scopeDir = scope === "." ? repoPath : nodePath.join(repoPath, scope);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(scopeDir, { withFileTypes: true });
  } catch {
    return `(scope ${scope}: unreadable)`;
  }
  const files = entries
    .filter((e) => e.isFile() && !IGNORE_DIRS.has(e.name))
    .map((e) => e.name)
    .filter(
      (n) =>
        CODE_EXTENSIONS.has(nodePath.extname(n).toLowerCase()) ||
        /^(readme|license|dockerfile|makefile)/i.test(n),
    )
    .slice(0, 6);
  const parts: string[] = [];
  for (const name of files) {
    try {
      const full = nodePath.join(scopeDir, name);
      const stat = await fs.stat(full);
      if (stat.size > 200_000) continue;
      const content = await fs.readFile(full, "utf8");
      const truncated = content.length > 4000 ? `${content.slice(0, 4000)}\n[truncated]` : content;
      parts.push(`### ${nodePath.relative(repoPath, full)}\n\`\`\`\n${truncated}\n\`\`\``);
    } catch {}
    if (parts.length >= 4) break;
  }
  if (parts.length === 0) return `(scope ${scope}: no readable source files)`;
  return parts.join("\n\n");
}

const SecurityState = Annotation.Root({
  input: Annotation<SecurityInput>,
  repoPath: Annotation<string | undefined>({ reducer: (_a, b) => b, default: () => undefined }),
  scopes: Annotation<string[]>({ reducer: (_a, b) => b ?? [], default: () => [] }),
  currentScope: Annotation<string | undefined>({
    reducer: (a, b) => b ?? a,
    default: () => undefined,
  }),
  snykResult: Annotation<{ source: string; raw: unknown } | undefined>({
    reducer: (_a, b) => b,
    default: () => undefined,
  }),
  secretFindings: Annotation<RawSecurityFinding[]>({
    reducer: (_a, b) => b ?? [],
    default: () => [],
  }),
  aiFindings: Annotation<RawSecurityFinding[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
  findings: Annotation<RawSecurityFinding[]>({ reducer: (_a, b) => b ?? [], default: () => [] }),
  summary: Annotation<string | undefined>({ reducer: (_a, b) => b, default: () => undefined }),
  usage: Annotation<Usage>({ reducer: sumUsage, default: zeroUsage }),
  modelIds: Annotation<string[]>({ reducer: unionIds, default: () => [] }),
  billingMode: Annotation<BillingMode | undefined>({
    reducer: (_a, b) => b,
    default: () => undefined,
  }),
  creditsCost: Annotation<number | undefined>({ reducer: (_a, b) => b, default: () => undefined }),
  status: Annotation<string>({ reducer: (_a, b) => b ?? "running", default: () => "running" }),
  error: Annotation<string | undefined>({ reducer: (a, b) => a ?? b, default: () => undefined }),
});

type SecState = typeof SecurityState.State;

async function indexNode(state: SecState): Promise<Partial<SecState>> {
  const input = state.input;
  try {
    const repoPath = input.repoPath;
    if (!repoPath) {
      if (input.auth && input.repo) {
        return {
          status: "failed",
          error: "clone not supported in M4: provide input.repoPath (clone is M7)",
        };
      }
      return {
        status: "failed",
        error: "index failed: missing repoPath (M4 scans local paths only; clone is M7)",
      };
    }
    const entries = await fs.readdir(repoPath, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name))
      .map((e) => e.name)
      .sort()
      .slice(0, 8);
    const scopes = dirs.length > 0 ? dirs : ["."];
    return { repoPath, scopes, status: "indexed" };
  } catch (e) {
    return { status: "failed", error: `index failed: ${errMsg(e)}` };
  }
}

async function snykNode(state: SecState): Promise<Partial<SecState>> {
  const repoPath = state.repoPath;
  if (!repoPath) return { error: "snyk failed: missing repoPath" };
  try {
    const snyk = await runSnykScan(repoPath);
    const findings: RawSecurityFinding[] = [
      ...(snyk.depFindings ?? []),
      ...(snyk.sastFindings ?? []),
    ];
    const source = snyk.source ?? "snyk";
    return {
      findings,
      snykResult: {
        source,
        raw: {
          source,
          ok: snyk.ok,
          dep: snyk.depFindings ?? [],
          sast: snyk.sastFindings ?? [],
          error: snyk.error ?? null,
        },
      },
    };
  } catch (e) {
    return { error: `snyk failed: ${errMsg(e)}` };
  }
}

async function secretsNode(state: SecState): Promise<Partial<SecState>> {
  const repoPath = state.repoPath;
  if (!repoPath) return {};
  try {
    const secrets = await runSecretScan(repoPath);
    return { secretFindings: secrets ?? [] };
  } catch (e) {
    return { error: `secrets failed: ${errMsg(e)}` };
  }
}

async function securityPlanNode(state: SecState): Promise<Partial<SecState>> {
  const input = state.input;
  const nodeModels = resolveSecurityNodeModels(input);
  const fallbackScopes = state.scopes ?? [];
  try {
    const fileList = state.repoPath ? (await listRepoFiles(state.repoPath)).slice(0, 200) : [];
    const system =
      'You are a security lead planning a whole-project security scan. Given the candidate scopes (top-level dirs) and the file tree, choose the scopes worth a deep AI security analysis (auth, payments, crypto, config, input handling, API surfaces). Respond with ONLY compact JSON: {"scopes":["dir","dir"]} — a subset of the candidate scopes, most security-relevant first.';
    const user = `Candidate scopes:\n${fallbackScopes.join("\n")}\n\nFile tree (truncated):\n${fileList.join("\n")}`;
    const { text, usage } = await callModel(nodeModels.orchestrator, input.orgId, system, user);
    const parsed = SecurityPlanSchema.safeParse(extractJson(text));
    const known = new Set(fallbackScopes);
    let scopes: string[];
    if (parsed.success && parsed.data.scopes.length > 0) {
      const filtered = parsed.data.scopes.filter((s) => known.has(s));
      scopes = filtered.length > 0 ? filtered : fallbackScopes;
    } else {
      scopes = fallbackScopes;
    }
    scopes = scopes.slice(0, envMaxSlices());
    if (scopes.length === 0) scopes = ["."];
    return { scopes, usage, modelIds: [nodeModels.orchestrator], status: "planned" };
  } catch {
    const scopes = fallbackScopes.length > 0 ? fallbackScopes.slice(0, envMaxSlices()) : ["."];
    return { scopes, status: "planned" };
  }
}

async function aiAnalystNode(state: SecState): Promise<Partial<SecState>> {
  const input = state.input;
  const scope = state.currentScope;
  if (!scope) return {};
  const nodeModels = resolveSecurityNodeModels(input);
  try {
    const snippets = await readScopeSnippets(state.repoPath, scope);
    const system =
      'You are an application security analyst. Analyze the source in the given scope for logic flaws and OWASP Top 10 issues that automated SAST/dep scanners miss (broken authz, injection, SSRF, insecure crypto, hard-coded secrets, unsafe deserialization, misconfigured headers). Report concrete findings anchored to real file/line when possible. Severity must be one of: critical, high, medium, low, nitpick. Respond with ONLY JSON: {"findings":[{"kind":"ai","severity":"critical|high|medium|low|nitpick","file":string,"line":number,"message":string,"rule":string}]}. If the scope is clean, return an empty findings array.';
    const user = `Project: ${input.projectId}\nScope: ${scope}\n\nSource (truncated):\n${snippets}`;
    const { text, usage } = await callModel(nodeModels.securityAnalyst, input.orgId, system, user);
    const parsed = AiFindingsOutputSchema.safeParse(extractJson(text));
    let aiFindings: RawSecurityFinding[] = [];
    if (parsed.success) {
      aiFindings = parsed.data.findings
        .map((f) => ({ ...f, kind: "ai" as const }))
        .filter((f) => Boolean(f.message));
    }
    return { aiFindings, usage, modelIds: [nodeModels.securityAnalyst] };
  } catch (e) {
    return { error: `ai failed for scope ${scope}: ${errMsg(e)}` };
  }
}

async function securitySynthesizeNode(state: SecState): Promise<Partial<SecState>> {
  const input = state.input;
  const nodeModels = resolveSecurityNodeModels(input);
  try {
    const merged = dedupeSecurityFindings([
      ...(state.findings ?? []),
      ...(state.secretFindings ?? []),
      ...(state.aiFindings ?? []),
    ]);
    const ranked = rankSecurityFindings(merged);
    const counts = countBySeverity(ranked);
    const fallback = buildSecurityFallbackSummary(counts, ranked);
    let summary = fallback;
    let usage = zeroUsage();
    let modelIds: string[] = [];
    try {
      const findingsText =
        ranked.length === 0
          ? "(no issues found)"
          : ranked.slice(0, 60).map(formatSecurityFinding).join("\n");
      const system =
        "You are a security lead writing a concise Markdown security report for engineering leadership. Include: a one-line 'Overall risk: Low|Medium|High|Critical' with rationale, a short '## Counts by severity' bullet list, and a '## Top concerns' bullet list of the most important findings (severity-ranked). Only reference the findings provided; do not invent new issues.";
      const user = `Severity counts: ${JSON.stringify(counts)}\n\nFindings (severity-ranked):\n${findingsText}`;
      const res = await callModel(nodeModels.summarizer, input.orgId, system, user);
      usage = res.usage;
      modelIds = [nodeModels.summarizer];
      if (res.text?.trim()) summary = res.text.trim();
    } catch {}
    return { findings: ranked, summary, usage, modelIds, status: "synthesized" };
  } catch (e) {
    return { status: "failed", error: `synthesize failed: ${errMsg(e)}` };
  }
}

async function persistSecurityReport(
  input: SecurityInput,
  status: "completed" | "failed",
  summary: string,
  billingMode: BillingMode,
  creditsCost: number,
  spendUsd: number,
  _modelIds: string[],
  findings: RawSecurityFinding[],
  snykRaw: unknown,
): Promise<string> {
  if (input.reportId) {
    const rid = input.reportId;
    await db
      .update(schema.securityReports)
      .set({
        status,
        summary,
        billingMode,
        creditsCost: creditsCost.toFixed(4),
        tokenSpendUsd: spendUsd.toFixed(4),
        snykRaw: snykRaw ?? null,
      })
      .where(eq(schema.securityReports.id, rid));
    await db.delete(schema.securityFindings).where(eq(schema.securityFindings.reportId, rid));
    if (findings.length > 0) {
      await db.insert(schema.securityFindings).values(findings.map(toSecurityFindingRow(rid)));
    }
    return rid;
  }

  const [row] = await db
    .insert(schema.securityReports)
    .values({
      projectId: input.projectId,
      profileId: input.profileId ?? null,
      status,
      summary,
      billingMode,
      creditsCost: creditsCost.toFixed(4),
      tokenSpendUsd: spendUsd.toFixed(4),
      snykRaw: snykRaw ?? null,
    })
    .returning({ id: schema.securityReports.id });
  const reportId = row?.id;
  if (reportId && findings.length > 0) {
    await db.insert(schema.securityFindings).values(findings.map(toSecurityFindingRow(reportId)));
  }
  return reportId ?? "";
}

async function securityReportNode(state: SecState): Promise<Partial<SecState>> {
  const input = state.input;
  const nodeModels = resolveSecurityNodeModels(input);
  try {
    const findings = state.findings ?? [];
    const scopeCount = (state.scopes ?? []).length;
    const orch = await resolvedOf(nodeModels.orchestrator, input.orgId);
    const analyst = await resolvedOf(nodeModels.securityAnalyst, input.orgId);
    const summ = await resolvedOf(nodeModels.summarizer, input.orgId);
    const billingMode = aggregateBilling([orch.billingMode, analyst.billingMode, summ.billingMode]);
    const failed = Boolean(state.error);
    const projected = failed
      ? 0
      : computeSecurityCost({
          orchestratorWeight: orch.weight,
          analystWeight: analyst.weight,
          scopeCount,
        });
    const creditsCost = billingMode === "byok" ? 0 : projected;
    const modelIds = Array.from(
      new Set([nodeModels.orchestrator, nodeModels.securityAnalyst, nodeModels.summarizer]),
    );
    const summary = state.summary ?? "";
    const status: "completed" | "failed" = failed ? "failed" : "completed";
    const spendUsd = state.usage?.spendUsd ?? 0;
    await persistSecurityReport(
      input,
      status,
      summary,
      billingMode,
      creditsCost,
      spendUsd,
      modelIds,
      findings,
      state.snykResult?.raw ?? null,
    );
    return { status, billingMode, creditsCost, modelIds };
  } catch (e) {
    return { status: "failed", error: `report failed: ${errMsg(e)}` };
  }
}

function indexRouter(state: SecState): string {
  return state.error ? "REPORT" : "PLAN";
}

function securityPlanFanOut(state: SecState): string | Send[] {
  if (state.error) return "SYNTHESIZE";
  const scopes = state.scopes ?? [];
  return [
    new Send("SNYK", { input: state.input, repoPath: state.repoPath }),
    new Send("SECRETS", { input: state.input, repoPath: state.repoPath }),
    ...scopes.map(
      (s) => new Send("AI", { input: state.input, repoPath: state.repoPath, currentScope: s }),
    ),
  ];
}

export async function createSecurityGraph(checkpointer?: PostgresSaver) {
  const saver = checkpointer ?? (await getDefaultSaver());
  const builder = new StateGraph(SecurityState)
    .addNode("INDEX", indexNode)
    .addNode("PLAN", securityPlanNode)
    .addNode("SNYK", snykNode)
    .addNode("SECRETS", secretsNode)
    .addNode("AI", aiAnalystNode)
    .addNode("SYNTHESIZE", securitySynthesizeNode)
    .addNode("REPORT", securityReportNode)
    .addEdge(START, "INDEX")
    .addConditionalEdges("INDEX", indexRouter)
    .addConditionalEdges("PLAN", securityPlanFanOut)
    .addEdge("SNYK", "SYNTHESIZE")
    .addEdge("SECRETS", "SYNTHESIZE")
    .addEdge("AI", "SYNTHESIZE")
    .addEdge("SYNTHESIZE", "REPORT")
    .addEdge("REPORT", END);
  return builder.compile({ checkpointer: saver });
}

function toSecurityResult(state: SecState): SecurityResult {
  const failed = state.status === "failed" || Boolean(state.error);
  return {
    status: failed ? "failed" : "completed",
    summary: state.summary ?? "",
    findings: state.findings ?? [],
    billingMode: state.billingMode ?? "hosted",
    creditsCost: state.creditsCost ?? 0,
    tokenSpendUsd: state.usage?.spendUsd ?? 0,
    modelIds: state.modelIds ?? [],
    snykSource: state.snykResult?.source ?? "",
    scopeCount: state.scopes?.length ?? 0,
    error: state.error,
  };
}

function failedSecurityResult(error: string): SecurityResult {
  return {
    status: "failed",
    summary: "",
    findings: [],
    billingMode: "hosted",
    creditsCost: 0,
    tokenSpendUsd: 0,
    modelIds: [],
    snykSource: "",
    scopeCount: 0,
    error,
  };
}

export async function runSecurity(input: SecurityInput): Promise<SecurityResult> {
  try {
    const graph = await createSecurityGraph();
    const threadId = `security-${input.projectId}-${Date.now()}`;
    const init: SecState = {
      input,
      repoPath: undefined,
      scopes: [],
      currentScope: undefined,
      snykResult: undefined,
      secretFindings: [],
      aiFindings: [],
      findings: [],
      summary: undefined,
      usage: zeroUsage(),
      modelIds: [],
      billingMode: undefined,
      creditsCost: undefined,
      status: "running",
      error: undefined,
    };
    const timeoutMs = Math.max(1000, env.SECURITY_SCAN_TIMEOUT_MS ?? 900000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SecState>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`security scan timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      const final = (await Promise.race([
        graph.invoke(init, {
          configurable: { thread_id: threadId },
          recursionLimit: 250,
        }),
        timeout,
      ])) as SecState;
      return toSecurityResult(final);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (e) {
    return failedSecurityResult(errMsg(e));
  }
}

export async function getSecurityGraphDescriptor(opts: {
  orgId?: string;
  nodeModels?: { orchestrator?: string; securityAnalyst?: string; summarizer?: string };
}): Promise<GraphDescriptor> {
  const orch = opts.nodeModels?.orchestrator ?? DEFAULT_NODE_MODELS.orchestrator;
  const analyst = opts.nodeModels?.securityAnalyst ?? DEFAULT_NODE_MODELS.securityAnalyst;
  const summ = opts.nodeModels?.summarizer ?? DEFAULT_NODE_MODELS.summarizer;
  const [plan, ai, synthesize] = await Promise.all([
    buildModelNode("PLAN", "Plan", "orchestrator", orch, opts.orgId),
    buildModelNode("AI", "AI Analyst", "securityAnalyst", analyst, opts.orgId),
    buildModelNode("SYNTHESIZE", "Synthesize", "summarizer", summ, opts.orgId),
  ]);
  const nodes: GraphNodeDescriptor[] = [
    { key: "INDEX", label: "Index", role: "fixed", modelBearing: false },
    plan,
    { key: "SNYK", label: "Snyk", role: "fixed", modelBearing: false },
    { key: "SECRETS", label: "Secrets", role: "fixed", modelBearing: false },
    ai,
    synthesize,
    { key: "REPORT", label: "Report", role: "fixed", modelBearing: false },
  ];
  const edges: GraphEdgeDescriptor[] = [
    { from: "INDEX", to: "PLAN", label: "ok", conditional: true },
    { from: "INDEX", to: "REPORT", label: "on error", conditional: true },
    { from: "PLAN", to: "SNYK", label: "fan-out", conditional: true },
    { from: "PLAN", to: "SECRETS", conditional: true },
    { from: "PLAN", to: "AI", label: "per scope", conditional: true },
    { from: "SNYK", to: "SYNTHESIZE", label: "join" },
    { from: "SECRETS", to: "SYNTHESIZE", label: "join" },
    { from: "AI", to: "SYNTHESIZE", label: "join" },
    { from: "SYNTHESIZE", to: "REPORT" },
  ];
  return { graphType: "security", nodes, edges };
}
