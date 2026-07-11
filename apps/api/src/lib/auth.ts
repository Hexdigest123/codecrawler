import { auth } from "@codecrawler/auth";
import { db, schema } from "@codecrawler/db";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { ApiError, type SessionInfo, type SessionUser } from "./types";

export async function getSession(c: Context): Promise<SessionInfo | null> {
  const r = await auth.api.getSession({ headers: c.req.raw.headers });
  return r as unknown as SessionInfo | null;
}

export async function requireSession(c: Context): Promise<SessionUser> {
  const s = await getSession(c);
  if (!s) {
    throw new ApiError(401, "unauthorized", "Authentication required");
  }
  return s.user;
}

export async function requireOrgAccess(_c: Context, orgId: string, userId: string): Promise<void> {
  const rows = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
    .limit(1);
  if (!rows.length) {
    throw new ApiError(403, "forbidden", "Not a member of this team");
  }
}

export async function requireOrgAdmin(_c: Context, orgId: string, userId: string): Promise<void> {
  const rows = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
    .limit(1);
  if (!rows.length) {
    throw new ApiError(403, "forbidden", "Not a member of this team");
  }
  const role = rows[0].role;
  if (role !== "owner" && role !== "admin") {
    throw new ApiError(403, "forbidden", "Only owners or admins can perform this action");
  }
}

export async function isAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: schema.user.role })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return row?.role === "admin";
}

export async function requireAdmin(c: Context): Promise<SessionUser> {
  const user = c.get("user") as SessionUser;
  if (!(await isAdmin(user.id))) {
    throw new ApiError(403, "admin_required", "Administrator access required");
  }
  return user;
}
