import { randomUUID } from "node:crypto";
import { db, schema } from "@codecrawler/db";
import { enqueueEmail } from "@codecrawler/email";
import { env, getPlanLimits } from "@codecrawler/shared";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import { requireOrgAccess, requireOrgAdmin } from "../lib/auth";
import {
  audit,
  countUserMemberships,
  getOrgPlan,
  getTeamName,
  getUserEmail,
  getUserHighestOwnedPlan,
} from "../lib/db-helpers";
import { inviteMemberSchema, updateMemberRoleSchema } from "../lib/schemas";
import { ApiError, type AppEnv, jsonError } from "../lib/types";

export const membersRouter = new Hono<AppEnv>();

membersRouter.get("/api/teams/:id/members", async (c) => {
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

membersRouter.post(
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

membersRouter.get("/api/me/invitations", async (c) => {
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

membersRouter.post("/api/invitations/:token/accept", async (c) => {
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

membersRouter.post("/api/invitations/:token/decline", async (c) => {
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

membersRouter.delete("/api/teams/:id/members/:userId", async (c) => {
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

membersRouter.post("/api/teams/:id/members/:userId/leave", async (c) => {
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

membersRouter.patch(
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
