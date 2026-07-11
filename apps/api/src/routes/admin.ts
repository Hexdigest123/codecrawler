import { db, schema } from "@codecrawler/db";
import { enqueueEmail } from "@codecrawler/email";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, sql, sum } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { isAdmin } from "../lib/auth";
import { audit, getAdminEmails, getAppSettings } from "../lib/db-helpers";
import { isMollieConfigured } from "../lib/review";
import { ApiError, type AppEnv, jsonError, type SessionUser } from "../lib/types";

export const adminRouter = new Hono<AppEnv>();

const requireAdminMiddleware: MiddlewareHandler = async (c, next) => {
  const user = c.get("user") as SessionUser;
  if (!(await isAdmin(user.id))) {
    throw new ApiError(403, "admin_required", "Administrator access required");
  }
  await next();
};

adminRouter.use("/api/admin/*", requireAdminMiddleware);

adminRouter.use("/api/admin/*", requireAdminMiddleware);

adminRouter.get("/api/admin/settings", async (c) => {
  const settings = await getAppSettings();
  return c.json({
    signupMode: settings.signupMode,
    allowedDomains: settings.allowedDomains ?? [],
    paymentsEnabled: settings.paymentsEnabled,
    mollieConfigured: isMollieConfigured(),
    updatedAt: settings.updatedAt,
  });
});

const updateSettingsSchema = z.object({
  signupMode: z.enum(["open", "closed", "domain_restricted", "approval"]).optional(),
  allowedDomains: z.array(z.string().min(1)).optional(),
  paymentsEnabled: z.boolean().optional(),
});

adminRouter.patch(
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
      mollieConfigured: isMollieConfigured(),
      updatedAt: updated?.updatedAt ?? new Date(),
    });
  },
);

adminRouter.get("/api/admin/stats", async (c) => {
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
    paymentsEnabled: settings.paymentsEnabled && isMollieConfigured(),
    mollieConfigured: isMollieConfigured(),
  });
});

adminRouter.get("/api/admin/users", async (c) => {
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

adminRouter.patch(
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

adminRouter.patch(
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

adminRouter.get("/api/admin/signup-requests", async (c) => {
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

adminRouter.post("/api/admin/signup-requests/:id/approve", async (c) => {
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

adminRouter.post(
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

adminRouter.get("/api/admin/teams", async (c) => {
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
