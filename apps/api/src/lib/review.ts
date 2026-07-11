import type { NodeModels, ReviewInput } from "@codecrawler/agents";
import { db, schema } from "@codecrawler/db";
import { makeQueue, QUEUE_NAMES } from "@codecrawler/queue";
import { getTeamPlan } from "@codecrawler/quotas";
import {
  DEFAULT_COVERAGE_STRATEGY,
  DEFAULT_NODE_MODELS,
  type DepthTier,
  decryptSecret,
  env,
  planRank,
  resolveDepthFromMode,
} from "@codecrawler/shared";
import type { VcsAuth } from "@codecrawler/vcs";
import { getVcsProvider } from "@codecrawler/vcs";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ApiError } from "./types";

export type ReviewJobData = ReviewInput & {
  triggerEmail?: string;
};

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function isPublicApiPath(path: string): boolean {
  if (path === "/api/health" || path === "/api/healthz") return true;
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return true;
  if (path === "/api/payments" || path.startsWith("/api/payments/")) return true;
  if (path === "/api/sso/resolve") return true;
  if (path === "/api/signup-config") return true;
  // Internal endpoints are authenticated via a shared secret header instead
  // of a user session (called by the worker's poll scheduler).
  if (path === "/api/internal" || path.startsWith("/api/internal/")) return true;
  return false;
}

/**
 * Billing is auto-disabled when any Mollie env key is missing. The DB-backed
 * `paymentsEnabled` flag remains the admin's intent; this is the operator gate
 * that overrides it when Mollie is not wired up (e.g. fresh dev install).
 */
export function isMollieConfigured(): boolean {
  return (
    Boolean(env.MOLLIE_API_KEY?.trim()) &&
    Boolean(env.MOLLIE_REDIRECT_URL?.trim()) &&
    Boolean(env.MOLLIE_WEBHOOK_URL?.trim())
  );
}

export function extractNodeModels(raw: unknown): NodeModels {
  const obj = (raw as Record<string, unknown> | null) ?? {};
  return {
    orchestrator:
      typeof obj.orchestrator === "string" ? obj.orchestrator : DEFAULT_NODE_MODELS.orchestrator,
    reviewer: typeof obj.reviewer === "string" ? obj.reviewer : DEFAULT_NODE_MODELS.reviewer,
    summarizer:
      typeof obj.summarizer === "string" ? obj.summarizer : DEFAULT_NODE_MODELS.summarizer,
  };
}

export async function resolveOrgProfile(orgId: string, graphType: "pr_review") {
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
export function pickDepthTier(
  requested?: DepthTier | null,
  profileDefault?: DepthTier | null,
): DepthTier {
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
 * require Plus/Pro; comment triggers can't return a 402, so an
 * ineligible deep request silently downgrades to quick (the manual endpoint
 * gates explicitly before calling this). Deep runs land on a dedicated
 * `reviews:deep` queue so the long agent loops can't starve quick reviews.
 */
export async function resolveEnqueueDepth(
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

export async function getStoredVcsConnection(
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
      token: decryptSecret(conn.accessToken, { aad: "vcs:access_token" }),
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
export async function resolveReviewAuth(opts: {
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
export async function prefetchPrMeta(opts: {
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

export async function upsertPullAndEnqueueReview(opts: {
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
  source?: "manual" | "synthetic" | "comment" | "poll";
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

  const source: "manual" | "synthetic" | "comment" | "poll" =
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

/**
 * Check whether a PR has already been reviewed (or is currently being
 * reviewed) at this exact head sha. Returns true when a matching review
 * exists, so the caller can skip re-enqueuing.
 */
export async function isPullReviewedAtSha(
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

// ---------------------------------------------------------------------------
// PR polling tick
//
// The worker's scheduler calls POST /api/internal/poll on a cron (default
// every 5 min). For each project with pollingEnabled=true that has a stored
// VCS connection, we list open PRs and enqueue a review for any whose head
// sha hasn't been reviewed yet (or has new commits since the last review).
// This is the primary discovery mechanism — useful for self-hosted VCS
// behind a firewall or any environment without inbound connectivity.
// ---------------------------------------------------------------------------

export async function pollPullRequestsTick(): Promise<{
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
