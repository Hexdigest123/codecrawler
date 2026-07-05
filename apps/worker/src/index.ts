import type { ReviewInput, ReviewResult } from "@codecrawler/agents";
import { runReview } from "@codecrawler/agents";
import { MOLLIE_PLANS, recoverSubscription } from "@codecrawler/billing";
import { db, schema } from "@codecrawler/db";
import { enqueueEmail } from "@codecrawler/email";
import { QUEUE_NAMES } from "@codecrawler/queue";
import {
  evaluateQuotaThreshold,
  getOrgAdminEmails,
  getUsage,
  periodKey,
  recordUsage,
} from "@codecrawler/quotas";
import { env, type PlanId, planRank } from "@codecrawler/shared";
import { Queue, Worker } from "bullmq";
import { and, eq, inArray, isNotNull, lte, or } from "drizzle-orm";
import IORedis from "ioredis";

type ReviewJobData = ReviewInput & { triggerEmail?: string };
type PaymentsJobData = { orgId: string };

const RECONCILE_JOB = "payments:reconcile";
const PAYMENTS_SYNC_JOB = "payments:sync";
const RECONCILE_CRON = env.NODE_ENV === "development" ? "0 * * * *" : "0 3 * * *";
const RENEWAL_WARNING_JOB = "payments:renewal-warning";
const RENEWAL_WARNING_CRON = env.NODE_ENV === "development" ? "30 * * * *" : "30 9 * * *";
const RENEWAL_WARNING_DAYS = 7;
const POLL_JOB = "poll:pull-requests";
const POLL_CRON = env.PR_POLL_CRON;

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

connection.on("connect", () => {
  console.log(`[worker] connected to redis at ${env.REDIS_URL}`);
});

connection.on("error", (err) => {
  console.error("[worker] redis error", err);
});

const paymentsQueue = new Queue(QUEUE_NAMES.payments, { connection: connection as never });
const scheduledQueue = new Queue(QUEUE_NAMES.scheduled, {
  connection: connection as never,
});

async function markReviewFailed(reviewId: string | undefined, error: string) {
  if (!reviewId) {
    return;
  }
  try {
    await db
      .update(schema.reviews)
      .set({ status: "failed", walkthrough: error, completedAt: new Date() })
      .where(eq(schema.reviews.id, reviewId));
  } catch (err) {
    console.error("[worker] failed to mark review as failed", err);
  }
}

async function getOrgOwnerEmails(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")));
  return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
}

async function notifyQuotaIfCrossed(
  orgId: string,
  kind: "pr_review",
  actorEmail?: string,
): Promise<void> {
  try {
    const { used, limit } = await getUsage(orgId, kind);
    const t = evaluateQuotaThreshold(used, limit);
    if (!t.crossed || limit === null) {
      return;
    }
    const pk = periodKey(kind);
    const action = `quota.${t.crossed}:${kind}:${pk}`;
    const already = await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, action)))
      .limit(1);
    if (already.length > 0) {
      return;
    }
    const emails = await getOrgAdminEmails(orgId);
    const event = t.crossed === "exceeded" ? "quota-exceeded" : "quota-warning";
    const period = "today";
    const payload = {
      kind,
      used,
      limit,
      pct: Math.round(t.pct * 100),
      period,
    };
    for (const email of emails) {
      await enqueueEmail(event, email, payload).catch((err: unknown) => {
        console.error(`[worker] ${event} email failed for ${email}`, err);
      });
    }
    await db.insert(schema.auditLog).values({
      orgId,
      action,
      metadata: {
        kind,
        periodKey: pk,
        threshold: t.crossed,
        used,
        limit,
        actorEmail: actorEmail ?? null,
      },
    });
  } catch (err) {
    console.error(`[worker] quota notify failed org=${orgId} kind=${kind}`, err);
  }
}

async function processReviewJob(job: { data: ReviewJobData }): Promise<ReviewResult> {
  const data = job.data;
  const reviewId = data.reviewId;
  const triggerEmail = data.triggerEmail;

  try {
    const result: ReviewResult = await runReview(data);

    if (result.status === "completed") {
      const credits = Number(result.creditsCost ?? 0);
      if (Number.isFinite(credits) && credits > 0) {
        try {
          await recordUsage(data.orgId, "pr_review", credits);
        } catch (err) {
          console.error("[worker] recordUsage failed", err);
        }
        await notifyQuotaIfCrossed(data.orgId, "pr_review", triggerEmail);
      }
      if (triggerEmail) {
        await enqueueEmail("review-completed", triggerEmail, {
          reviewId,
          walkthrough: result.walkthrough ?? "",
        }).catch((err: unknown) => {
          console.error("[worker] review-completed email failed", err);
        });
      }
      return result;
    }

    if (triggerEmail) {
      await enqueueEmail("review-failed", triggerEmail, {
        reviewId,
        error: result.error ?? "Review did not complete",
      }).catch((err: unknown) => {
        console.error("[worker] review-failed email failed", err);
      });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Worker error";
    await markReviewFailed(reviewId, message);
    if (triggerEmail) {
      await enqueueEmail("review-failed", triggerEmail, {
        reviewId,
        error: message,
      }).catch((emailErr: unknown) => {
        console.error("[worker] review-failed email failed", emailErr);
      });
    }
    throw err;
  }
}

// Quick/static reviews: higher concurrency, each job is short.
const worker = new Worker(QUEUE_NAMES.reviews, processReviewJob, {
  connection: connection as never,
  concurrency: 2,
});

worker.on("failed", (job, err) => {
  console.error(`[worker] reviews job ${job?.id ?? "?"} failed`, err);
});

worker.on("ready", () => {
  console.log(`[worker] reviews worker registered on queue "${QUEUE_NAMES.reviews}"`);
});

// Deep reviews run on an isolated queue so the long agentic loops (12 steps ×
// multiple agents) can't starve quick reviews. Lower concurrency since each
// deep run holds a worker slot for much longer.
const deepWorker = new Worker(QUEUE_NAMES.reviewsDeep, processReviewJob, {
  connection: connection as never,
  concurrency: 1,
});

deepWorker.on("failed", (job, err) => {
  console.error(`[worker] reviews-deep job ${job?.id ?? "?"} failed`, err);
});

deepWorker.on("ready", () => {
  console.log(`[worker] reviews-deep worker registered on queue "${QUEUE_NAMES.reviewsDeep}"`);
});

const paymentsWorker = new Worker(
  QUEUE_NAMES.payments,
  async (job) => {
    const { orgId } = job.data as PaymentsJobData;
    try {
      const [prior] = await db
        .select({
          plan: schema.teamSubscriptions.plan,
          status: schema.teamSubscriptions.status,
          currentPeriodEnd: schema.teamSubscriptions.currentPeriodEnd,
        })
        .from(schema.teamSubscriptions)
        .where(eq(schema.teamSubscriptions.orgId, orgId))
        .limit(1);
      const priorPlan = (prior?.plan ?? "free") as PlanId;
      const priorStatus = prior?.status ?? null;
      const priorEnd = prior?.currentPeriodEnd ?? null;

      // recoverSubscription (not syncSubscription) so orgs whose first
      // webhook was missed (mollieSubscriptionId still null) get relinked
      // and their plan synced from Mollie. This is the backstop that
      // guarantees plan-change emails reach the customer even when the
      // Mollie webhook never reached the API.
      const result = await recoverSubscription(orgId);
      const newPlan = result.plan;
      const newStatus = result.status;

      // Plan / lifecycle transition emails (covers missed webhooks). The
      // priorPlan-vs-newPlan comparison naturally dedupes: once any path
      // updates the DB plan, later syncs see no change and stay quiet.
      if (newPlan !== priorPlan) {
        const ownerEmails = await getOrgOwnerEmails(orgId);
        const planInfo = newPlan !== "free" ? MOLLIE_PLANS[newPlan] : null;
        const amount = planInfo ? `${planInfo.amountEur.toFixed(2)} EUR` : "";
        for (const email of ownerEmails) {
          if (newPlan === "free") {
            await enqueueEmail("plan-downgraded", email, {
              fromPlan: priorPlan,
              toPlan: "free",
            }).catch((err: unknown) => {
              console.warn(`[worker] plan-downgraded email failed for ${orgId}`, err);
            });
          } else if (priorPlan === "free") {
            await enqueueEmail("subscription-started", email, {
              plan: newPlan,
              planName: newPlan,
              amount,
            }).catch((err: unknown) => {
              console.warn(`[worker] subscription-started email failed for ${orgId}`, err);
            });
          } else if (planRank(newPlan) > planRank(priorPlan)) {
            await enqueueEmail("plan-upgraded", email, {
              fromPlan: priorPlan,
              toPlan: newPlan,
            }).catch((err: unknown) => {
              console.warn(`[worker] plan-upgraded email failed for ${orgId}`, err);
            });
          } else if (planRank(newPlan) < planRank(priorPlan)) {
            await enqueueEmail("plan-downgraded", email, {
              fromPlan: priorPlan,
              toPlan: newPlan,
            }).catch((err: unknown) => {
              console.warn(`[worker] plan-downgraded email failed for ${orgId}`, err);
            });
          }
        }
      }

      // Payment-failed notifications for first-payment failures that the
      // webhook guard used to drop (priorStatus === null). Emit on any
      // transition into a failure status.
      if (
        newStatus !== priorStatus &&
        (newStatus === "failed" || newStatus === "canceled" || newStatus === "expired")
      ) {
        const ownerEmails = await getOrgOwnerEmails(orgId);
        for (const email of ownerEmails) {
          await enqueueEmail("payment-failed", email, {}).catch((err: unknown) => {
            console.warn(`[worker] payment-failed email failed for ${orgId}`, err);
          });
        }
      }

      if (priorEnd && newStatus === "active") {
        const [after] = await db
          .select({ currentPeriodEnd: schema.teamSubscriptions.currentPeriodEnd })
          .from(schema.teamSubscriptions)
          .where(eq(schema.teamSubscriptions.orgId, orgId))
          .limit(1);
        const newEnd = after?.currentPeriodEnd ?? null;
        if (newEnd && newEnd.getTime() > priorEnd.getTime()) {
          try {
            const ownerEmails = await getOrgOwnerEmails(orgId);
            const isoEnd = newEnd.toISOString();
            for (const email of ownerEmails) {
              await enqueueEmail("subscription-renewed", email, {
                plan: newPlan,
                planName: newPlan,
                newPeriodEnd: isoEnd,
                date: isoEnd,
              }).catch((err: unknown) => {
                console.warn(`[worker] subscription-renewed email failed for ${orgId}`, err);
              });
            }
          } catch (err) {
            console.warn(`[worker] subscription-renewed dispatch failed for ${orgId}`, err);
          }
        }
      }
    } catch (err) {
      console.error(`[worker] payments sync failed for org ${orgId}`, err);
    }
  },
  { connection: connection as never, concurrency: 4 },
);

paymentsWorker.on("failed", (job, err) => {
  console.error(`[worker] payments job ${job?.id ?? "?"} failed`, err);
});

paymentsWorker.on("ready", () => {
  console.log("[worker] payments worker registered");
});

async function runReconcile() {
  try {
    const rows = await db
      .select({ orgId: schema.teamSubscriptions.orgId })
      .from(schema.teamSubscriptions)
      .where(
        and(
          isNotNull(schema.teamSubscriptions.mollieCustomerId),
          or(
            isNotNull(schema.teamSubscriptions.mollieSubscriptionId),
            inArray(schema.teamSubscriptions.status, ["active", "pending"]),
          ),
        ),
      );
    for (const row of rows) {
      try {
        await paymentsQueue.add(PAYMENTS_SYNC_JOB, { orgId: row.orgId });
      } catch (err) {
        console.error(`[worker] reconcile: failed to enqueue payments job for ${row.orgId}`, err);
      }
    }
    console.log(`[worker] payments:reconcile enqueued ${rows.length} payments job(s)`);
  } catch (err) {
    console.error("[worker] payments:reconcile tick failed", err);
    throw err;
  }
}

/**
 * Daily heads-up: for every active subscription whose next renewal falls
 * within RENEWAL_WARNING_DAYS, email the owners a "renewing soon" notice.
 * Deduped per (org, period-end) via the audit log so each renewal is
 * announced at most once.
 */
async function runRenewalWarning() {
  try {
    const cutoff = new Date(Date.now() + RENEWAL_WARNING_DAYS * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        orgId: schema.teamSubscriptions.orgId,
        plan: schema.teamSubscriptions.plan,
        currentPeriodEnd: schema.teamSubscriptions.currentPeriodEnd,
      })
      .from(schema.teamSubscriptions)
      .where(
        and(
          eq(schema.teamSubscriptions.status, "active"),
          isNotNull(schema.teamSubscriptions.currentPeriodEnd),
          lte(schema.teamSubscriptions.currentPeriodEnd, cutoff),
        ),
      );
    let notified = 0;
    for (const row of rows) {
      const periodEnd = row.currentPeriodEnd;
      if (!periodEnd || periodEnd.getTime() <= Date.now()) {
        continue;
      }
      const periodKey = periodEnd.toISOString().slice(0, 10);
      const action = `billing.email:renewal-warning:${periodKey}`;
      const [existing] = await db
        .select({ id: schema.auditLog.id })
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.orgId, row.orgId), eq(schema.auditLog.action, action)))
        .limit(1);
      if (existing) {
        continue;
      }
      try {
        const ownerEmails = await getOrgOwnerEmails(row.orgId);
        const planInfo =
          row.plan !== "free" ? MOLLIE_PLANS[row.plan as Exclude<PlanId, "free">] : null;
        const amount = planInfo ? `${planInfo.amountEur.toFixed(2)} EUR` : "";
        for (const email of ownerEmails) {
          await enqueueEmail("subscription-renewing", email, {
            plan: row.plan,
            planName: row.plan,
            amount,
            renewalDate: periodEnd.toISOString(),
            date: periodEnd.toISOString(),
          }).catch((err: unknown) => {
            console.warn(`[worker] subscription-renewing email failed for ${row.orgId}`, err);
          });
        }
        await db
          .insert(schema.auditLog)
          .values({ orgId: row.orgId, action, metadata: { periodEnd: periodEnd.toISOString() } })
          .onConflictDoNothing();
        notified++;
      } catch (err) {
        console.warn(`[worker] renewal-warning dispatch failed for ${row.orgId}`, err);
      }
    }
    console.log(`[worker] payments:renewal-warning notified ${notified} org(s)`);
  } catch (err) {
    console.error("[worker] payments:renewal-warning tick failed", err);
    throw err;
  }
}

/**
 * Polling tick: calls the API's internal /api/internal/poll endpoint, which
 * lists open PRs for every project with polling_enabled=true and enqueues a
 * review for any whose head sha hasn't been reviewed yet. The auth + enqueue
 * logic lives in the API (single source of truth); the worker just triggers
 * it on a cron and surfaces failures. Skipped silently when INTERNAL_API_KEY
 * is unset (the feature is opt-in).
 */
async function runPollTick(): Promise<void> {
  const apiKey = env.INTERNAL_API_KEY;
  if (!apiKey) {
    return;
  }
  const baseUrl = (env.INTERNAL_API_URL ?? env.PUBLIC_API_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/api/internal/poll`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-internal-key": apiKey, "content-type": "application/json" },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[worker] poll tick -> ${res.status} ${url}: ${text.slice(0, 200) || res.statusText}`,
      );
      return;
    }
    const body = (await res.json().catch(() => null)) as {
      projects?: number;
      enqueued?: number;
      skipped?: number;
      errors?: number;
    } | null;
    console.log(
      `[worker] poll tick: projects=${body?.projects ?? 0} enqueued=${body?.enqueued ?? 0} skipped=${body?.skipped ?? 0} errors=${body?.errors ?? 0}`,
    );
  } catch (err) {
    console.warn(`[worker] poll tick failed (${url})`, err instanceof Error ? err.message : err);
  }
}

const scheduledWorker = new Worker(
  QUEUE_NAMES.scheduled,
  async (job) => {
    if (job.name === RECONCILE_JOB) {
      await runReconcile();
    } else if (job.name === RENEWAL_WARNING_JOB) {
      await runRenewalWarning();
    } else if (job.name === POLL_JOB) {
      await runPollTick();
    }
  },
  { connection: connection as never, concurrency: 1 },
);

scheduledWorker.on("failed", (job, err) => {
  console.error(`[worker] scheduled job ${job?.id ?? "?"} failed`, err);
});

async function registerScheduledJobs() {
  const existing = await scheduledQueue.getRepeatableJobs();
  for (const r of existing) {
    if (r.name === RECONCILE_JOB || r.name === RENEWAL_WARNING_JOB || r.name === POLL_JOB) {
      await scheduledQueue.removeRepeatableByKey(r.key);
    }
  }
  await scheduledQueue.add(
    RECONCILE_JOB,
    {},
    {
      repeat: { pattern: RECONCILE_CRON, tz: "UTC" },
    },
  );
  await scheduledQueue.add(
    RENEWAL_WARNING_JOB,
    {},
    {
      repeat: { pattern: RENEWAL_WARNING_CRON, tz: "UTC" },
    },
  );
  await scheduledQueue.add(
    POLL_JOB,
    {},
    {
      repeat: { pattern: POLL_CRON, tz: "UTC" },
    },
  );
  console.log(
    `[worker] scheduled jobs registered (reconcile=${RECONCILE_CRON}, renewal-warning=${RENEWAL_WARNING_CRON}, poll=${POLL_CRON})`,
  );
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[worker] received ${signal}, shutting down`);
  await worker.close().catch(() => undefined);
  await deepWorker.close().catch(() => undefined);
  await paymentsWorker.close().catch(() => undefined);
  await scheduledWorker.close().catch(() => undefined);
  await paymentsQueue.close().catch(() => undefined);
  await scheduledQueue.close().catch(() => undefined);
  await connection.quit().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await registerScheduledJobs();

await new Promise<never>(() => {});
