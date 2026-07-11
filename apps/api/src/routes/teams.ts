import { randomBytes, randomUUID } from "node:crypto";
import { getReviewGraphDescriptor } from "@codecrawler/agents";
import { verifyByokKey } from "@codecrawler/ai";
import { cancelSubscription, recoverSubscription, startCheckout } from "@codecrawler/billing";
import { db, schema } from "@codecrawler/db";
import { enqueueEmail } from "@codecrawler/email";
import { getUsage } from "@codecrawler/quotas";
import {
  DEFAULT_COVERAGE_STRATEGY,
  DEFAULT_NODE_MODELS,
  type DepthTier,
  decryptSecret,
  encryptSecret,
  env,
  getPlanLimits,
  type PlanId,
  resolveDepthFromMode,
} from "@codecrawler/shared";
import { getVcsProvider } from "@codecrawler/vcs";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { requireOrgAccess, requireOrgAdmin } from "../lib/auth";
import {
  audit,
  countUserMemberships,
  emitPlanChangeEmails,
  getAppSettings,
  getOrgOwnerEmails,
  getOrgPlan,
  getTeamName,
  getTeamSubscription,
  getUserHighestOwnedPlan,
  requirePlan,
} from "../lib/db-helpers";
import {
  extractNodeModels,
  getStoredVcsConnection,
  isMollieConfigured,
  resolveOrgProfile,
  slugify,
} from "../lib/review";
import {
  BILLING_PLAN_CATALOG,
  checkoutSchema,
  createApiKeySchema,
  createProjectSchema,
  createTeamSchema,
  type PROVIDER_VALUES,
  putAgentProfileSchema,
  putGraphNodeSchema,
  vcsConnectSchema,
} from "../lib/schemas";
import { ApiError, type AppEnv, jsonError } from "../lib/types";

export const teamsRouter = new Hono<AppEnv>();

teamsRouter.post(
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

teamsRouter.get("/api/teams", async (c) => {
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

teamsRouter.get("/api/teams/:id", async (c) => {
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

teamsRouter.delete("/api/teams/:id", async (c) => {
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

teamsRouter.get("/api/teams/:id/projects", async (c) => {
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

teamsRouter.post(
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
    await requireOrgAdmin(c, orgId, user.id);
    const body = c.req.valid("json");
    const [project] = await db
      .insert(schema.projects)
      .values({
        orgId,
        name: body.name,
        provider: body.provider,
        repoFullName: body.repoFullName,
        pollingEnabled: body.pollingEnabled ?? false,
      })
      .returning();
    return c.json(project, 201);
  },
);

teamsRouter.delete("/api/teams/:id/projects/:projectId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  const projectId = c.req.param("projectId");
  await requireOrgAdmin(c, orgId, user.id);

  const [existing] = await db
    .select({ id: schema.projects.id, name: schema.projects.name })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, orgId)))
    .limit(1);
  if (!existing) {
    throw new ApiError(404, "not_found", "Project not found");
  }

  await db.transaction(async (tx) => {
    // Removing pull requests first cascades reviews/findings and clears the
    // NO-ACTION profile_id references on agent_profiles.
    await tx.delete(schema.pullRequests).where(eq(schema.pullRequests.projectId, projectId));
    // Order matters: agent_profiles (project_id NO-ACTION) before projects.
    await tx.delete(schema.agentProfiles).where(eq(schema.agentProfiles.projectId, projectId));
    await tx.delete(schema.projects).where(eq(schema.projects.id, projectId));
  });

  await audit(orgId, user.id, "team.project_removed", {
    projectId,
    projectName: existing.name,
  }).catch(() => undefined);

  return c.json({ ok: true });
});

teamsRouter.get("/api/teams/:id/api-keys", async (c) => {
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

teamsRouter.post(
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
    await requireOrgAdmin(c, orgId, user.id);
    const body = c.req.valid("json");
    const encryptedKey = encryptSecret(body.key, { aad: "api_key" });
    let status: "valid" | "invalid" = "invalid";
    try {
      status = (await verifyByokKey(body.provider, body.key)) ? "valid" : "invalid";
    } catch {
      status = "invalid";
    }
    const [row] = await db
      .insert(schema.apiKeys)
      .values({
        orgId,
        provider: body.provider,
        label: body.label,
        encryptedKey,
        status,
        lastVerifiedAt: new Date(),
      })
      .returning({
        id: schema.apiKeys.id,
        provider: schema.apiKeys.provider,
        label: schema.apiKeys.label,
        status: schema.apiKeys.status,
        lastVerifiedAt: schema.apiKeys.lastVerifiedAt,
        createdAt: schema.apiKeys.createdAt,
      });
    await audit(orgId, user.id, "team.api_key_added", { provider: body.provider, status }).catch(
      () => undefined,
    );
    return c.json(row, 201);
  },
);

teamsRouter.delete("/api/teams/:id/api-keys/:provider", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  const provider = c.req.param("provider") as (typeof PROVIDER_VALUES)[number];
  await requireOrgAdmin(c, orgId, user.id);
  await db
    .delete(schema.apiKeys)
    .where(and(eq(schema.apiKeys.provider, provider), eq(schema.apiKeys.orgId, orgId)));
  await audit(orgId, user.id, "team.api_key_removed", { provider }).catch(() => undefined);
  return c.json({ ok: true });
});

teamsRouter.post("/api/teams/:id/api-keys/:provider/verify", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  const provider = c.req.param("provider") as (typeof PROVIDER_VALUES)[number];
  await requireOrgAdmin(c, orgId, user.id);
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
    const plaintext = decryptSecret(latest.encryptedKey, { aad: "api_key" });
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

teamsRouter.get("/api/teams/:id/billing", async (c) => {
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
        plan: schema.teamSubscriptions.plan,
        mollieCustomerId: schema.teamSubscriptions.mollieCustomerId,
        mollieSubscriptionId: schema.teamSubscriptions.mollieSubscriptionId,
        status: schema.teamSubscriptions.status,
      })
      .from(schema.teamSubscriptions)
      .where(eq(schema.teamSubscriptions.orgId, orgId))
      .limit(1);
    if (row?.mollieCustomerId && (!row.mollieSubscriptionId || row.status === "pending")) {
      return (row.plan ?? "free") as PlanId;
    }
    return null;
  })();
  if (needsRecover !== null) {
    try {
      const result = await recoverSubscription(orgId);
      await emitPlanChangeEmails(orgId, needsRecover, result.plan);
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

teamsRouter.post(
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
    await requireOrgAdmin(c, orgId, user.id);
    const body = c.req.valid("json");

    const settings = await getAppSettings();
    if (!settings.paymentsEnabled || !isMollieConfigured()) {
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

teamsRouter.post("/api/teams/:id/billing/cancel", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAdmin(c, orgId, user.id);
  await requirePlan(orgId, "plus");

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

teamsRouter.post("/api/teams/:id/billing/sync", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAdmin(c, orgId, user.id);
  const priorPlan = await getOrgPlan(orgId);
  try {
    const result = await recoverSubscription(orgId);
    await emitPlanChangeEmails(orgId, priorPlan, result.plan);
    return c.json({ ok: true, plan: result.plan, status: result.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Mollie sync failed";
    throw new ApiError(502, "billing_provider_error", msg);
  }
});

teamsRouter.get("/api/teams/:id/agent-profile", async (c) => {
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

teamsRouter.put(
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
    await requireOrgAdmin(c, orgId, user.id);
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

teamsRouter.get("/api/teams/:id/agent-graph/:type", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAccess(c, orgId, user.id);
  const profile = await resolveOrgProfile(orgId, "pr_review");
  const nodeModels = extractNodeModels(profile?.nodeModels);
  return c.json(await getReviewGraphDescriptor({ orgId, nodeModels }));
});

teamsRouter.put(
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
    await requireOrgAdmin(c, orgId, user.id);
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

teamsRouter.get("/api/teams/:id/vcs-connections", async (c) => {
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

teamsRouter.delete("/api/teams/:id/vcs-connections/:connectionId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  const connectionId = c.req.param("connectionId");
  await requireOrgAdmin(c, orgId, user.id);
  const result = await db
    .delete(schema.vcsConnections)
    .where(and(eq(schema.vcsConnections.id, connectionId), eq(schema.vcsConnections.orgId, orgId)))
    .returning({ id: schema.vcsConnections.id, provider: schema.vcsConnections.provider });
  if (result.length === 0) {
    throw new ApiError(404, "not_found", "VCS connection not found");
  }
  await audit(orgId, user.id, "team.vcs_disconnected", { provider: result[0].provider }).catch(
    () => undefined,
  );
  return c.json({ ok: true });
});

teamsRouter.get("/api/teams/:id/vcs-repos", async (c) => {
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

teamsRouter.post(
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
    await requireOrgAdmin(c, orgId, user.id);
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.vcsConnections)
        .where(
          and(eq(schema.vcsConnections.orgId, orgId), eq(schema.vcsConnections.provider, provider)),
        );
      await tx.insert(schema.vcsConnections).values({
        orgId,
        provider,
        kind: "oauth",
        accessToken: encryptSecret(body.token, { aad: "vcs:access_token" }),
        baseUrl: body.baseUrl ?? null,
      });
    });
    await audit(orgId, user.id, "team.vcs_connected", {
      provider,
      kind: "oauth",
      baseUrl: body.baseUrl ?? null,
    });
    return c.json({ ok: true }, 201);
  },
);
