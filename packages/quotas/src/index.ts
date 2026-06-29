import { db, schema } from "@codecrawler/db";
import type { DepthTier, PlanId } from "@codecrawler/shared";
import {
  env,
  getPlanLimits,
  isHostedAllowedForPlan,
  isModelEligibleForPlan,
  isUnlimited,
  PLAN_LIMITS,
  planRank,
} from "@codecrawler/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

export type QuotaKind = "pr_review";
export type BillingMode = "hosted" | "byok" | "mixed";

export {
  getPlanLimits,
  isHostedAllowedForPlan,
  isModelEligibleForPlan,
  isUnlimited,
  PLAN_LIMITS,
  planRank,
};

export interface QuotaState {
  used: number;
  limit: number | null;
}

export interface QuotaCheckResult extends QuotaState {
  allowed: boolean;
  reason?: string;
  message?: string;
}

export interface ReviewCostInput {
  orchestratorWeight: number;
  reviewerWeight: number;
  summarizerWeight: number;
  sliceCount: number;
}

export function periodKey(kind: QuotaKind, date: Date = new Date()): string {
  if (kind === "pr_review") return formatUtcDate(date);
  const { year, week } = getIsoWeek(date);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export async function getTeamPlan(orgId: string): Promise<PlanId> {
  const rows = await db
    .select({ plan: schema.teamSubscriptions.plan })
    .from(schema.teamSubscriptions)
    .where(eq(schema.teamSubscriptions.orgId, orgId))
    .limit(1);
  return rows[0]?.plan ?? "free";
}

export async function getUsage(orgId: string, kind: QuotaKind): Promise<QuotaState> {
  const pk = periodKey(kind);
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${schema.usage.credits}), 0)` })
    .from(schema.usage)
    .where(
      and(
        eq(schema.usage.orgId, orgId),
        eq(schema.usage.kind, kind),
        eq(schema.usage.periodKey, pk),
      ),
    );
  const raw = rows[0]?.total;
  const used = raw === undefined || raw === null ? 0 : Number.parseFloat(String(raw)) || 0;
  const plan = await getTeamPlan(orgId);
  const limits = getPlanLimits(plan);
  const limit = limits.hostedReviewsPerDay;
  return { used, limit };
}

export async function checkQuota(
  orgId: string,
  kind: QuotaKind,
  projectedCost: number,
  opts: { billingMode?: BillingMode } = {},
): Promise<QuotaCheckResult> {
  if (opts.billingMode === "byok") {
    return { allowed: true, used: 0, limit: null };
  }
  const plan = await getTeamPlan(orgId);
  if (!isHostedAllowedForPlan(plan)) {
    return {
      allowed: false,
      reason: "free_byok_only",
      used: 0,
      limit: 0,
      message: "Free plan is BYOK-only — add your own API key or upgrade",
    };
  }
  const { used, limit } = await getUsage(orgId, kind);
  if (isUnlimited(limit)) {
    return { allowed: true, used, limit };
  }
  if (used + projectedCost <= (limit as number)) {
    return { allowed: true, used, limit };
  }
  return { allowed: false, reason: "quota_exceeded", used, limit };
}

export async function recordUsage(
  orgId: string,
  kind: QuotaKind,
  credits: number,
  date: Date = new Date(),
): Promise<void> {
  const pk = periodKey(kind, date);
  await db
    .insert(schema.usage)
    .values({
      orgId,
      kind,
      periodKey: pk,
      credits: String(credits),
      date,
    })
    .onConflictDoUpdate({
      target: [schema.usage.orgId, schema.usage.kind, schema.usage.periodKey],
      set: {
        credits: sql<string>`${schema.usage.credits} + ${credits}`,
      },
    });
}

export function computeReviewCost(input: ReviewCostInput): number {
  const cost =
    0.5 * input.orchestratorWeight +
    input.sliceCount * input.reviewerWeight +
    0.5 * input.summarizerWeight;
  return Math.max(1, Math.round(cost * 100) / 100);
}

/**
 * Conservative pre-run credit projection for the daily quota preflight. The
 * static path charges model-weight units via {@link computeReviewCost}; the
 * agentic path charges real token spend at the metered rate
 * (spendUsd × CREDITS_PER_USD). We don't know the real spend until the run
 * finishes, so the preflight reserves the tier's spend CEILING
 * (REVIEW_AGENT_BUDGET_USD_*) converted to credits — the agent loop hard-caps
 * spend at exactly that budget, so this can never under-reserve. The actual
 * charge recorded after the run is lower (real spend), never higher.
 */
export function projectReviewCost(depth: DepthTier): number {
  if (depth === "static") {
    return computeReviewCost({
      orchestratorWeight: 1,
      reviewerWeight: 1,
      summarizerWeight: 1,
      sliceCount: 1,
    });
  }
  const budgetUsd =
    depth === "deep" ? env.REVIEW_AGENT_BUDGET_USD_DEEP : env.REVIEW_AGENT_BUDGET_USD_QUICK;
  const credits = budgetUsd * env.CREDITS_PER_USD;
  return Math.max(1, Math.round(credits * 100) / 100);
}

/**
 * Convert real token spend (USD) into metered credits for an agentic review.
 * Rounded to 4 dp to match the precision of the credits_cost column. BYOK runs
 * return 0 (the team pays its own model provider directly).
 */
export function creditsFromSpend(spendUsd: number, billingMode: BillingMode): number {
  if (billingMode === "byok") return 0;
  return Math.round(spendUsd * env.CREDITS_PER_USD * 10000) / 10000;
}

function formatUtcDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getIsoWeek(date: Date): { year: number; week: number } {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: utc.getUTCFullYear(), week };
}

export interface QuotaThreshold {
  crossed: "warning" | "exceeded" | null;
  used: number;
  limit: number | null;
  pct: number;
}

export function evaluateQuotaThreshold(used: number, limit: number | null): QuotaThreshold {
  if (limit === null) {
    return { crossed: null, used, limit: null, pct: 0 };
  }
  const pct = limit > 0 ? used / limit : 0;
  let crossed: QuotaThreshold["crossed"] = null;
  if (used >= limit) {
    crossed = "exceeded";
  } else if (pct >= 0.8) {
    crossed = "warning";
  }
  return { crossed, used, limit, pct };
}

export async function getOrgAdminEmails(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(
      and(eq(schema.member.organizationId, orgId), inArray(schema.member.role, ["owner", "admin"])),
    );
  return rows.map((r) => r.email);
}
