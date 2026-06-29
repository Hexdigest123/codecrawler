import type { ReviewInput, ReviewResult, SecurityInput, SecurityResult } from "@codecrawler/agents";
import { runReview, runSecurity } from "@codecrawler/agents";
import { syncSubscription } from "@codecrawler/billing";
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
import { env } from "@codecrawler/shared";
import { Queue, Worker } from "bullmq";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import IORedis from "ioredis";

type ReviewJobData = ReviewInput & { triggerEmail?: string };
type SecurityJobData = SecurityInput;
type PaymentsJobData = { orgId: string };

const RECONCILE_JOB = "payments:reconcile";
const PAYMENTS_SYNC_JOB = "payments:sync";
const RECONCILE_CRON = env.NODE_ENV === "development" ? "0 * * * *" : "0 3 * * *";

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

async function markSecurityReportFailed(reportId: string | undefined, error: string) {
  if (!reportId) {
    return;
  }
  try {
    await db
      .update(schema.securityReports)
      .set({ status: "failed", summary: error })
      .where(eq(schema.securityReports.id, reportId));
  } catch (err) {
    console.error("[worker] failed to mark security report as failed", err);
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
  kind: "pr_review" | "security_review",
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
    const period = kind === "pr_review" ? "today" : "this week";
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

const worker = new Worker(
  QUEUE_NAMES.reviews,
  async (job) => {
    const data = job.data as ReviewJobData;
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
  },
  { connection: connection as never, concurrency: 2 },
);

worker.on("failed", (job, err) => {
  console.error(`[worker] reviews job ${job?.id ?? "?"} failed`, err);
});

worker.on("ready", () => {
  console.log(`[worker] reviews worker registered on queue "${QUEUE_NAMES.reviews}"`);
});

const securityWorker = new Worker(
  QUEUE_NAMES.security,
  async (job) => {
    const data = job.data as SecurityJobData;
    const reportId = data.reportId;
    const triggerEmail = data.triggerEmail;

    try {
      const result: SecurityResult = await runSecurity(data);

      if (result.status === "completed") {
        const credits = Number(result.creditsCost ?? 0);
        if (Number.isFinite(credits) && credits > 0) {
          try {
            await recordUsage(data.orgId, "security_review", credits);
          } catch (err) {
            console.error("[worker] recordUsage (security) failed", err);
          }
          await notifyQuotaIfCrossed(data.orgId, "security_review", triggerEmail);
        }
        if (triggerEmail) {
          const criticalCount =
            result.findings?.filter((f) => f.severity === "critical").length ?? 0;
          if (criticalCount > 0) {
            await enqueueEmail("critical-finding-alert", triggerEmail, {
              projectId: data.projectId,
              reportId,
              summary: result.summary ?? "",
              count: criticalCount,
            }).catch((err: unknown) => {
              console.error("[worker] critical-finding-alert email failed", err);
            });
          } else {
            await enqueueEmail("security-scan-completed", triggerEmail, {
              projectId: data.projectId,
              reportId,
              summary: result.summary ?? "",
            }).catch((err: unknown) => {
              console.error("[worker] security-scan-completed email failed", err);
            });
          }
        }
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Worker error";
      await markSecurityReportFailed(reportId, message);
      throw err;
    }
  },
  { connection: connection as never, concurrency: 2 },
);

securityWorker.on("failed", (job, err) => {
  console.error(`[worker] security job ${job?.id ?? "?"} failed`, err);
});

securityWorker.on("ready", () => {
  console.log(`[worker] security worker registered on queue "${QUEUE_NAMES.security}"`);
});

const paymentsWorker = new Worker(
  QUEUE_NAMES.payments,
  async (job) => {
    const { orgId } = job.data as PaymentsJobData;
    try {
      const [prior] = await db
        .select({
          currentPeriodEnd: schema.teamSubscriptions.currentPeriodEnd,
        })
        .from(schema.teamSubscriptions)
        .where(eq(schema.teamSubscriptions.orgId, orgId))
        .limit(1);
      const priorEnd = prior?.currentPeriodEnd ?? null;

      const result = await syncSubscription(orgId);

      if (priorEnd && result.status === "active") {
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
                plan: result.plan,
                planName: result.plan,
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
          isNotNull(schema.teamSubscriptions.mollieSubscriptionId),
          inArray(schema.teamSubscriptions.status, ["active", "pending"]),
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

const scheduledWorker = new Worker(
  QUEUE_NAMES.scheduled,
  async (job) => {
    if (job.name === RECONCILE_JOB) {
      await runReconcile();
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
    if (r.name === RECONCILE_JOB) {
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
  console.log("[worker] scheduled jobs registered");
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[worker] received ${signal}, shutting down`);
  await worker.close().catch(() => undefined);
  await securityWorker.close().catch(() => undefined);
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
