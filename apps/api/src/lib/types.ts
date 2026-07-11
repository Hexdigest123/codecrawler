import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type SessionUser = { id: string; email: string; name: string };

export type SessionInfo = {
  session: { id: string; userId: string; expiresAt: Date };
  user: SessionUser;
};

export type AppEnv = { Variables: { user: SessionUser } };

export class ApiError extends Error {
  status: ContentfulStatusCode;
  code: string;
  constructor(status: ContentfulStatusCode, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export function jsonError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message?: string,
) {
  return c.json({ error: { code, message: message ?? code } }, status);
}
