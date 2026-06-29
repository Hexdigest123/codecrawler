import { createHash, randomBytes, randomUUID } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { NodeModels, ReviewInput } from "@codecrawler/agents";
import { getReviewGraphDescriptor } from "@codecrawler/agents";
import { fetchModelCatalog, verifyByokKey } from "@codecrawler/ai";
import { auth } from "@codecrawler/auth";
import {
  cancelSubscription,
  createMollieClient,
  MOLLIE_PLANS,
  recoverSubscription,
  startCheckout,
  syncPayment,
} from "@codecrawler/billing";
import { client, db, schema } from "@codecrawler/db";
import { enqueueEmail } from "@codecrawler/email";
import { makeQueue, QUEUE_NAMES } from "@codecrawler/queue";
import { checkQuota, getTeamPlan, getUsage, projectReviewCost } from "@codecrawler/quotas";
import {
  DEFAULT_COVERAGE_STRATEGY,
  DEFAULT_NODE_MODELS,
  type DepthTier,
  decryptSecret,
  encryptSecret,
  env,
  getPlanLimits,
  type PlanId,
  planRank,
  resolveDepthFromMode,
} from "@codecrawler/shared";
import type { VcsAuth } from "@codecrawler/vcs";
import {
  getVcsProvider,
  verifyGiteaWebhook,
  verifyGitHubWebhook,
  verifyGitlabWebhook,
} from "@codecrawler/vcs";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, inArray, isNull, ne, sql, sum } from "drizzle-orm";
import type { Context } from "hono";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

const PROVIDER_VALUES = [
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "xai",
  "zai",
  "kimi",
  "mistral",
  "nvidia",
  "minimax",
  "qwen",
  "deepseek",
  "saia",
] as const;

const COVERAGE_VALUES = ["by_commit", "by_filegroup", "full"] as const;

type SessionUser = { id: string; email: string; name: string };
type SessionInfo = {
  session: { id: string; userId: string; expiresAt: Date };
  user: SessionUser;
};

class ApiError extends Error {
  status: ContentfulStatusCode;
  code: string;
  constructor(status: ContentfulStatusCode, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

function jsonError(c: Context, status: ContentfulStatusCode, code: string, message?: string) {
  return c.json({ error: { code, message: message ?? code } }, status);
}

async function getSession(c: Context): Promise<SessionInfo | null> {
  const r = await auth.api.getSession({ headers: c.req.raw.headers });
  return r as unknown as SessionInfo | null;
}

async function requireSession(c: Context): Promise<SessionUser> {
  const s = await getSession(c);
  if (!s) {
    throw new ApiError(401, "unauthorized", "Authentication required");
  }
  return s.user;
}

async function requireOrgAccess(_c: Context, orgId: string, userId: string): Promise<void> {
  const rows = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
    .limit(1);
  if (!rows.length) {
    throw new ApiError(403, "forbidden", "Not a member of this team");
  }
}

async function getTeamSubscription(orgId: string) {
  const rows = await db
    .select()
    .from(schema.teamSubscriptions)
    .where(eq(schema.teamSubscriptions.orgId, orgId))
    .limit(1);
  return rows[0] ?? null;
}

async function requirePlan(_c: Context, orgId: string, minPlan: "plus" | "pro"): Promise<void> {
  const sub = await getTeamSubscription(orgId);
  const plan: PlanId = sub?.plan ?? "free";
  if (planRank(plan) < planRank(minPlan)) {
    throw new ApiError(403, "plan_required", `Requires ${minPlan} or higher`);
  }
}

async function audit(
  orgId: string | null,
  actorUserId: string | null,
  action: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({ orgId, actorUserId, action, metadata });
  } catch (err) {
    console.warn("[api] audit write failed", err);
  }
}

async function requireOrgAdmin(_c: Context, orgId: string, userId: string): Promise<void> {
  const rows = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
    .limit(1);
  if (!rows.length) {
    throw new ApiError(403, "forbidden", "Not a member of this team");
  }
  const role = rows[0].role;
  if (role !== "owner" && role !== "admin") {
    throw new ApiError(403, "forbidden", "Only owners or admins can perform this action");
  }
}

async function getOrgPlan(orgId: string): Promise<PlanId> {
  const sub = await getTeamSubscription(orgId);
  return (sub?.plan ?? "free") as PlanId;
}

async function isAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: schema.user.role })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return row?.role === "admin";
}

async function requireAdmin(c: Context): Promise<SessionUser> {
  const user = c.get("user");
  if (!(await isAdmin(user.id))) {
    throw new ApiError(403, "admin_required", "Administrator access required");
  }
  return user;
}

const requireAdminMiddleware: MiddlewareHandler = async (c, next) => {
  await requireAdmin(c);
  await next();
};

async function getAppSettings() {
  const [row] = await db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.id, "singleton"))
    .limit(1);
  if (row) {
    return row;
  }
  // Bootstraps the singleton if missing (e.g. migration ran before seed).
  const [created] = await db
    .insert(schema.appSettings)
    .values({ id: "singleton" })
    .onConflictDoNothing({ target: schema.appSettings.id })
    .returning();
  return (
    created ?? {
      id: "singleton",
      signupMode: "open",
      allowedDomains: [],
      paymentsEnabled: true,
      updatedAt: new Date(),
    }
  );
}

async function getAdminEmails(): Promise<string[]> {
  const rows = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.role, "admin"));
  return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
}

async function getTeamName(orgId: string): Promise<string> {
  const [org] = await db
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .limit(1);
  return org?.name ?? "";
}

async function getUserEmail(userId: string): Promise<string | null> {
  const [u] = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return u?.email ?? null;
}

async function getOrgOwnerEmails(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")));
  return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
}

async function countUserMemberships(userId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(eq(schema.member.userId, userId));
  return rows.length;
}

async function getUserHighestOwnedPlan(userId: string): Promise<PlanId> {
  const rows = await db
    .select({ role: schema.member.role, plan: schema.teamSubscriptions.plan })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .leftJoin(schema.teamSubscriptions, eq(schema.organization.id, schema.teamSubscriptions.orgId))
    .where(and(eq(schema.member.userId, userId), inArray(schema.member.role, ["owner", "admin"])));
  let best: PlanId = "free";
  for (const r of rows) {
    const p = (r.plan ?? "free") as PlanId;
    if (planRank(p) > planRank(best)) best = p;
  }
  return best;
}

async function hasValidByokKey(orgId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.orgId, orgId), eq(schema.apiKeys.status, "valid")))
    .limit(1);
  return rows.length > 0;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function isPublicApiPath(path: string): boolean {
  if (path === "/api/health" || path === "/api/healthz") return true;
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return true;
  if (path === "/api/webhooks" || path.startsWith("/api/webhooks/")) return true;
  if (path === "/api/payments" || path.startsWith("/api/payments/")) return true;
  if (path === "/api/sso/resolve") return true;
  if (path === "/api/signup-config") return true;
  // Internal endpoints are authenticated via a shared secret header instead
  // of a user session (called by the worker's poll scheduler).
  if (path === "/api/internal" || path.startsWith("/api/internal/")) return true;
  return false;
}

const RATE_LIMIT_AUTH_PER_MIN = Math.max(1, Number(process.env.RATE_LIMIT_AUTH_PER_MIN) || 20);
const RATE_LIMIT_WEBHOOK_PER_MIN = Math.max(
  1,
  Number(process.env.RATE_LIMIT_WEBHOOK_PER_MIN) || 600,
);
const RATE_LIMIT_HEALTH_PER_MIN = Math.max(1, Number(process.env.RATE_LIMIT_HEALTH_PER_MIN) || 300);
const RATE_LIMIT_API_PER_MIN = Math.max(1, Number(process.env.RATE_LIMIT_API_PER_MIN) || 300);
const RATE_LIMIT_WINDOW_MS = 60_000;
const WEBHOOK_DEDUP_TTL_MS = Math.max(
  60_000,
  Number(process.env.WEBHOOK_DEDUP_TTL_MS) || 3_600_000,
);
const HEALTH_CHECK_TIMEOUT_MS = Math.max(100, Number(process.env.HEALTH_CHECK_TIMEOUT_MS) || 2000);

type RouteClass = "auth" | "webhook" | "health" | "api";

type RateLimitBucket = { hits: number[] };

const ROUTE_CLASS_LIMITS: Record<RouteClass, number> = {
  auth: RATE_LIMIT_AUTH_PER_MIN,
  webhook: RATE_LIMIT_WEBHOOK_PER_MIN,
  health: RATE_LIMIT_HEALTH_PER_MIN,
  api: RATE_LIMIT_API_PER_MIN,
};

const rateLimitBuckets = new Map<string, RateLimitBucket>();
const webhookEventStore = new Map<string, number>();

function classifyRoute(method: string, path: string): RouteClass {
  if (path === "/api/health" || path === "/api/healthz") return "health";
  const isAuthPath = path === "/api/auth" || path.startsWith("/api/auth/");
  if (isAuthPath) {
    // GET auth reads (e.g. get-session) are polled on every navigation and are
    // not brute-force targets — bucket them with the general API limit. POST
    // auth (sign-in / sign-up) stays on the strict auth limit.
    if (method === "GET") return "api";
    return "auth";
  }
  if (path === "/api/webhooks" || path.startsWith("/api/webhooks/")) return "webhook";
  if (path === "/api/payments/webhook") return "webhook";
  if (path === "/api/internal" || path.startsWith("/api/internal/")) return "webhook";
  return "api";
}

function getClientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0];
    if (first) return first.trim();
  }
  const xri = c.req.header("x-real-ip");
  if (xri) return xri.trim();
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf.trim();
  return "unknown";
}

export function checkRateLimit(
  bucketKey: string,
  limit: number,
  now: number = Date.now(),
): { allowed: boolean; retryAfter: number } {
  let bucket = rateLimitBuckets.get(bucketKey);
  if (!bucket) {
    bucket = { hits: [] };
    rateLimitBuckets.set(bucketKey, bucket);
  }
  bucket.hits = bucket.hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0] ?? now;
    const retryAfter = Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfter };
  }
  bucket.hits.push(now);
  return { allowed: true, retryAfter: 0 };
}

export const rateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return next();
  }
  const routeClass = classifyRoute(c.req.method, c.req.path);
  const limit = ROUTE_CLASS_LIMITS[routeClass];
  const decision = checkRateLimit(`${routeClass}:${getClientIp(c)}`, limit);
  if (!decision.allowed) {
    c.header("Retry-After", String(decision.retryAfter));
    return c.json({ error: { code: "rate_limited", message: "Too many requests" } }, 429);
  }
  return next();
};

export function checkWebhookDuplicate(
  provider: string,
  eventId: string,
  now: number = Date.now(),
): boolean {
  if (!eventId) return false;
  const key = `${provider}:${eventId}`;
  const expiresAt = webhookEventStore.get(key);
  if (expiresAt !== undefined && expiresAt > now) {
    return true;
  }
  webhookEventStore.set(key, now + WEBHOOK_DEDUP_TTL_MS);
  return false;
}

export function webhookDedupKey(provider: string, eventId: string): string {
  return `${provider}:${eventId}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    bucket.hits = bucket.hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (bucket.hits.length === 0) {
      rateLimitBuckets.delete(key);
    }
  }
  for (const [key, expiresAt] of webhookEventStore) {
    if (expiresAt <= now) {
      webhookEventStore.delete(key);
    }
  }
}, 60_000).unref();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function pingDb(): Promise<"ok" | "fail"> {
  try {
    const res = await withTimeout(client`SELECT 1`, HEALTH_CHECK_TIMEOUT_MS);
    return Array.isArray(res) && res.length > 0 ? "ok" : "fail";
  } catch {
    return "fail";
  }
}

function pingRedis(): Promise<"ok" | "fail"> {
  return new Promise<"ok" | "fail">((resolve) => {
    let settled = false;
    let socket: Socket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: "ok" | "fail") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (socket) {
        try {
          socket.destroy();
        } catch {
          // socket already closed
        }
      }
      resolve(result);
    };

    let url: URL;
    try {
      url = new URL(env.REDIS_URL);
    } catch {
      resolve("fail");
      return;
    }
    const useTls = url.protocol === "rediss:";
    const port = url.port ? Number(url.port) : 6379;
    const hostname = url.hostname;
    const password = url.password ? decodeURIComponent(url.password) : "";
    const username = url.username ? decodeURIComponent(url.username) : "";

    const sock = useTls
      ? tlsConnect({ port, host: hostname, servername: hostname })
      : netConnect({ port, host: hostname });
    socket = sock;
    timer = setTimeout(() => finish("fail"), HEALTH_CHECK_TIMEOUT_MS);

    let phase: "auth" | "ping" = password ? "auth" : "ping";
    let buffer = "";

    sock.on("connect", () => {
      if (phase === "auth") {
        sock.write(`AUTH ${username || "default"} ${password}\r\n`);
      } else {
        sock.write("PING\r\n");
      }
    });

    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (phase === "auth") {
        if (buffer.includes("+")) {
          phase = "ping";
          buffer = "";
          sock.write("PING\r\n");
        } else if (buffer.includes("-")) {
          finish("fail");
        }
        return;
      }
      if (buffer.includes("+PONG")) {
        finish("ok");
      } else if (buffer.includes("-")) {
        finish("fail");
      }
    });

    sock.on("error", () => finish("fail"));
  });
}

const createTeamSchema = z.object({
  name: z.string().min(1),
});

const createProjectSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(["github", "gitlab", "gitea"]),
  repoFullName: z.string().min(1),
  webhookSecret: z.string().optional(),
  pollingEnabled: z.boolean().optional(),
});

const createApiKeySchema = z.object({
  provider: z.enum(PROVIDER_VALUES),
  label: z.string().min(1),
  key: z.string().min(1),
});

const putAgentProfileSchema = z.object({
  nodeModels: z.record(z.string(), z.string()).optional(),
  coverageStrategy: z.enum(COVERAGE_VALUES).optional(),
  defaultDepth: z.enum(["static", "quick", "deep"]).optional(),
});

const putGraphNodeSchema = z.object({
  modelId: z.string().min(1),
});

const vcsConnectSchema = z.object({
  orgId: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  token: z.string().min(1),
});

const triggerReviewSchema = z.object({
  repoPath: z.string().min(1).optional(),
  depth: z.enum(["static", "quick", "deep"]).optional(),
  synthetic: z
    .object({
      pr: z.unknown(),
      diff: z.unknown(),
    })
    .optional(),
});

const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["member", "admin"]),
});

const updateMemberRoleSchema = z.object({
  role: z.enum(["member", "admin", "owner"]),
});

const samlConfigSchema = z.object({
  entryURL: z.string().url(),
  certificate: z.string().min(1),
  entityId: z.string().min(1),
});

const oidcConfigSchema = z.object({
  clientId: z.string().min(1),
  issuerUrl: z.string().url(),
});

const upsertSsoSchema = z.object({
  domain: z.string().min(1),
  providerId: z.enum(["saml", "oidc"]),
  config: z.record(z.string(), z.unknown()),
});

const resolveSsoSchema = z.object({
  email: z.string().email(),
});

const checkoutSchema = z.object({
  plan: z.enum(["plus", "pro"]),
});

const changePasswordSchema = z.object({
  newPassword: z.string().min(8),
  currentPassword: z.string().min(1),
});

const changeEmailSchema = z.object({
  newEmail: z.string().email(),
});

const BILLING_PLAN_CATALOG = [
  {
    id: "free" as const,
    label: "Free",
    priceEur: 0,
    features: [
      "BYOK exclusively — bring your own API keys",
      "Unlimited reviews via BYOK",
      "3 teams",
      "5 members / team",
    ],
  },
  {
    id: "plus" as const,
    label: "Plus",
    priceEur: 29,
    features: ["50 hosted reviews / day", "Hosted + BYOK", "Unlimited teams", "5 members / team"],
  },
  {
    id: "pro" as const,
    label: "Pro",
    priceEur: 99,
    features: [
      "Unlimited hosted reviews",
      "Custom SSO",
      "Any model weight",
      "Unlimited teams & members",
    ],
  },
];

type ReviewJobData = ReviewInput & {
  triggerEmail?: string;
};

function extractNodeModels(raw: unknown): NodeModels {
  const obj = (raw as Record<string, unknown> | null) ?? {};
  return {
    orchestrator:
      typeof obj.orchestrator === "string" ? obj.orchestrator : DEFAULT_NODE_MODELS.orchestrator,
    reviewer: typeof obj.reviewer === "string" ? obj.reviewer : DEFAULT_NODE_MODELS.reviewer,
    summarizer:
      typeof obj.summarizer === "string" ? obj.summarizer : DEFAULT_NODE_MODELS.summarizer,
  };
}

async function resolveOrgProfile(orgId: string, graphType: "pr_review") {
  const rows = await db
    .select()
    .from(schema.agentProfiles)
    .where(
      and(
        eq(schema.agentProfiles.orgId, orgId),
        eq(schema.agentProfiles.graphType, graphType),
        isNull(schema.agentProfiles.projectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Pick the depth tier for a run, honouring an explicit request (a `/codecrawler
 * deep` comment or the manual-trigger body) over the team's agent-profile
 * default, then the global REVIEW_AGENT_MODE. Always funnelled through
 * {@link resolveDepthFromMode} so an "off" global mode forces the static path.
 */
function pickDepthTier(requested?: DepthTier | null, profileDefault?: DepthTier | null): DepthTier {
  if (requested === "static" || requested === "quick" || requested === "deep") {
    return resolveDepthFromMode(requested);
  }
  if (profileDefault === "static" || profileDefault === "quick" || profileDefault === "deep") {
    return resolveDepthFromMode(profileDefault);
  }
  return resolveDepthFromMode();
}

/**
 * Resolve the run's final depth tier + which queue it belongs on. Deep reviews
 * require Plus/Pro; webhook/comment triggers can't return a 402, so an
 * ineligible deep request silently downgrades to quick (the manual endpoint
 * gates explicitly before calling this). Deep runs land on a dedicated
 * `reviews:deep` queue so the long agent loops can't starve quick reviews.
 */
async function resolveEnqueueDepth(
  orgId: string,
  requested?: DepthTier | null,
  profileDefault?: DepthTier | null,
): Promise<{ depth: DepthTier; queueName: string }> {
  let depth = pickDepthTier(requested, profileDefault);
  if (depth === "deep") {
    const plan = await getTeamPlan(orgId);
    if (planRank(plan) < planRank("plus")) {
      depth = "quick";
    }
  }
  const queueName = depth === "deep" ? QUEUE_NAMES.reviewsDeep : QUEUE_NAMES.reviews;
  return { depth, queueName };
}

async function enqueueVcsReview(
  provider: "gitlab" | "gitea",
  repoFullName: string,
  prNumber: number,
  prMeta?: {
    title?: string | null;
    author?: string | null;
    state?: string | null;
  },
): Promise<void> {
  if (!repoFullName || !prNumber) return;
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.repoFullName, repoFullName))
    .limit(1);
  if (!project) return;
  const profile = await resolveOrgProfile(project.orgId, "pr_review");
  await upsertPullAndEnqueueReview({
    orgId: project.orgId,
    projectId: project.id,
    prNumber,
    repoFullName,
    profile,
    provider,
    source: "webhook",
    prMeta,
  });
}

async function getStoredVcsConnection(
  orgId: string,
  provider: "github" | "gitlab" | "gitea",
): Promise<{
  token: string;
  baseUrl: string | null;
} | null> {
  const rows = await db
    .select({
      accessToken: schema.vcsConnections.accessToken,
      baseUrl: schema.vcsConnections.baseUrl,
    })
    .from(schema.vcsConnections)
    .where(
      and(eq(schema.vcsConnections.orgId, orgId), eq(schema.vcsConnections.provider, provider)),
    )
    .orderBy(desc(schema.vcsConnections.createdAt))
    .limit(1);
  const conn = rows[0];
  if (!conn?.accessToken) return null;
  try {
    return {
      token: decryptSecret(conn.accessToken),
      baseUrl: conn.baseUrl ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve VCS auth for a review from the team's stored PAT/OAuth connection
 * (fallback to GH_TEST_PAT for GitHub local dev). Returns null when no
 * credentials are configured — callers reject the run with a clear error.
 */
async function resolveReviewAuth(opts: {
  provider: "github" | "gitlab" | "gitea";
  orgId: string;
  owner: string;
  name: string;
  synthetic?: boolean;
}): Promise<VcsAuth | null> {
  if (opts.synthetic) return null;

  const stored = await getStoredVcsConnection(opts.orgId, opts.provider);
  if (stored) {
    return {
      provider: opts.provider,
      token: stored.token,
      baseUrl: stored.baseUrl ?? undefined,
    };
  }

  // Dev escape hatch: a personal access token in .env for trying the GitHub
  // adapter before a team has connected a PAT. Never set in production.
  if (opts.provider === "github" && process.env.GH_TEST_PAT) {
    return { provider: "github", token: process.env.GH_TEST_PAT };
  }
  return null;
}

/** Best-effort PR metadata prefetch so the pull_requests row is populated
 * before the worker even starts. Falls back to opts.prMeta on any failure. */
async function prefetchPrMeta(opts: {
  auth: VcsAuth | null;
  owner: string;
  name: string;
  prNumber: number;
  fallback?: {
    title?: string | null;
    author?: string | null;
    baseSha?: string | null;
    headSha?: string | null;
    state?: string | null;
    htmlUrl?: string | null;
  };
}): Promise<{
  title: string | null;
  author: string | null;
  baseSha: string | null;
  headSha: string | null;
  state: string | null;
  htmlUrl: string | null;
}> {
  const empty = {
    title: opts.fallback?.title ?? null,
    author: opts.fallback?.author ?? null,
    baseSha: opts.fallback?.baseSha ?? null,
    headSha: opts.fallback?.headSha ?? null,
    state: opts.fallback?.state ?? null,
    htmlUrl: opts.fallback?.htmlUrl ?? null,
  };
  if (!opts.auth) return empty;
  try {
    const vcs = await getVcsProvider(opts.auth);
    const pr = await vcs.getPullRequest(opts.owner, opts.name, opts.prNumber);
    return {
      title: pr.title ?? empty.title,
      author: pr.author ?? empty.author,
      baseSha: pr.baseSha || empty.baseSha,
      headSha: pr.headSha || empty.headSha,
      state: pr.state ?? empty.state,
      htmlUrl: pr.htmlUrl || empty.htmlUrl,
    };
  } catch (err) {
    console.warn("[api] prefetchPrMeta failed (worker will retry at ingest)", err);
    return empty;
  }
}

async function upsertPullAndEnqueueReview(opts: {
  orgId: string;
  projectId: string;
  prNumber: number;
  repoFullName: string;
  profile: {
    id?: string;
    nodeModels: unknown;
    coverageStrategy: string | null;
    defaultDepth?: DepthTier | null;
  } | null;
  prMeta?: {
    title?: string | null;
    author?: string | null;
    baseSha?: string | null;
    headSha?: string | null;
    state?: string | null;
    htmlUrl?: string | null;
  };
  syntheticPr?: { pr?: unknown; diff?: unknown };
  repoPath?: string;
  triggerUserId?: string;
  triggerEmail?: string;
  provider?: "github" | "gitlab" | "gitea";
  source?: "webhook" | "manual" | "synthetic" | "comment" | "poll";
  depth?: DepthTier | null;
}): Promise<string> {
  const provider = opts.provider ?? "github";
  const [owner, ...rest] = opts.repoFullName.split("/");
  const name = rest.join("/") || "";
  const nodeModels = extractNodeModels(opts.profile?.nodeModels);
  const coverageStrategy = (opts.profile?.coverageStrategy ?? DEFAULT_COVERAGE_STRATEGY) as
    | "by_commit"
    | "by_filegroup"
    | "full";

  const source: "webhook" | "manual" | "synthetic" | "comment" | "poll" =
    opts.source ?? (opts.syntheticPr ? "synthetic" : "manual");

  // Resolve the depth tier + target queue (deep → dedicated reviews:deep queue,
  // plan-gated to Plus/Pro). Synthetic runs stay on the static path so local
  // synthetic smoke tests never touch paid queues.
  const { depth: resolvedDepth, queueName } = opts.syntheticPr
    ? { depth: "static" as DepthTier, queueName: QUEUE_NAMES.reviews }
    : await resolveEnqueueDepth(opts.orgId, opts.depth ?? null, opts.profile?.defaultDepth ?? null);

  // Resolve VCS auth from the team's stored connection (or GH_TEST_PAT for
  // GitHub local dev).
  const auth = await resolveReviewAuth({
    provider,
    orgId: opts.orgId,
    owner,
    name,
    synthetic: Boolean(opts.syntheticPr),
  });

  // Non-synthetic runs MUST have auth — otherwise the worker can't fetch the
  // diff. Reject early with a clear error instead of letting INGEST fail.
  if (!opts.syntheticPr && !auth) {
    throw new ApiError(
      401,
      "vcs_not_authorized",
      `No stored VCS connection for ${opts.orgId}. Connect a token in team settings.`,
    );
  }

  // Best-effort metadata prefetch.
  const meta = await prefetchPrMeta({
    auth,
    owner,
    name,
    prNumber: opts.prNumber,
    fallback: opts.prMeta,
  });

  let pr = await db
    .select()
    .from(schema.pullRequests)
    .where(
      and(
        eq(schema.pullRequests.projectId, opts.projectId),
        eq(schema.pullRequests.externalNumber, opts.prNumber),
      ),
    )
    .limit(1);
  if (!pr.length) {
    const [inserted] = await db
      .insert(schema.pullRequests)
      .values({
        projectId: opts.projectId,
        externalNumber: opts.prNumber,
        title: meta.title,
        author: meta.author,
        baseSha: meta.baseSha,
        headSha: meta.headSha,
        state: meta.state,
        htmlUrl: meta.htmlUrl,
      })
      .returning();
    pr = [inserted];
  } else {
    // Back-fill metadata for a re-review (e.g. PR was created by an earlier
    // run with no auth, now we have it).
    await db
      .update(schema.pullRequests)
      .set({
        title: meta.title ?? pr[0].title,
        author: meta.author ?? pr[0].author,
        baseSha: meta.baseSha ?? pr[0].baseSha,
        headSha: meta.headSha ?? pr[0].headSha,
        state: meta.state ?? pr[0].state,
        htmlUrl: meta.htmlUrl ?? pr[0].htmlUrl,
      })
      .where(eq(schema.pullRequests.id, pr[0].id));
  }

  const [review] = await db
    .insert(schema.reviews)
    .values({
      prId: pr[0].id,
      projectId: opts.projectId,
      profileId: opts.profile?.id ?? null,
      status: "running",
      billingMode: "hosted",
      depth: resolvedDepth,
      source,
    })
    .returning();

  const jobData: ReviewJobData = {
    orgId: opts.orgId,
    projectId: opts.projectId,
    prNumber: opts.prNumber,
    repo: { owner: owner ?? "", name },
    nodeModels,
    auth: auth ?? undefined,
    repoPath: opts.repoPath,
    coverageStrategy,
    depth: resolvedDepth,
    reviewId: review.id,
    profileId: opts.profile?.id,
    triggerUserId: opts.triggerUserId,
    triggerEmail: opts.triggerEmail,
    source,
    ...(opts.syntheticPr ? { syntheticPr: opts.syntheticPr as never } : {}),
  };

  const queue = makeQueue(queueName);
  await queue.add(resolvedDepth === "deep" ? "review:deep" : "review", jobData);
  await queue.close().catch(() => undefined);

  return review.id;
}

// ---------------------------------------------------------------------------
// PR polling tick
//
// The worker's scheduler calls POST /api/internal/poll on a cron (default
// every 5 min). For each project with pollingEnabled=true that has a stored
// VCS connection, we list open PRs and enqueue a review for any whose head
// sha hasn't been reviewed yet (or has new commits since the last review).
// This is an alternative to inbound webhooks — useful for self-hosted VCS
// behind a firewall or when configuring webhooks isn't possible.
// ---------------------------------------------------------------------------

/**
 * Check whether a PR has already been reviewed (or is currently being
 * reviewed) at this exact head sha. Returns true when a matching review
 * exists, so the caller can skip re-enqueuing.
 */
async function isPullReviewedAtSha(
  projectId: string,
  prNumber: number,
  headSha: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.reviews.id })
    .from(schema.reviews)
    .innerJoin(schema.pullRequests, eq(schema.reviews.prId, schema.pullRequests.id))
    .where(
      and(
        eq(schema.pullRequests.projectId, projectId),
        eq(schema.pullRequests.externalNumber, prNumber),
        eq(schema.pullRequests.headSha, headSha),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function pollPullRequestsTick(): Promise<{
  projects: number;
  enqueued: number;
  skipped: number;
  errors: number;
}> {
  const projectRows = await db
    .select({
      id: schema.projects.id,
      orgId: schema.projects.orgId,
      name: schema.projects.name,
      provider: schema.projects.provider,
      repoFullName: schema.projects.repoFullName,
    })
    .from(schema.projects)
    .where(eq(schema.projects.pollingEnabled, true))
    .limit(Math.max(1, env.PR_POLL_MAX_PROJECTS));

  const perPage = Math.max(1, Math.min(100, env.PR_POLL_PER_PAGE));
  let enqueued = 0;
  let skipped = 0;
  let errors = 0;

  for (const project of projectRows) {
    const provider = (project.provider as "github" | "gitlab" | "gitea" | null) ?? "github";
    const repoFullName = project.repoFullName ?? "";
    const [owner, ...rest] = repoFullName.split("/");
    const repoName = rest.join("/");
    if (!owner || !repoName) {
      continue;
    }
    const stored = await getStoredVcsConnection(project.orgId, provider);
    if (!stored) {
      // Polling is enabled but no PAT is connected — nothing we can do.
      continue;
    }
    try {
      const vcs = await getVcsProvider({
        provider,
        token: stored.token,
        baseUrl: stored.baseUrl ?? undefined,
      });
      const pullRequests = await vcs.listPullRequests(owner, repoName, {
        state: "open",
        perPage,
      });
      const profile = await resolveOrgProfile(project.orgId, "pr_review");
      for (const pr of pullRequests) {
        if (!pr.headSha) {
          continue;
        }
        const seen = await isPullReviewedAtSha(project.id, pr.number, pr.headSha);
        if (seen) {
          skipped++;
          continue;
        }
        try {
          await upsertPullAndEnqueueReview({
            orgId: project.orgId,
            projectId: project.id,
            prNumber: pr.number,
            repoFullName,
            profile,
            provider,
            source: "poll",
            prMeta: {
              title: pr.title,
              author: pr.author,
              headSha: pr.headSha,
              baseSha: pr.baseSha,
              state: pr.state,
              htmlUrl: pr.htmlUrl,
            },
          });
          enqueued++;
        } catch (err) {
          errors++;
          console.warn(
            `[api] poll: enqueue failed for ${repoFullName}#${pr.number}`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      errors++;
      console.warn(
        `[api] poll: list PRs failed for ${repoFullName}`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { projects: projectRows.length, enqueued, skipped, errors };
}

const app = new Hono<{ Variables: { user: SessionUser } }>();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["set-cookie"],
  }),
);

app.use("*", rateLimitMiddleware);

app.get("/api/health", async (c) => {
  const [dbStatus, redisStatus] = await Promise.all([pingDb(), pingRedis()]);
  const status = dbStatus === "ok" && redisStatus === "ok" ? "ok" : "degraded";
  return c.json({ status, ts: Date.now(), db: dbStatus, redis: redisStatus });
});

app.get("/api/healthz", (c) => c.json({ status: "ok" }));

app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

app.post("/api/webhooks/github", async (c) => {
  const rawBody = await c.req.text();
  const secret = process.env.GH_WEBHOOK_SECRET ?? "";
  if (!secret) {
    console.warn("[api] webhook secret not configured");
    return c.json({ status: "ignored", reason: "webhook secret not configured" });
  }
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const event = await verifyGitHubWebhook(secret, headers, rawBody);
  if (!event) {
    return jsonError(c, 401, "unauthorized", "Invalid webhook signature");
  }

  const ghDelivery = c.req.header("x-github-delivery") ?? "";
  if (ghDelivery && checkWebhookDuplicate("github", ghDelivery)) {
    return c.json({ status: "duplicate" });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody || "{}") as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const ghEvent = c.req.header("x-github-event") ?? "";
  const action = typeof payload.action === "string" ? payload.action : "";
  const repository = (payload.repository as { full_name?: string } | undefined) ?? undefined;
  const repoFullName = repository?.full_name ?? "";

  const enqueueForRepo = async (
    prNumber: number,
    prMeta?: {
      title?: string | null;
      author?: string | null;
      baseSha?: string | null;
      headSha?: string | null;
      state?: string | null;
      htmlUrl?: string | null;
    },
    opts: { depth?: DepthTier; source?: "webhook" | "comment" } = {},
  ) => {
    if (!repoFullName || !prNumber) {
      return;
    }
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.repoFullName, repoFullName))
      .limit(1);
    if (!project) {
      return;
    }
    const profile = await resolveOrgProfile(project.orgId, "pr_review");
    await upsertPullAndEnqueueReview({
      orgId: project.orgId,
      projectId: project.id,
      prNumber,
      repoFullName,
      profile,
      provider: "github",
      source: opts.source ?? "webhook",
      depth: opts.depth,
      prMeta,
    });
  };

  if (ghEvent === "pull_request" && ["opened", "synchronize", "reopened"].includes(action)) {
    const pr = payload.pull_request as
      | {
          number?: number;
          title?: string;
          html_url?: string;
          user?: { login?: string };
          base?: { sha?: string };
          head?: { sha?: string };
          state?: string;
        }
      | undefined;
    const n = typeof payload.number === "number" ? payload.number : pr?.number;
    if (typeof n === "number") {
      await enqueueForRepo(n, {
        title: pr?.title ?? null,
        author: pr?.user?.login ?? null,
        baseSha: pr?.base?.sha ?? null,
        headSha: pr?.head?.sha ?? null,
        state: pr?.state ?? null,
        htmlUrl: pr?.html_url ?? null,
      });
    }
  } else if (ghEvent === "issue_comment") {
    const comment = payload.comment as { body?: string } | undefined;
    const bodyText = typeof comment?.body === "string" ? comment.body.trim() : "";
    if (bodyText.startsWith("/codecrawler")) {
      const issue = payload.issue as { number?: number; pull_request?: unknown } | undefined;
      const n = typeof issue?.number === "number" ? issue.number : undefined;
      // `/codecrawler deep` opts the PR into the deep agent tier (Plus/Pro
      // only, gated at enqueue). Plain `/codecrawler` runs the default tier.
      const wantsDeep = /\bdeep\b/i.test(bodyText);
      if (typeof n === "number" && issue?.pull_request) {
        await enqueueForRepo(n, undefined, {
          source: "comment",
          depth: wantsDeep ? "deep" : undefined,
        });
      }
    }
  }

  return c.json({ status: "ok" });
});

app.post("/api/webhooks/gitlab", async (c) => {
  const rawBody = await c.req.text();
  const secret = process.env.GITLAB_WEBHOOK_SECRET ?? "";
  if (!secret) {
    console.warn("[api] gitlab webhook secret not configured");
    return c.json({ status: "ignored", reason: "webhook secret not configured" });
  }
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const event = await verifyGitlabWebhook(secret, headers, rawBody);
  if (!event) {
    return jsonError(c, 401, "unauthorized", "Invalid webhook signature");
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody || "{}") as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const objectKind = typeof payload.object_kind === "string" ? payload.object_kind : "";
  const attrs =
    (payload.object_attributes as { action?: string; iid?: number } | undefined) ?? undefined;
  const action = attrs?.action ?? "";
  const project = (payload.project as { path_with_namespace?: string } | undefined) ?? undefined;
  const repoFullName = project?.path_with_namespace ?? "";

  const glUuid = c.req.header("x-gitlab-webhook-uuid") ?? "";
  const glEventId = glUuid || (objectKind ? `${objectKind}:${attrs?.iid ?? ""}` : "");
  if (glEventId && checkWebhookDuplicate("gitlab", glEventId)) {
    return c.json({ status: "duplicate" });
  }

  if (
    objectKind === "merge_request" &&
    ["open", "reopen", "update"].includes(action) &&
    typeof attrs?.iid === "number"
  ) {
    await enqueueVcsReview("gitlab", repoFullName, attrs.iid);
  }

  return c.json({ status: "ok" });
});

app.post("/api/webhooks/gitea", async (c) => {
  const rawBody = await c.req.text();
  const secret = process.env.GITEA_WEBHOOK_SECRET ?? "";
  if (!secret) {
    console.warn("[api] gitea webhook secret not configured");
    return c.json({ status: "ignored", reason: "webhook secret not configured" });
  }
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const event = await verifyGiteaWebhook(secret, headers, rawBody);
  if (!event) {
    return jsonError(c, 401, "unauthorized", "Invalid webhook signature");
  }

  const giteaDelivery = c.req.header("x-gitea-delivery") ?? "";
  const giteaSig = c.req.header("x-gitea-signature") ?? "";
  const giteaEventId =
    giteaDelivery || createHash("sha256").update(`${rawBody}:${giteaSig}`).digest("hex");
  if (giteaEventId && checkWebhookDuplicate("gitea", giteaEventId)) {
    return c.json({ status: "duplicate" });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody || "{}") as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const giteaEvent = c.req.header("x-gitea-event") ?? "";
  const action = typeof payload.action === "string" ? payload.action : "";
  const repository = (payload.repository as { full_name?: string } | undefined) ?? undefined;
  const repoFullName = repository?.full_name ?? "";
  const prPayload = payload.pull_request as { number?: number } | undefined;
  const prNumber = typeof payload.number === "number" ? payload.number : prPayload?.number;

  if (
    giteaEvent === "pull_request" &&
    ["opened", "synchronize", "synchronized", "reopened"].includes(action) &&
    typeof prNumber === "number"
  ) {
    await enqueueVcsReview("gitea", repoFullName, prNumber);
  }

  return c.json({ status: "ok" });
});

app.post("/api/payments/webhook", async (c) => {
  let id: string | null = null;
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const json = (await c.req.json()) as { id?: unknown };
      if (typeof json.id === "string" && json.id.trim() !== "") {
        id = json.id;
      }
    } catch {
      // ignore malformed json body
    }
  } else {
    try {
      const form = (await c.req.parseBody()) as Record<string, unknown>;
      const value = form.id;
      if (typeof value === "string" && value.trim() !== "") {
        id = value;
      }
    } catch {
      // ignore malformed form body
    }
  }

  if (!id) {
    return c.json({ status: "ignored" });
  }

  if (checkWebhookDuplicate("mollie", id)) {
    return c.json({ status: "duplicate" });
  }

  let priorPlan: PlanId | null = null;
  let priorStatus: string | null = null;
  try {
    const mollie = await createMollieClient();
    const payment = await mollie.payments.get(id);
    const meta = (payment.metadata ?? {}) as { orgId?: string; plan?: PlanId };
    if (meta.orgId) {
      const [row] = await db
        .select({
          plan: schema.teamSubscriptions.plan,
          status: schema.teamSubscriptions.status,
        })
        .from(schema.teamSubscriptions)
        .where(eq(schema.teamSubscriptions.orgId, meta.orgId))
        .limit(1);
      priorPlan = row?.plan ?? null;
      priorStatus = row?.status ?? null;
    }
  } catch (err) {
    console.warn("[api] payments webhook prefetch failed", err);
  }

  try {
    const sync = (await syncPayment(id)) as {
      orgId?: string | null;
      status?: string | null;
      plan?: PlanId | null;
      subscriptionId?: string | null;
    };
    if (sync.orgId) {
      const nextPeriodEnd = new Date();
      nextPeriodEnd.setMonth(nextPeriodEnd.getMonth() + 1);
      await db
        .update(schema.teamSubscriptions)
        .set({
          status: sync.status ?? "active",
          currentPeriodEnd: nextPeriodEnd,
          ...(typeof sync.plan === "string" ? { plan: sync.plan as PlanId } : {}),
          ...(typeof sync.subscriptionId === "string"
            ? { mollieSubscriptionId: sync.subscriptionId }
            : {}),
        })
        .where(eq(schema.teamSubscriptions.orgId, sync.orgId));

      const newPlan = typeof sync.plan === "string" ? (sync.plan as PlanId) : null;
      const newStatus = sync.status ?? "active";

      try {
        const ownerEmails = await getOrgOwnerEmails(sync.orgId);
        if (ownerEmails.length > 0) {
          const teamName = await getTeamName(sync.orgId);

          if (newStatus === "paid" || newStatus === "active") {
            const planInfo = newPlan && newPlan !== "free" ? MOLLIE_PLANS[newPlan] : null;
            const amount = planInfo ? `${planInfo.amountEur.toFixed(2)} EUR` : "";
            for (const email of ownerEmails) {
              await enqueueEmail("payment-received", email, {
                amount,
                plan: newPlan ?? "",
                planName: newPlan ?? "",
                teamName,
              });
            }
            if (newPlan && newPlan !== priorPlan) {
              for (const email of ownerEmails) {
                if (newPlan === "free") {
                  await enqueueEmail("plan-downgraded", email, {
                    fromPlan: priorPlan ?? "free",
                    toPlan: "free",
                    teamName,
                  });
                } else if (priorPlan === null || priorPlan === "free") {
                  await enqueueEmail("subscription-started", email, {
                    plan: newPlan,
                    planName: newPlan,
                    amount,
                    teamName,
                  });
                } else if (planRank(newPlan) > planRank(priorPlan)) {
                  await enqueueEmail("plan-upgraded", email, {
                    fromPlan: priorPlan,
                    toPlan: newPlan,
                    teamName,
                  });
                } else if (planRank(newPlan) < planRank(priorPlan)) {
                  await enqueueEmail("plan-downgraded", email, {
                    fromPlan: priorPlan,
                    toPlan: newPlan,
                    teamName,
                  });
                }
              }
            }
          } else if (
            (newStatus === "failed" || newStatus === "canceled" || newStatus === "expired") &&
            priorStatus === "active"
          ) {
            for (const email of ownerEmails) {
              await enqueueEmail("payment-failed", email, { teamName });
            }
          }
        }
      } catch (err) {
        console.warn("[api] billing email dispatch failed", err);
      }
    }
  } catch (err) {
    console.error("[api] payments webhook sync failed", err);
  }

  return c.json({ status: "ok" });
});

// Internal endpoint invoked by the worker's poll scheduler. Authenticated via
// a shared secret (INTERNAL_API_KEY) instead of a user session. Returns a
// summary of the tick so the worker can log it.
app.post("/api/internal/poll", async (c) => {
  const internalKey = process.env.INTERNAL_API_KEY;
  if (!internalKey) {
    return jsonError(c, 503, "internal_poll_disabled", "INTERNAL_API_KEY not configured");
  }
  const provided = c.req.header("x-internal-key");
  if (!provided || provided !== internalKey) {
    return jsonError(c, 401, "unauthorized", "Invalid internal key");
  }
  const result = await pollPullRequestsTick();
  return c.json(result);
});

app.use("/api/*", async (c, next) => {
  if (isPublicApiPath(c.req.path)) {
    return next();
  }
  const user = await requireSession(c);
  c.set("user", user);
  await next();
});

app.get("/api/me", async (c) => {
  const user = c.get("user");
  const memberships = await db
    .select({
      orgId: schema.organization.id,
      orgName: schema.organization.name,
      orgSlug: schema.organization.slug,
      role: schema.member.role,
      plan: schema.teamSubscriptions.plan,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .leftJoin(schema.teamSubscriptions, eq(schema.organization.id, schema.teamSubscriptions.orgId))
    .where(eq(schema.member.userId, user.id));

  const teams = memberships.map((m) => ({
    organization: { id: m.orgId, name: m.orgName, slug: m.orgSlug },
    role: m.role,
    plan: m.plan ?? "free",
  }));

  const [meRow] = await db
    .select({ role: schema.user.role, status: schema.user.status })
    .from(schema.user)
    .where(eq(schema.user.id, user.id))
    .limit(1);

  return c.json({
    user: { id: user.id, email: user.email, name: user.name },
    role: meRow?.role ?? "user",
    status: meRow?.status ?? "active",
    teams,
  });
});

app.post(
  "/api/me/password",
  zValidator("json", changePasswordSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    try {
      await auth.api.changePassword({
        body: {
          newPassword: body.newPassword,
          currentPassword: body.currentPassword,
          revokeOtherSessions: false,
        },
        headers: c.req.raw.headers,
      });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      const message = err instanceof Error ? err.message : "Password change failed";
      return jsonError(c, status as ContentfulStatusCode, "password_change_failed", message);
    }
    await enqueueEmail("password-changed", user.email, {
      name: user.name,
    }).catch((err: unknown) => {
      console.warn("[api] password-changed email failed", err);
    });
    await audit(null, user.id, "account.password_changed", {}).catch(() => undefined);
    return c.json({ ok: true });
  },
);

app.post(
  "/api/me/email",
  zValidator("json", changeEmailSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const oldEmail = user.email;

    try {
      await auth.api.changeEmail({
        body: { newEmail: body.newEmail },
        headers: c.req.raw.headers,
      });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      const message = err instanceof Error ? err.message : "Email change failed";
      return jsonError(c, status as ContentfulStatusCode, "email_change_failed", message);
    }

    await Promise.all([
      enqueueEmail("email-changed", oldEmail, {
        newEmail: body.newEmail,
        name: user.name,
      }).catch((err: unknown) => {
        console.warn("[api] email-changed (old) failed", err);
      }),
      enqueueEmail("email-changed", body.newEmail, {
        newEmail: body.newEmail,
        name: user.name,
      }).catch((err: unknown) => {
        console.warn("[api] email-changed (new) failed", err);
      }),
    ]);
    await audit(null, user.id, "account.email_changed", {
      oldEmail,
      newEmail: body.newEmail,
    }).catch(() => undefined);

    return c.json({ ok: true });
  },
);

app.post(
  "/api/teams",
  zValidator("json", createTeamSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    const membershipCount = await countUserMemberships(user.id);
    const governingPlan = await getUserHighestOwnedPlan(user.id);
    const teamsCap = getPlanLimits(governingPlan).teamsPerUser;
    if (teamsCap !== null && membershipCount >= teamsCap) {
      throw new ApiError(
        409,
        "teams_per_user_cap",
        `Teams per user cap (${teamsCap}) reached for ${governingPlan}`,
      );
    }

    const slugBase = `${slugify(body.name)}-${randomBytes(3).toString("hex")}`;
    const orgId = randomUUID();

    try {
      await db.transaction(async (tx) => {
        await tx.insert(schema.organization).values({
          id: orgId,
          name: body.name,
          slug: slugBase,
        });
        await tx.insert(schema.member).values({
          id: randomUUID(),
          organizationId: orgId,
          userId: user.id,
          role: "owner",
        });
        await tx.insert(schema.teamSubscriptions).values({
          orgId,
          plan: "free",
          status: "active",
        });
        await tx.insert(schema.agentProfiles).values({
          orgId,
          graphType: "pr_review",
          nodeModels: DEFAULT_NODE_MODELS,
          coverageStrategy: DEFAULT_COVERAGE_STRATEGY,
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("slug") || (err as { code?: string }).code === "23505") {
        throw new ApiError(409, "conflict", "Slug already in use");
      }
      throw err;
    }

    return c.json({ id: orgId, name: body.name, slug: slugBase }, 201);
  },
);

app.get("/api/teams", async (c) => {
  const user = c.get("user");
  const rows = await db
    .select({
      orgId: schema.organization.id,
      orgName: schema.organization.name,
      orgSlug: schema.organization.slug,
      role: schema.member.role,
      plan: schema.teamSubscriptions.plan,
      status: schema.teamSubscriptions.status,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .leftJoin(schema.teamSubscriptions, eq(schema.organization.id, schema.teamSubscriptions.orgId))
    .where(eq(schema.member.userId, user.id));
  return c.json(
    rows.map((r) => ({
      organization: { id: r.orgId, name: r.orgName, slug: r.orgSlug },
      role: r.role,
      plan: r.plan ?? "free",
      status: r.status ?? "active",
    })),
  );
});

app.get("/api/teams/:id", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");

  const memberRows = await db
    .select({ id: schema.member.id, role: schema.member.role, userId: schema.member.userId })
    .from(schema.member)
    .where(eq(schema.member.organizationId, orgId));
  const me = memberRows.find((m) => m.userId === user.id);
  if (!me) {
    throw new ApiError(403, "forbidden", "Not a member of this team");
  }

  const [org] = await db
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .limit(1);
  if (!org) {
    throw new ApiError(404, "not_found", "Team not found");
  }
  const [sub] = await db
    .select()
    .from(schema.teamSubscriptions)
    .where(eq(schema.teamSubscriptions.orgId, orgId))
    .limit(1);
  const plan = (sub?.plan ?? "free") as PlanId;
  const prReview = await getUsage(orgId, "pr_review");
  return c.json({
    organization: { id: org.id, name: org.name, slug: org.slug },
    role: me.role,
    plan,
    status: sub?.status ?? "active",
    membersCount: memberRows.length,
    createdAt: org.createdAt,
    logo: org.logo,
    usage: {
      prReview,
    },
  });
});

app.delete("/api/teams/:id", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");

  const [membership] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, user.id)))
    .limit(1);
  if (!membership) {
    throw new ApiError(404, "not_found", "Team not found");
  }
  if (membership.role !== "owner") {
    throw new ApiError(403, "forbidden", "Only the team owner can delete the team");
  }

  const [sub] = await db
    .select({
      plan: schema.teamSubscriptions.plan,
      status: schema.teamSubscriptions.status,
      mollieSubscriptionId: schema.teamSubscriptions.mollieSubscriptionId,
    })
    .from(schema.teamSubscriptions)
    .where(eq(schema.teamSubscriptions.orgId, orgId))
    .limit(1);

  // A team that has (or had) a paid Mollie subscription cannot be deleted until the
  // subscription is removed. The mollieSubscriptionId persists across active and
  // cancelled states, so this blocks both — preventing orphaned billing relationships.
  if (sub?.mollieSubscriptionId) {
    throw new ApiError(
      409,
      "active_subscription",
      "This team has an active subscription. Cancel and remove your subscription before deleting the team.",
    );
  }

  const teamName = await getTeamName(orgId);
  const ownerEmails = await getOrgOwnerEmails(orgId);

  await db.transaction(async (tx) => {
    const projectIds = (
      await tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.orgId, orgId))
    ).map((p) => p.id);

    if (projectIds.length > 0) {
      // Removing pull requests first cascades reviews/findings and clears the
      // NO-ACTION profile_id references on agent_profiles.
      await tx
        .delete(schema.pullRequests)
        .where(inArray(schema.pullRequests.projectId, projectIds));
    }
    // Order matters: agent_profiles (project_id NO-ACTION) before projects; then the
    // remaining NO-ACTION children; finally the org, which cascades member/sso/api_keys/usage.
    await tx.delete(schema.agentProfiles).where(eq(schema.agentProfiles.orgId, orgId));
    await tx.delete(schema.projects).where(eq(schema.projects.orgId, orgId));
    await tx.delete(schema.vcsConnections).where(eq(schema.vcsConnections.orgId, orgId));
    await tx.delete(schema.invitation).where(eq(schema.invitation.organizationId, orgId));
    await tx.delete(schema.teamSubscriptions).where(eq(schema.teamSubscriptions.orgId, orgId));
    await tx.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });

  for (const email of ownerEmails) {
    await enqueueEmail("member-removed", email, { teamName }).catch(() => undefined);
  }
  await audit(null, user.id, "team.deleted", {
    teamId: orgId,
    teamName,
    plan: sub?.plan ?? "free",
  }).catch(() => undefined);

  return c.json({ ok: true });
});

app.get("/api/teams/:id/projects", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAccess(c, orgId, user.id);
  const rows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.orgId, orgId))
    .orderBy(desc(schema.projects.createdAt));
  return c.json(rows);
});

app.post(
  "/api/teams/:id/projects",
  zValidator("json", createProjectSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("id");
    await requireOrgAccess(c, orgId, user.id);
    const body = c.req.valid("json");
    const webhookSecret = body.webhookSecret ?? randomBytes(32).toString("hex");
    const [project] = await db
      .insert(schema.projects)
      .values({
        orgId,
        name: body.name,
        provider: body.provider,
        repoFullName: body.repoFullName,
        webhookSecret,
        pollingEnabled: body.pollingEnabled ?? false,
      })
      .returning();
    return c.json(project, 201);
  },
);

app.get("/api/teams/:id/api-keys", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAccess(c, orgId, user.id);
  const rows = await db
    .select({
      id: schema.apiKeys.id,
      provider: schema.apiKeys.provider,
      label: schema.apiKeys.label,
      status: schema.apiKeys.status,
      lastVerifiedAt: schema.apiKeys.lastVerifiedAt,
      createdAt: schema.apiKeys.createdAt,
    })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.orgId, orgId))
    .orderBy(desc(schema.apiKeys.createdAt));
  return c.json(rows);
});

app.post(
  "/api/teams/:id/api-keys",
  zValidator("json", createApiKeySchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("id");
    await requireOrgAccess(c, orgId, user.id);
    const body = c.req.valid("json");
    const encryptedKey = encryptSecret(body.key);
    const [row] = await db
      .insert(schema.apiKeys)
      .values({
        orgId,
        provider: body.provider,
        label: body.label,
        encryptedKey,
        status: "unverified",
      })
      .returning({
        id: schema.apiKeys.id,
        provider: schema.apiKeys.provider,
        label: schema.apiKeys.label,
        status: schema.apiKeys.status,
        lastVerifiedAt: schema.apiKeys.lastVerifiedAt,
        createdAt: schema.apiKeys.createdAt,
      });
    return c.json(row, 201);
  },
);

app.delete("/api/teams/:id/api-keys/:provider", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  const provider = c.req.param("provider") as (typeof PROVIDER_VALUES)[number];
  await requireOrgAccess(c, orgId, user.id);
  await db
    .delete(schema.apiKeys)
    .where(and(eq(schema.apiKeys.provider, provider), eq(schema.apiKeys.orgId, orgId)));
  return c.json({ ok: true });
});

app.post("/api/teams/:id/api-keys/:provider/verify", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  const provider = c.req.param("provider") as (typeof PROVIDER_VALUES)[number];
  await requireOrgAccess(c, orgId, user.id);
  const [latest] = await db
    .select()
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.orgId, orgId), eq(schema.apiKeys.provider, provider)))
    .orderBy(desc(schema.apiKeys.createdAt))
    .limit(1);
  if (!latest) {
    throw new ApiError(404, "not_found", "No key registered for provider");
  }
  let ok = false;
  try {
    const plaintext = decryptSecret(latest.encryptedKey);
    ok = await verifyByokKey(provider, plaintext);
  } catch {
    ok = false;
  }
  const status = ok ? "valid" : "invalid";
  await db
    .update(schema.apiKeys)
    .set({ status, lastVerifiedAt: new Date() })
    .where(eq(schema.apiKeys.id, latest.id));
  return c.json({ status });
});

app.get("/api/teams/:id/billing", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAccess(c, orgId, user.id);
  // Fallback reconciliation: if we have a Mollie customer on file but never
  // recorded a subscription (webhook missed — e.g. local dev where Mollie can't
  // reach the API), try to recover on read. In prod the webhook is
  // authoritative and this stays a no-op once mollieSubscriptionId is set.
  const needsRecover = await (async () => {
    const [row] = await db
      .select({
        mollieCustomerId: schema.teamSubscriptions.mollieCustomerId,
        mollieSubscriptionId: schema.teamSubscriptions.mollieSubscriptionId,
        status: schema.teamSubscriptions.status,
      })
      .from(schema.teamSubscriptions)
      .where(eq(schema.teamSubscriptions.orgId, orgId))
      .limit(1);
    return Boolean(
      row?.mollieCustomerId && (!row.mollieSubscriptionId || row.status === "pending"),
    );
  })();
  if (needsRecover) {
    try {
      await recoverSubscription(orgId);
    } catch (err) {
      console.warn("[api] billing recover on read failed", err);
    }
  }
  const sub = await getTeamSubscription(orgId);
  const plan: PlanId = sub?.plan ?? "free";
  const plans = BILLING_PLAN_CATALOG.map((p) => ({
    id: p.id,
    label: p.label,
    priceEur: p.priceEur,
    features: p.features,
    isCurrent: p.id === plan,
  }));
  return c.json({
    plan,
    status: sub?.status ?? "active",
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    hasMollieCustomer: Boolean(sub?.mollieCustomerId),
    plans,
  });
});

app.post(
  "/api/teams/:id/billing/checkout",
  zValidator("json", checkoutSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("id");
    await requireOrgAccess(c, orgId, user.id);
    const body = c.req.valid("json");

    const settings = await getAppSettings();
    if (!settings.paymentsEnabled) {
      throw new ApiError(
        403,
        "payments_disabled",
        "Payments are currently disabled for this instance. Contact an administrator.",
      );
    }

    const redirectUrl = env.MOLLIE_REDIRECT_URL;
    const webhookUrl = env.MOLLIE_WEBHOOK_URL;
    if (!redirectUrl || !webhookUrl) {
      throw new ApiError(
        502,
        "billing_not_configured",
        "Mollie redirect/webhook URL not configured",
      );
    }
    try {
      const result = await startCheckout({ orgId, plan: body.plan, redirectUrl, webhookUrl });
      return c.json({ checkoutUrl: result.checkoutUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Mollie checkout failed";
      throw new ApiError(502, "billing_provider_error", msg);
    }
  },
);

app.post("/api/teams/:id/billing/cancel", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAccess(c, orgId, user.id);
  await requirePlan(c, orgId, "plus");

  const [priorSub] = await db
    .select({
      plan: schema.teamSubscriptions.plan,
      currentPeriodEnd: schema.teamSubscriptions.currentPeriodEnd,
    })
    .from(schema.teamSubscriptions)
    .where(eq(schema.teamSubscriptions.orgId, orgId))
    .limit(1);

  try {
    await cancelSubscription(orgId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Mollie cancel failed";
    throw new ApiError(502, "billing_provider_error", msg);
  }

  try {
    const teamName = await getTeamName(orgId);
    const ownerEmails = await getOrgOwnerEmails(orgId);
    const currentPeriodEnd = priorSub?.currentPeriodEnd ?? null;
    const effectiveDate = currentPeriodEnd ? currentPeriodEnd.toISOString() : "";
    for (const email of ownerEmails) {
      await enqueueEmail("subscription-cancelled", email, {
        plan: priorSub?.plan ?? "",
        teamName,
        currentPeriodEnd: effectiveDate,
        effectiveDate,
        date: effectiveDate,
      });
    }
  } catch (err) {
    console.warn("[api] subscription-cancelled email failed", err);
  }
  await audit(orgId, user.id, "billing.cancelled", {
    plan: priorSub?.plan ?? null,
  }).catch(() => undefined);

  return c.json({ ok: true });
});

app.post("/api/teams/:id/billing/sync", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAccess(c, orgId, user.id);
  try {
    const result = await recoverSubscription(orgId);
    return c.json({ ok: true, plan: result.plan, status: result.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Mollie sync failed";
    throw new ApiError(502, "billing_provider_error", msg);
  }
});

app.get("/api/teams/:id/agent-profile", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAccess(c, orgId, user.id);
  const profile = await resolveOrgProfile(orgId, "pr_review");
  if (!profile) {
    return c.json({
      orgId,
      projectId: null,
      graphType: "pr_review",
      nodeModels: DEFAULT_NODE_MODELS,
      coverageStrategy: DEFAULT_COVERAGE_STRATEGY,
      defaultDepth: resolveDepthFromMode(),
    });
  }
  return c.json(profile);
});

app.put(
  "/api/teams/:id/agent-profile",
  zValidator("json", putAgentProfileSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("id");
    await requireOrgAccess(c, orgId, user.id);
    const body = c.req.valid("json");
    const existing = await resolveOrgProfile(orgId, "pr_review");
    if (existing) {
      const merged = {
        ...((existing.nodeModels as Record<string, string> | null) ?? {}),
        ...(body.nodeModels ?? {}),
      };
      const nextDepth = body.defaultDepth ?? (existing.defaultDepth as DepthTier | null) ?? null;
      await db
        .update(schema.agentProfiles)
        .set({
          nodeModels: merged,
          coverageStrategy: body.coverageStrategy ?? existing.coverageStrategy,
          defaultDepth: nextDepth,
        })
        .where(eq(schema.agentProfiles.id, existing.id));
      return c.json({
        ...existing,
        nodeModels: merged,
        coverageStrategy: body.coverageStrategy ?? existing.coverageStrategy,
        defaultDepth: nextDepth,
      });
    }
    const nodeModels = body.nodeModels ?? DEFAULT_NODE_MODELS;
    const [created] = await db
      .insert(schema.agentProfiles)
      .values({
        orgId,
        graphType: "pr_review",
        nodeModels,
        coverageStrategy: body.coverageStrategy ?? DEFAULT_COVERAGE_STRATEGY,
        defaultDepth: body.defaultDepth ?? null,
      })
      .returning();
    return c.json(created, 201);
  },
);

app.get("/api/teams/:id/agent-graph/:type", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAccess(c, orgId, user.id);
  const profile = await resolveOrgProfile(orgId, "pr_review");
  const nodeModels = extractNodeModels(profile?.nodeModels);
  return c.json(await getReviewGraphDescriptor({ orgId, nodeModels }));
});

app.put(
  "/api/teams/:id/agent-graph/:type/nodes/:key",
  zValidator("json", putGraphNodeSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("id");
    await requireOrgAccess(c, orgId, user.id);
    const rawKey = c.req.param("key");
    const PR_REVIEW_NODE_KEYS: Record<string, string> = {
      PLAN: "orchestrator",
      REVIEW: "reviewer",
      SYNTHESIZE: "summarizer",
    };
    const key = PR_REVIEW_NODE_KEYS[rawKey];
    if (!key) {
      throw new ApiError(400, "validation_error", "Invalid node key");
    }
    const body = c.req.valid("json");
    const existing = await resolveOrgProfile(orgId, "pr_review");
    if (existing) {
      const current = (existing.nodeModels as Record<string, string> | null) ?? {};
      const merged = { ...current, [key]: body.modelId };
      await db
        .update(schema.agentProfiles)
        .set({ nodeModels: merged })
        .where(eq(schema.agentProfiles.id, existing.id));
    } else {
      const base = { ...DEFAULT_NODE_MODELS, [key]: body.modelId };
      await db.insert(schema.agentProfiles).values({
        orgId,
        graphType: "pr_review",
        nodeModels: base,
        coverageStrategy: DEFAULT_COVERAGE_STRATEGY,
      });
    }
    const refreshed = await resolveOrgProfile(orgId, "pr_review");
    const nodeModels = extractNodeModels(refreshed?.nodeModels);
    return c.json(await getReviewGraphDescriptor({ orgId, nodeModels }));
  },
);

app.get("/api/teams/:id/vcs-connections", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAccess(c, orgId, user.id);
  const rows = await db
    .select({
      id: schema.vcsConnections.id,
      provider: schema.vcsConnections.provider,
      kind: schema.vcsConnections.kind,
      externalId: schema.vcsConnections.externalId,
      scopes: schema.vcsConnections.scopes,
      baseUrl: schema.vcsConnections.baseUrl,
      createdAt: schema.vcsConnections.createdAt,
    })
    .from(schema.vcsConnections)
    .where(eq(schema.vcsConnections.orgId, orgId))
    .orderBy(desc(schema.vcsConnections.createdAt));
  return c.json(rows);
});

app.get("/api/teams/:id/vcs-repos", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAccess(c, orgId, user.id);
  const providerRaw = c.req.query("provider") ?? "github";
  const provider = providerRaw as "github" | "gitlab" | "gitea";
  if (provider !== "github" && provider !== "gitlab" && provider !== "gitea") {
    throw new ApiError(400, "validation_error", "Unsupported VCS provider");
  }
  const stored = await getStoredVcsConnection(orgId, provider);
  if (!stored) {
    return c.json({ items: [], connected: false });
  }
  try {
    const vcs = await getVcsProvider({
      provider,
      token: stored.token,
      baseUrl: stored.baseUrl ?? undefined,
    });
    const items = await vcs.listRepos();
    return c.json({ items, connected: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "VCS list repos failed";
    throw new ApiError(502, "vcs_provider_error", msg);
  }
});

app.post(
  "/api/vcs/connect/:provider",
  zValidator("json", vcsConnectSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const user = c.get("user");
    const provider = c.req.param("provider");
    if (provider !== "github" && provider !== "gitlab" && provider !== "gitea") {
      throw new ApiError(400, "validation_error", "Unsupported VCS provider");
    }
    const body = c.req.valid("json");
    let orgId = body.orgId;
    if (!orgId) {
      const [first] = await db
        .select({ orgId: schema.member.organizationId })
        .from(schema.member)
        .where(eq(schema.member.userId, user.id))
        .orderBy(schema.member.organizationId)
        .limit(1);
      orgId = first?.orgId;
    }
    if (!orgId) {
      throw new ApiError(400, "validation_error", "No team membership; specify orgId");
    }
    await requireOrgAccess(c, orgId, user.id);
    await db.insert(schema.vcsConnections).values({
      orgId,
      provider,
      kind: "oauth",
      accessToken: encryptSecret(body.token),
      baseUrl: body.baseUrl ?? null,
    });
    return c.json({ ok: true }, 201);
  },
);

app.get("/api/models", async (c) => {
  const orgId = c.req.query("orgId");
  const catalog = await fetchModelCatalog(orgId);
  return c.json(catalog);
});

app.get("/api/projects/:id/pulls", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  if (!project) {
    throw new ApiError(404, "not_found", "Project not found");
  }
  await requireOrgAccess(c, project.orgId, user.id);
  const pulls = await db
    .select()
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.projectId, projectId))
    .orderBy(desc(schema.pullRequests.openedAt));
  return c.json({ project, pulls });
});

app.get("/api/projects/:id/pulls/open", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  if (!project) {
    throw new ApiError(404, "not_found", "Project not found");
  }
  await requireOrgAccess(c, project.orgId, user.id);

  const provider = (project.provider as "github" | "gitlab" | "gitea" | null) ?? "github";
  const [owner, ...rest] = (project.repoFullName ?? "").split("/");
  const repoName = rest.join("/");
  if (!owner || !repoName) {
    throw new ApiError(400, "validation_error", "Project repo full name is not set");
  }

  const stateParam = (c.req.query("state") as "open" | "closed" | "all" | undefined) ?? "open";
  const state: "open" | "closed" | "all" =
    stateParam === "closed" || stateParam === "all" ? stateParam : "open";

  const auth = await resolveReviewAuth({
    provider,
    orgId: project.orgId,
    owner,
    name: repoName,
  });
  if (!auth) {
    throw new ApiError(
      401,
      "vcs_not_authorized",
      "No stored VCS connection for this team. Connect a token in team settings.",
    );
  }
  try {
    const vcs = await getVcsProvider(auth);
    const items = await vcs.listPullRequests(owner, repoName, { state, perPage: 30 });
    return c.json({ items });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "VCS list pull requests failed";
    throw new ApiError(502, "vcs_provider_error", msg);
  }
});

app.get("/api/projects/:id/reviews", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  if (!project) {
    throw new ApiError(404, "not_found", "Project not found");
  }
  await requireOrgAccess(c, project.orgId, user.id);
  const rows = await db
    .select({
      id: schema.reviews.id,
      status: schema.reviews.status,
      source: schema.reviews.source,
      billingMode: schema.reviews.billingMode,
      creditsCost: schema.reviews.creditsCost,
      walkthrough: schema.reviews.walkthrough,
      createdAt: schema.reviews.createdAt,
      completedAt: schema.reviews.completedAt,
      prExternalNumber: schema.pullRequests.externalNumber,
      prTitle: schema.pullRequests.title,
      prAuthor: schema.pullRequests.author,
      prHtmlUrl: schema.pullRequests.htmlUrl,
    })
    .from(schema.reviews)
    .innerJoin(schema.pullRequests, eq(schema.reviews.prId, schema.pullRequests.id))
    .where(eq(schema.reviews.projectId, projectId))
    .orderBy(desc(schema.reviews.createdAt))
    .limit(50);
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      status: r.status,
      source: r.source,
      billingMode: r.billingMode,
      creditsCost: r.creditsCost,
      walkthrough: r.walkthrough,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
      pullRequest: {
        externalNumber: r.prExternalNumber,
        title: r.prTitle,
        author: r.prAuthor,
        htmlUrl: r.prHtmlUrl,
      },
    })),
  });
});

app.post("/api/projects/:id/pulls/:n/review", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");
  const prNumber = Number(c.req.param("n"));
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    throw new ApiError(400, "validation_error", "Invalid pull request number");
  }

  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  if (!project) {
    throw new ApiError(404, "not_found", "Project not found");
  }
  const orgId = project.orgId;
  await requireOrgAccess(c, orgId, user.id);

  let parsed: z.infer<typeof triggerReviewSchema> = {};
  try {
    parsed = triggerReviewSchema.parse(await c.req.json());
  } catch {
    parsed = {};
  }
  const syntheticPr = parsed.synthetic;

  if (!syntheticPr) {
    const plan = await getTeamPlan(orgId);
    const hasByok = await hasValidByokKey(orgId);
    if (plan === "free" && !hasByok) {
      throw new ApiError(
        402,
        "free_byok_only",
        "Free plan is BYOK-only — add your own API key in team settings or upgrade.",
      );
    }
    // Deep reviews are Plus/Pro only. Gate explicitly here with a 403 so the
    // dashboard gets a clear error (webhook/comment triggers downgrade silently
    // inside resolveEnqueueDepth instead).
    if (parsed.depth === "deep" && planRank(plan) < planRank("plus")) {
      throw new ApiError(403, "plan_required", "Deep reviews require Plus or Pro");
    }
    // Preflight the daily quota against the run's depth tier. For agentic runs
    // we reserve the tier's spend ceiling (the agent loop hard-caps spend at
    // that budget); the static path reserves the weight-unit floor. A team with
    // a valid BYOK key runs on its own spend, so bypass the hosted quota.
    const projectedDepth = pickDepthTier(parsed.depth ?? null, null);
    const projectedCost = projectReviewCost(projectedDepth);
    const quota = await checkQuota(orgId, "pr_review", projectedCost, {
      billingMode: hasByok ? "byok" : "hosted",
    });
    if (!quota.allowed) {
      throw new ApiError(
        402,
        "quota_exceeded",
        "reason" in quota && quota.reason ? quota.reason : "PR review quota exceeded",
      );
    }
  }

  const profile = await resolveOrgProfile(orgId, "pr_review");
  const reviewId = await upsertPullAndEnqueueReview({
    orgId,
    projectId,
    prNumber,
    repoFullName: project.repoFullName ?? "",
    provider: (project.provider as "github" | "gitlab" | "gitea" | null) ?? "github",
    profile,
    syntheticPr,
    repoPath: parsed.repoPath,
    depth: syntheticPr ? "static" : (parsed.depth ?? null),
    triggerUserId: user.id,
    triggerEmail: user.email,
    source: syntheticPr ? "synthetic" : "manual",
  });

  return c.json({ reviewId, status: "queued" }, 202);
});

app.get("/api/reviews/:id", async (c) => {
  const user = c.get("user");
  const reviewId = c.req.param("id");
  const [review] = await db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, reviewId))
    .limit(1);
  if (!review) {
    throw new ApiError(404, "not_found", "Review not found");
  }
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, review.projectId ?? ""))
    .limit(1);
  if (project) {
    await requireOrgAccess(c, project.orgId, user.id);
  }
  const [pullRequest] = review.prId
    ? await db
        .select()
        .from(schema.pullRequests)
        .where(eq(schema.pullRequests.id, review.prId))
        .limit(1)
    : [undefined];
  const findings = await db
    .select()
    .from(schema.reviewFindings)
    .where(eq(schema.reviewFindings.reviewId, reviewId));
  return c.json({
    review,
    pullRequest: pullRequest
      ? {
          id: pullRequest.id,
          externalNumber: pullRequest.externalNumber,
          title: pullRequest.title,
          author: pullRequest.author,
          state: pullRequest.state,
          baseSha: pullRequest.baseSha,
          headSha: pullRequest.headSha,
          htmlUrl: pullRequest.htmlUrl,
          openedAt: pullRequest.openedAt,
        }
      : null,
    project: project
      ? {
          id: project.id,
          name: project.name,
          provider: project.provider,
          repoFullName: project.repoFullName,
        }
      : null,
    diff: review.diff,
    findings: findings.map((f) => ({
      id: f.id,
      file: f.file,
      line: f.line,
      severity: f.severity,
      category: f.category,
      message: f.message,
      suggestion: f.suggestion,
    })),
  });
});

app.get("/api/teams/:id/members", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAccess(c, orgId, user.id);
  const rows = await db
    .select({
      userId: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.member.role,
      createdAt: schema.member.createdAt,
    })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(eq(schema.member.organizationId, orgId))
    .orderBy(desc(schema.member.createdAt));
  return c.json(rows);
});

app.post(
  "/api/teams/:id/invite",
  zValidator("json", inviteMemberSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("id");
    await requireOrgAdmin(c, orgId, user.id);
    const body = c.req.valid("json");

    const plan = await getOrgPlan(orgId);
    const cap = getPlanLimits(plan).membersPerTeam;
    if (cap !== null) {
      const memberRows = await db
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(eq(schema.member.organizationId, orgId));
      const pendingRows = await db
        .select({ id: schema.invitation.id })
        .from(schema.invitation)
        .where(
          and(eq(schema.invitation.organizationId, orgId), eq(schema.invitation.status, "pending")),
        );
      if (memberRows.length + pendingRows.length >= cap) {
        throw new ApiError(409, "cap_reached", `Member cap (${cap}) reached for ${plan}`);
      }
    }

    const [existing] = await db
      .select({ id: schema.invitation.id })
      .from(schema.invitation)
      .where(and(eq(schema.invitation.email, body.email), eq(schema.invitation.status, "pending")))
      .limit(1);
    if (existing) {
      throw new ApiError(409, "already_invited", "An invitation is already pending for this email");
    }

    const invitationId = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.insert(schema.invitation).values({
      id: invitationId,
      organizationId: orgId,
      email: body.email,
      role: body.role,
      status: "pending",
      expiresAt,
      inviterId: user.id,
    });

    const teamName = await getTeamName(orgId);
    const inviteUrl = `${env.PUBLIC_WEB_URL}/invitations/${invitationId}`;
    await enqueueEmail("team-invite", body.email, {
      teamName,
      inviterName: user.name,
      role: body.role,
      token: invitationId,
      inviteUrl,
    });
    await audit(orgId, user.id, "team.invite", {
      email: body.email,
      role: body.role,
      invitationId,
    });
    return c.json({ invitationId }, 201);
  },
);

app.get("/api/me/invitations", async (c) => {
  const user = c.get("user");
  const rows = await db
    .select({
      id: schema.invitation.id,
      organizationId: schema.invitation.organizationId,
      teamName: schema.organization.name,
      role: schema.invitation.role,
      expiresAt: schema.invitation.expiresAt,
      createdAt: schema.invitation.createdAt,
    })
    .from(schema.invitation)
    .innerJoin(schema.organization, eq(schema.invitation.organizationId, schema.organization.id))
    .where(and(eq(schema.invitation.email, user.email), eq(schema.invitation.status, "pending")))
    .orderBy(desc(schema.invitation.createdAt));
  return c.json(rows);
});

app.post("/api/invitations/:token/accept", async (c) => {
  const user = c.get("user");
  const token = c.req.param("token");
  const [inv] = await db
    .select()
    .from(schema.invitation)
    .where(eq(schema.invitation.id, token))
    .limit(1);
  if (!inv) {
    throw new ApiError(404, "not_found", "Invitation not found");
  }
  if (inv.status !== "pending") {
    throw new ApiError(409, "invitation_not_pending", "Invitation is no longer pending");
  }
  if (inv.expiresAt && inv.expiresAt < new Date()) {
    throw new ApiError(410, "invitation_expired", "Invitation has expired");
  }
  if (inv.email !== user.email) {
    throw new ApiError(403, "forbidden", "Invitation is not addressed to this user");
  }

  const [already] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(
      and(eq(schema.member.organizationId, inv.organizationId), eq(schema.member.userId, user.id)),
    )
    .limit(1);
  if (already) {
    throw new ApiError(409, "already_member", "Already a member of this team");
  }

  const membershipCount = await countUserMemberships(user.id);
  const governingPlan = await getUserHighestOwnedPlan(user.id);
  const teamsCap = getPlanLimits(governingPlan).teamsPerUser;
  if (teamsCap !== null && membershipCount >= teamsCap) {
    throw new ApiError(
      409,
      "teams_per_user_cap",
      `Teams per user cap (${teamsCap}) reached for ${governingPlan}`,
    );
  }

  await db.insert(schema.member).values({
    id: randomUUID(),
    organizationId: inv.organizationId,
    userId: user.id,
    role: inv.role ?? "member",
  });
  await db
    .update(schema.invitation)
    .set({ status: "accepted" })
    .where(eq(schema.invitation.id, token));

  const teamName = await getTeamName(inv.organizationId);
  if (inv.inviterId) {
    const inviterEmail = await getUserEmail(inv.inviterId);
    if (inviterEmail) {
      await enqueueEmail("invite-accepted", inviterEmail, { teamName, email: user.email });
    }
  }
  await audit(inv.organizationId, user.id, "team.invite_accepted", {
    email: user.email,
    role: inv.role ?? "member",
  });
  return c.json({ organizationId: inv.organizationId });
});

app.post("/api/invitations/:token/decline", async (c) => {
  const user = c.get("user");
  const token = c.req.param("token");
  const [inv] = await db
    .select()
    .from(schema.invitation)
    .where(eq(schema.invitation.id, token))
    .limit(1);
  if (!inv) {
    throw new ApiError(404, "not_found", "Invitation not found");
  }
  if (inv.status !== "pending") {
    throw new ApiError(409, "invitation_not_pending", "Invitation is no longer pending");
  }
  if (inv.email !== user.email) {
    throw new ApiError(403, "forbidden", "Invitation is not addressed to this user");
  }
  await db
    .update(schema.invitation)
    .set({ status: "declined" })
    .where(eq(schema.invitation.id, token));

  const teamName = await getTeamName(inv.organizationId);
  if (inv.inviterId) {
    const inviterEmail = await getUserEmail(inv.inviterId);
    if (inviterEmail) {
      await enqueueEmail("invite-declined", inviterEmail, { teamName, email: user.email });
    }
  }
  await audit(inv.organizationId, user.id, "team.invite_declined", { email: user.email });
  return c.json({ ok: true });
});

app.delete("/api/teams/:id/members/:userId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  const targetUserId = c.req.param("userId");
  await requireOrgAdmin(c, orgId, user.id);

  const [target] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, targetUserId)))
    .limit(1);
  if (!target) {
    throw new ApiError(404, "not_found", "Member not found");
  }
  if (target.role === "owner") {
    const owners = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")));
    if (owners.length <= 1) {
      throw new ApiError(409, "last_owner", "Cannot remove the last owner");
    }
  }

  const removedEmail = await getUserEmail(targetUserId);
  await db
    .delete(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, targetUserId)));

  const teamName = await getTeamName(orgId);
  if (removedEmail) {
    await enqueueEmail("member-removed", removedEmail, { teamName });
  }
  await audit(orgId, user.id, "team.member_removed", {
    userId: targetUserId,
    email: removedEmail,
  });
  return c.json({ ok: true });
});

app.post("/api/teams/:id/members/:userId/leave", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  const targetUserId = c.req.param("userId");
  if (targetUserId !== user.id) {
    throw new ApiError(403, "forbidden", "You can only leave on your own behalf");
  }

  const [self] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, user.id)))
    .limit(1);
  if (!self) {
    throw new ApiError(404, "not_found", "Membership not found");
  }
  if (self.role === "owner") {
    const owners = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")));
    if (owners.length <= 1) {
      throw new ApiError(
        409,
        "last_owner",
        "Cannot leave as the last owner; transfer ownership first",
      );
    }
  }

  const recipients = await db
    .select({ email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(
      and(
        eq(schema.member.organizationId, orgId),
        inArray(schema.member.role, ["owner", "admin"]),
        ne(schema.member.userId, user.id),
      ),
    );
  const teamName = await getTeamName(orgId);
  await db
    .delete(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, user.id)));
  for (const r of recipients) {
    if (r.email) {
      await enqueueEmail("member-left", r.email, { teamName, email: user.email });
    }
  }
  await audit(orgId, user.id, "team.member_left", { email: user.email });
  return c.json({ ok: true });
});

app.patch(
  "/api/teams/:id/members/:userId",
  zValidator("json", updateMemberRoleSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("id");
    const targetUserId = c.req.param("userId");
    await requireOrgAdmin(c, orgId, user.id);
    const body = c.req.valid("json");

    const [target] = await db
      .select({ id: schema.member.id, role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, targetUserId)))
      .limit(1);
    if (!target) {
      throw new ApiError(404, "not_found", "Member not found");
    }
    if (target.role === "owner" && body.role !== "owner") {
      const owners = await db
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")));
      if (owners.length <= 1) {
        throw new ApiError(409, "last_owner", "Cannot demote the last owner");
      }
    }

    await db.update(schema.member).set({ role: body.role }).where(eq(schema.member.id, target.id));

    const memberEmail = await getUserEmail(targetUserId);
    const teamName = await getTeamName(orgId);
    if (memberEmail) {
      await enqueueEmail("role-changed", memberEmail, { teamName, role: body.role });
    }
    await audit(orgId, user.id, "team.member_role_changed", {
      userId: targetUserId,
      role: body.role,
    });
    return c.json({ ok: true });
  },
);

app.get("/api/teams/:id/audit", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAdmin(c, orgId, user.id);
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.orgId, orgId))
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(50);
  return c.json(rows);
});

app.get("/api/teams/:id/sso", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAdmin(c, orgId, user.id);
  await requirePlan(c, orgId, "pro");
  const [row] = await db
    .select()
    .from(schema.sso)
    .where(eq(schema.sso.organizationId, orgId))
    .limit(1);
  if (!row) {
    return c.json(null);
  }
  const rawConfig = (row.config as Record<string, unknown> | null) ?? {};
  const safeConfig: Record<string, unknown> = { ...rawConfig };
  if (typeof safeConfig.clientSecret === "string") {
    safeConfig.clientSecret = safeConfig.clientSecret ? "{{encrypted}}" : null;
  }
  return c.json({ ...row, config: safeConfig });
});

app.post(
  "/api/teams/:id/sso",
  zValidator("json", upsertSsoSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("id");
    await requireOrgAdmin(c, orgId, user.id);
    await requirePlan(c, orgId, "pro");
    const body = c.req.valid("json");

    if (body.providerId === "saml") {
      const parsed = samlConfigSchema.safeParse(body.config);
      if (!parsed.success) {
        throw new ApiError(
          400,
          "validation_error",
          "SAML config requires entryURL, certificate, entityId",
        );
      }
    } else {
      const parsed = oidcConfigSchema.safeParse(body.config);
      if (!parsed.success) {
        throw new ApiError(400, "validation_error", "OIDC config requires clientId and issuerUrl");
      }
    }

    const storedConfig: Record<string, unknown> = {
      ...(body.config as Record<string, unknown>),
    };
    if (typeof storedConfig.clientSecret === "string" && storedConfig.clientSecret.length > 0) {
      storedConfig.clientSecret = encryptSecret(storedConfig.clientSecret);
    }

    const [existing] = await db
      .select({ id: schema.sso.id })
      .from(schema.sso)
      .where(eq(schema.sso.organizationId, orgId))
      .limit(1);
    if (existing) {
      await db
        .update(schema.sso)
        .set({ domain: body.domain, providerId: body.providerId, config: storedConfig })
        .where(eq(schema.sso.id, existing.id));
    } else {
      await db.insert(schema.sso).values({
        id: randomUUID(),
        organizationId: orgId,
        domain: body.domain,
        providerId: body.providerId,
        config: storedConfig,
      });
    }
    await audit(orgId, user.id, "team.sso_configured", {
      providerId: body.providerId,
      domain: body.domain,
    });
    return c.json({ ok: true });
  },
);

app.delete("/api/teams/:id/sso", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAdmin(c, orgId, user.id);
  await requirePlan(c, orgId, "pro");
  await db.delete(schema.sso).where(eq(schema.sso.organizationId, orgId));
  await audit(orgId, user.id, "team.sso_removed", {});
  return c.json({ ok: true });
});

app.post(
  "/api/sso/resolve",
  zValidator("json", resolveSsoSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const body = c.req.valid("json");
    const domain = body.email.split("@")[1]?.toLowerCase() ?? "";
    if (!domain) {
      throw new ApiError(400, "validation_error", "Invalid email");
    }
    const [row] = await db
      .select({
        providerId: schema.sso.providerId,
        organizationId: schema.sso.organizationId,
      })
      .from(schema.sso)
      .where(eq(schema.sso.domain, domain))
      .limit(1);
    return c.json(row ?? null);
  },
);

app.get("/api/signup-config", async (c) => {
  const settings = await getAppSettings();
  return c.json({
    signupMode: settings.signupMode,
    allowedDomains: settings.allowedDomains ?? [],
    paymentsEnabled: settings.paymentsEnabled,
  });
});

// ---------------------------------------------------------------------------
// Admin section — /api/admin/*
// ---------------------------------------------------------------------------

app.use("/api/admin/*", requireAdminMiddleware);

app.get("/api/admin/settings", async (c) => {
  const settings = await getAppSettings();
  return c.json({
    signupMode: settings.signupMode,
    allowedDomains: settings.allowedDomains ?? [],
    paymentsEnabled: settings.paymentsEnabled,
    updatedAt: settings.updatedAt,
  });
});

const updateSettingsSchema = z.object({
  signupMode: z.enum(["open", "closed", "domain_restricted", "approval"]).optional(),
  allowedDomains: z.array(z.string().min(1)).optional(),
  paymentsEnabled: z.boolean().optional(),
});

app.patch(
  "/api/admin/settings",
  zValidator("json", updateSettingsSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (body.signupMode) {
      set.signupMode = body.signupMode;
    }
    if (body.allowedDomains) {
      set.allowedDomains = body.allowedDomains
        .flatMap((d) => d.split(/[\s,]+/))
        .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
        .filter((d) => d.length > 0);
    }
    if (typeof body.paymentsEnabled === "boolean") {
      set.paymentsEnabled = body.paymentsEnabled;
    }
    const [updated] = await db
      .update(schema.appSettings)
      .set(set)
      .where(eq(schema.appSettings.id, "singleton"))
      .returning();
    await audit(null, user.id, "admin.settings_updated", {
      signupMode: updated?.signupMode,
      paymentsEnabled: updated?.paymentsEnabled,
    }).catch(() => undefined);
    return c.json({
      signupMode: updated?.signupMode ?? "open",
      allowedDomains: updated?.allowedDomains ?? [],
      paymentsEnabled: updated?.paymentsEnabled ?? true,
      updatedAt: updated?.updatedAt ?? new Date(),
    });
  },
);

app.get("/api/admin/stats", async (c) => {
  const [userCounts] = await db
    .select({
      total: count(schema.user.id),
    })
    .from(schema.user);
  const [adminCounts] = await db
    .select({ total: count(schema.user.id) })
    .from(schema.user)
    .where(eq(schema.user.role, "admin"));
  const statusRows = await db
    .select({ status: schema.user.status, total: count() })
    .from(schema.user)
    .groupBy(schema.user.status);
  const statusBreakdown: Record<string, number> = {};
  for (const r of statusRows) {
    statusBreakdown[r.status ?? "active"] = Number(r.total);
  }

  const [teamCount] = await db.select({ total: count() }).from(schema.organization);

  const [reviewAgg] = await db
    .select({
      total: count(schema.reviews.id),
      spendUsd: sum(schema.reviews.tokenSpendUsd),
      credits: sum(schema.reviews.creditsCost),
    })
    .from(schema.reviews);
  const reviewStatusRows = await db
    .select({ status: schema.reviews.status, total: count() })
    .from(schema.reviews)
    .groupBy(schema.reviews.status);
  const reviewByStatus: Record<string, number> = {};
  for (const r of reviewStatusRows) {
    reviewByStatus[r.status ?? "unknown"] = Number(r.total);
  }

  const [pendingSignups] = await db
    .select({ total: count() })
    .from(schema.signupRequests)
    .where(eq(schema.signupRequests.status, "pending"));

  const [usageAgg] = await db.select({ credits: sum(schema.usage.credits) }).from(schema.usage);

  const settings = await getAppSettings();

  return c.json({
    users: {
      total: Number(userCounts?.total ?? 0),
      admins: Number(adminCounts?.total ?? 0),
      active: statusBreakdown.active ?? 0,
      pending: statusBreakdown.pending ?? 0,
      denied: statusBreakdown.denied ?? 0,
    },
    teams: { total: Number(teamCount?.total ?? 0) },
    reviews: {
      total: Number(reviewAgg?.total ?? 0),
      byStatus: reviewByStatus,
    },
    tokens: {
      spendUsd: Number(reviewAgg?.spendUsd ?? 0),
      credits: Number(reviewAgg?.credits ?? 0),
      usageCredits: Number(usageAgg?.credits ?? 0),
    },
    signups: {
      pending: Number(pendingSignups?.total ?? 0),
    },
    signupMode: settings.signupMode,
    paymentsEnabled: settings.paymentsEnabled,
  });
});

app.get("/api/admin/users", async (c) => {
  const status = c.req.query("status");
  const role = c.req.query("role");
  const q = c.req.query("q")?.trim().toLowerCase();
  const conditions = [];
  if (status === "active" || status === "pending" || status === "denied") {
    conditions.push(eq(schema.user.status, status));
  }
  if (role === "admin" || role === "user") {
    conditions.push(eq(schema.user.role, role));
  }
  const rows = await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.user.role,
      status: schema.user.status,
      emailVerified: schema.user.emailVerified,
      createdAt: schema.user.createdAt,
    })
    .from(schema.user)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.user.createdAt));
  const filtered = q
    ? rows.filter((r) => r.email.toLowerCase().includes(q) || r.name.toLowerCase().includes(q))
    : rows;
  return c.json({ items: filtered });
});

const updateUserRoleSchema = z.object({ role: z.enum(["admin", "user"]) });

app.patch(
  "/api/admin/users/:id/role",
  zValidator("json", updateUserRoleSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const actor = c.get("user");
    const targetId = c.req.param("id");
    const body = c.req.valid("json");

    const [target] = await db
      .select({
        id: schema.user.id,
        role: schema.user.role,
        status: schema.user.status,
        email: schema.user.email,
        name: schema.user.name,
      })
      .from(schema.user)
      .where(eq(schema.user.id, targetId))
      .limit(1);
    if (!target) {
      throw new ApiError(404, "not_found", "User not found");
    }

    if (target.role !== body.role) {
      if (target.role === "admin" && body.role === "user") {
        const adminRows = await db
          .select({ id: schema.user.id })
          .from(schema.user)
          .where(eq(schema.user.role, "admin"));
        if (adminRows.length <= 1) {
          throw new ApiError(
            409,
            "last_admin",
            "Cannot demote the last administrator. Promote another user first.",
          );
        }
      }
      await db.update(schema.user).set({ role: body.role }).where(eq(schema.user.id, targetId));
      if (target.email) {
        if (body.role === "admin") {
          await enqueueEmail("admin-role-granted", target.email, {
            name: target.name ?? "",
            actorName: actor.name,
          }).catch(() => undefined);
        } else {
          await enqueueEmail("admin-role-revoked", target.email, {
            name: target.name ?? "",
            actorName: actor.name,
          }).catch(() => undefined);
        }
      }
      await audit(null, actor.id, "admin.role_changed", {
        targetUserId: targetId,
        role: body.role,
      }).catch(() => undefined);
    }
    return c.json({ ok: true });
  },
);

const updateUserStatusSchema = z.object({
  status: z.enum(["active", "denied"]),
  reason: z.string().optional(),
});

app.patch(
  "/api/admin/users/:id/status",
  zValidator("json", updateUserStatusSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const actor = c.get("user");
    const targetId = c.req.param("id");
    const body = c.req.valid("json");

    const [target] = await db
      .select({
        id: schema.user.id,
        role: schema.user.role,
        status: schema.user.status,
        email: schema.user.email,
        name: schema.user.name,
      })
      .from(schema.user)
      .where(eq(schema.user.id, targetId))
      .limit(1);
    if (!target) {
      throw new ApiError(404, "not_found", "User not found");
    }

    if (target.status === body.status) {
      return c.json({ ok: true });
    }

    if (body.status === "denied" && target.role === "admin") {
      const adminRows = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.role, "admin"));
      if (adminRows.length <= 1) {
        throw new ApiError(
          409,
          "last_admin",
          "Cannot disable the last administrator. Promote another admin first.",
        );
      }
    }

    await db.update(schema.user).set({ status: body.status }).where(eq(schema.user.id, targetId));

    if (target.email) {
      if (body.status === "denied") {
        await enqueueEmail("account-disabled", target.email, {
          name: target.name ?? "",
          reason: body.reason ?? "",
        }).catch(() => undefined);
      }
    }
    await audit(null, actor.id, "admin.user_status_changed", {
      targetUserId: targetId,
      status: body.status,
      reason: body.reason,
    }).catch(() => undefined);
    return c.json({ ok: true });
  },
);

app.get("/api/admin/signup-requests", async (c) => {
  const statusParam = c.req.query("status");
  const status = statusParam === "approved" || statusParam === "denied" ? statusParam : "pending";
  const rows = await db
    .select({
      id: schema.signupRequests.id,
      userId: schema.signupRequests.userId,
      email: schema.signupRequests.email,
      name: schema.signupRequests.name,
      status: schema.signupRequests.status,
      denialReason: schema.signupRequests.denialReason,
      decidedBy: schema.signupRequests.decidedBy,
      decidedAt: schema.signupRequests.decidedAt,
      createdAt: schema.signupRequests.createdAt,
    })
    .from(schema.signupRequests)
    .where(eq(schema.signupRequests.status, status))
    .orderBy(desc(schema.signupRequests.createdAt));
  return c.json({ items: rows });
});

app.post("/api/admin/signup-requests/:id/approve", async (c) => {
  const actor = c.get("user");
  const requestId = c.req.param("id");
  const [reqRow] = await db
    .select()
    .from(schema.signupRequests)
    .where(eq(schema.signupRequests.id, requestId))
    .limit(1);
  if (!reqRow) {
    throw new ApiError(404, "not_found", "Sign-up request not found");
  }
  if (reqRow.status !== "pending") {
    throw new ApiError(409, "not_pending", "Request is no longer pending");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(schema.signupRequests)
      .set({ status: "approved", decidedBy: actor.id, decidedAt: new Date() })
      .where(eq(schema.signupRequests.id, requestId));
    await tx.update(schema.user).set({ status: "active" }).where(eq(schema.user.id, reqRow.userId));
  });

  if (reqRow.email) {
    await enqueueEmail("signup-approved", reqRow.email, {
      name: reqRow.name ?? "",
    }).catch(() => undefined);
  }
  await audit(null, actor.id, "admin.signup_approved", {
    targetUserId: reqRow.userId,
    email: reqRow.email,
  }).catch(() => undefined);
  return c.json({ ok: true });
});

const denySignupSchema = z.object({ reason: z.string().optional() });

app.post(
  "/api/admin/signup-requests/:id/deny",
  zValidator("json", denySignupSchema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c,
        400,
        "validation_error",
        result.error.issues.map((i) => i.message).join("; "),
      );
    }
  }),
  async (c) => {
    const actor = c.get("user");
    const requestId = c.req.param("id");
    const body = c.req.valid("json");
    const [reqRow] = await db
      .select()
      .from(schema.signupRequests)
      .where(eq(schema.signupRequests.id, requestId))
      .limit(1);
    if (!reqRow) {
      throw new ApiError(404, "not_found", "Sign-up request not found");
    }
    if (reqRow.status !== "pending") {
      throw new ApiError(409, "not_pending", "Request is no longer pending");
    }

    const supportEmail = (await getAdminEmails())[0] ?? "";
    await db.transaction(async (tx) => {
      await tx
        .update(schema.signupRequests)
        .set({
          status: "denied",
          decidedBy: actor.id,
          decidedAt: new Date(),
          denialReason: body.reason ?? null,
        })
        .where(eq(schema.signupRequests.id, requestId));
      await tx
        .update(schema.user)
        .set({ status: "denied" })
        .where(eq(schema.user.id, reqRow.userId));
    });

    if (reqRow.email) {
      await enqueueEmail("signup-denied", reqRow.email, {
        name: reqRow.name ?? "",
        reason: body.reason ?? "",
        supportEmail,
      }).catch(() => undefined);
    }
    await audit(null, actor.id, "admin.signup_denied", {
      targetUserId: reqRow.userId,
      email: reqRow.email,
      reason: body.reason,
    }).catch(() => undefined);
    return c.json({ ok: true });
  },
);

app.get("/api/admin/teams", async (c) => {
  const teams = await db
    .select({
      id: schema.organization.id,
      name: schema.organization.name,
      slug: schema.organization.slug,
      createdAt: schema.organization.createdAt,
      plan: schema.teamSubscriptions.plan,
      status: schema.teamSubscriptions.status,
    })
    .from(schema.organization)
    .leftJoin(schema.teamSubscriptions, eq(schema.organization.id, schema.teamSubscriptions.orgId))
    .orderBy(desc(schema.organization.createdAt));

  const memberCounts = await db
    .select({ orgId: schema.member.organizationId, total: count() })
    .from(schema.member)
    .groupBy(schema.member.organizationId);
  const memberMap = new Map(memberCounts.map((r) => [r.orgId, Number(r.total)]));

  const reviewAgg = await db
    .select({
      orgId: schema.projects.orgId,
      total: count(schema.reviews.id),
      spendUsd: sum(schema.reviews.tokenSpendUsd),
      credits: sum(schema.reviews.creditsCost),
    })
    .from(schema.reviews)
    .innerJoin(schema.projects, eq(schema.reviews.projectId, schema.projects.id))
    .groupBy(schema.projects.orgId);
  const reviewMap = new Map(
    reviewAgg.map((r) => [
      r.orgId,
      {
        reviews: Number(r.total),
        spendUsd: Number(r.spendUsd ?? 0),
        credits: Number(r.credits ?? 0),
      },
    ]),
  );

  return c.json({
    items: teams.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      createdAt: t.createdAt,
      plan: t.plan ?? "free",
      status: t.status ?? "active",
      members: memberMap.get(t.id) ?? 0,
      reviews: reviewMap.get(t.id)?.reviews ?? 0,
      tokenSpendUsd: reviewMap.get(t.id)?.spendUsd ?? 0,
      credits: reviewMap.get(t.id)?.credits ?? 0,
    })),
  });
});

app.notFound((c) => jsonError(c, 404, "not_found", "Not found"));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return jsonError(c, err.status, err.code, err.message);
  }
  console.error("[api] unhandled", err);
  return jsonError(c, 500, "internal_error", err instanceof Error ? err.message : "Internal error");
});

Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
});

console.log(`[api] listening on http://localhost:${env.PORT}`);

export default app;
