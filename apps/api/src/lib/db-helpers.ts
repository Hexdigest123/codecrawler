import { MOLLIE_PLANS } from "@codecrawler/billing";
import { db, schema } from "@codecrawler/db";
import { enqueueEmail } from "@codecrawler/email";
import { type PlanId, planRank } from "@codecrawler/shared";
import { and, eq, inArray } from "drizzle-orm";
import { ApiError } from "./types";

export async function getTeamSubscription(orgId: string) {
  const rows = await db
    .select()
    .from(schema.teamSubscriptions)
    .where(eq(schema.teamSubscriptions.orgId, orgId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getOrgPlan(orgId: string): Promise<PlanId> {
  const sub = await getTeamSubscription(orgId);
  return (sub?.plan ?? "free") as PlanId;
}

export async function getAppSettings() {
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

export async function getAdminEmails(): Promise<string[]> {
  const rows = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.role, "admin"));
  return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
}

export async function getTeamName(orgId: string): Promise<string> {
  const [org] = await db
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .limit(1);
  return org?.name ?? "";
}

export async function getUserEmail(userId: string): Promise<string | null> {
  const [u] = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return u?.email ?? null;
}

export async function getOrgOwnerEmails(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")));
  return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
}

export async function hasValidByokKey(orgId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.orgId, orgId), eq(schema.apiKeys.status, "valid")))
    .limit(1);
  return rows.length > 0;
}

export async function countUserMemberships(userId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(eq(schema.member.userId, userId));
  return rows.length;
}

export async function getUserHighestOwnedPlan(userId: string): Promise<PlanId> {
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

export async function audit(
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

export async function requirePlan(orgId: string, minPlan: "plus" | "pro"): Promise<void> {
  const plan = await getOrgPlan(orgId);
  if (planRank(plan) < planRank(minPlan)) {
    throw new ApiError(403, "plan_required", `Requires ${minPlan} or higher`);
  }
}

export async function emitPlanChangeEmails(
  orgId: string,
  priorPlan: PlanId,
  newPlan: PlanId,
): Promise<void> {
  if (priorPlan === newPlan) {
    return;
  }
  try {
    const ownerEmails = await getOrgOwnerEmails(orgId);
    if (ownerEmails.length === 0) {
      return;
    }
    const teamName = await getTeamName(orgId);
    const planInfo = newPlan !== "free" ? MOLLIE_PLANS[newPlan] : null;
    const amount = planInfo ? `${planInfo.amountEur.toFixed(2)} EUR` : "";
    for (const email of ownerEmails) {
      if (newPlan === "free") {
        await enqueueEmail("plan-downgraded", email, {
          fromPlan: priorPlan,
          toPlan: "free",
          teamName,
        });
      } else if (priorPlan === "free") {
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
      } else {
        await enqueueEmail("plan-downgraded", email, {
          fromPlan: priorPlan,
          toPlan: newPlan,
          teamName,
        });
      }
    }
  } catch (err) {
    console.warn("[api] plan change email dispatch failed", err);
  }
}
