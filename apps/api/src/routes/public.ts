import { auth } from "@codecrawler/auth";
import { createMollieClient, MOLLIE_PLANS, syncPayment } from "@codecrawler/billing";
import { db, schema } from "@codecrawler/db";
import { enqueueEmail } from "@codecrawler/email";
import { type PlanId, planRank } from "@codecrawler/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getOrgOwnerEmails, getTeamName } from "../lib/db-helpers";
import { pingDb, pingRedis } from "../lib/health";
import { checkWebhookDuplicate } from "../lib/rate-limit";
import { pollPullRequestsTick } from "../lib/review";
import { type AppEnv, jsonError } from "../lib/types";

export const publicRouter = new Hono<AppEnv>();

publicRouter.get("/api/health", async (c) => {
  const [dbStatus, redisStatus] = await Promise.all([pingDb(), pingRedis()]);
  const status = dbStatus === "ok" && redisStatus === "ok" ? "ok" : "degraded";
  return c.json({ status, ts: Date.now(), db: dbStatus, redis: redisStatus });
});

publicRouter.get("/api/healthz", (c) => c.json({ status: "ok" }));

publicRouter.all("/api/auth/*", (c) => auth.handler(c.req.raw));

publicRouter.post("/api/payments/webhook", async (c) => {
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
  try {
    const mollie = await createMollieClient();
    const payment = await mollie.payments.get(id);
    const meta = (payment.metadata ?? {}) as { orgId?: string; plan?: PlanId };
    if (meta.orgId) {
      const [row] = await db
        .select({
          plan: schema.teamSubscriptions.plan,
        })
        .from(schema.teamSubscriptions)
        .where(eq(schema.teamSubscriptions.orgId, meta.orgId))
        .limit(1);
      priorPlan = row?.plan ?? null;
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
            newStatus === "failed" ||
            newStatus === "canceled" ||
            newStatus === "expired"
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
publicRouter.post("/api/internal/poll", async (c) => {
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
