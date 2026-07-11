import { db, schema } from "@codecrawler/db";
import { checkQuota, getTeamPlan, projectReviewCost } from "@codecrawler/quotas";
import { planRank } from "@codecrawler/shared";
import { getVcsProvider } from "@codecrawler/vcs";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { z } from "zod";
import { requireOrgAccess } from "../lib/auth";
import { hasValidByokKey } from "../lib/db-helpers";
import {
  pickDepthTier,
  resolveOrgProfile,
  resolveReviewAuth,
  upsertPullAndEnqueueReview,
} from "../lib/review";
import { triggerReviewSchema } from "../lib/schemas";
import { ApiError, type AppEnv } from "../lib/types";

export const projectsRouter = new Hono<AppEnv>();

projectsRouter.get("/api/projects/:id/pulls", async (c) => {
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

projectsRouter.get("/api/projects/:id/pulls/open", async (c) => {
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

projectsRouter.get("/api/projects/:id/reviews", async (c) => {
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

projectsRouter.post("/api/projects/:id/pulls/:n/review", async (c) => {
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
    // dashboard gets a clear error (comment triggers downgrade silently
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

projectsRouter.get("/api/reviews/:id", async (c) => {
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
