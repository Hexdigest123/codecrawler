import { auth } from "@codecrawler/auth";
import { db, schema } from "@codecrawler/db";
import {
  enqueueEmail,
  getNotificationSettings,
  upsertNotificationSettings,
} from "@codecrawler/email";
import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { audit } from "../lib/db-helpers";
import {
  changeEmailSchema,
  changePasswordSchema,
  disable2faSchema,
  enable2faSchema,
  notificationSettingsSchema,
  verify2faSchema,
} from "../lib/schemas";
import { type AppEnv, jsonError } from "../lib/types";

export const meRouter = new Hono<AppEnv>();

meRouter.get("/api/me", async (c) => {
  const user = c.get("user");
  const memberships = await db
    .select({
      orgId: schema.organization.id,
      orgName: schema.organization.name,
      orgSlug: schema.organization.slug,
      role: schema.member.role,
      plan: schema.teamSubscriptions.plan,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .leftJoin(schema.teamSubscriptions, eq(schema.organization.id, schema.teamSubscriptions.orgId))
    .where(eq(schema.member.userId, user.id));

  const teams = memberships.map((m) => ({
    organization: { id: m.orgId, name: m.orgName, slug: m.orgSlug },
    role: m.role,
    plan: m.plan ?? "free",
  }));

  const [meRow] = await db
    .select({ role: schema.user.role, status: schema.user.status })
    .from(schema.user)
    .where(eq(schema.user.id, user.id))
    .limit(1);

  return c.json({
    user: { id: user.id, email: user.email, name: user.name },
    role: meRow?.role ?? "user",
    status: meRow?.status ?? "active",
    teams,
  });
});

meRouter.post(
  "/api/me/password",
  zValidator("json", changePasswordSchema, (result, c) => {
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
    try {
      await auth.api.changePassword({
        body: {
          newPassword: body.newPassword,
          currentPassword: body.currentPassword,
          revokeOtherSessions: false,
        },
        headers: c.req.raw.headers,
      });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      const message = err instanceof Error ? err.message : "Password change failed";
      return jsonError(c, status as ContentfulStatusCode, "password_change_failed", message);
    }
    await enqueueEmail("password-changed", user.email, {
      name: user.name,
    }).catch((err: unknown) => {
      console.warn("[api] password-changed email failed", err);
    });
    await audit(null, user.id, "account.password_changed", {}).catch(() => undefined);
    return c.json({ ok: true });
  },
);

meRouter.post(
  "/api/me/email",
  zValidator("json", changeEmailSchema, (result, c) => {
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
    const oldEmail = user.email;

    try {
      await auth.api.changeEmail({
        body: { newEmail: body.newEmail },
        headers: c.req.raw.headers,
      });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      const message = err instanceof Error ? err.message : "Email change failed";
      return jsonError(c, status as ContentfulStatusCode, "email_change_failed", message);
    }

    await Promise.all([
      enqueueEmail("email-changed", oldEmail, {
        newEmail: body.newEmail,
        name: user.name,
      }).catch((err: unknown) => {
        console.warn("[api] email-changed (old) failed", err);
      }),
      enqueueEmail("email-changed", body.newEmail, {
        newEmail: body.newEmail,
        name: user.name,
      }).catch((err: unknown) => {
        console.warn("[api] email-changed (new) failed", err);
      }),
    ]);
    await audit(null, user.id, "account.email_changed", {
      oldEmail,
      newEmail: body.newEmail,
    }).catch(() => undefined);

    return c.json({ ok: true });
  },
);

meRouter.get("/api/me/notifications", async (c) => {
  const user = c.get("user");
  const settings = await getNotificationSettings(user.id);
  return c.json({ settings });
});

meRouter.put(
  "/api/me/notifications",
  zValidator("json", notificationSettingsSchema, (result, c) => {
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
    const settings = await upsertNotificationSettings(user.id, body);
    await audit(null, user.id, "account.notification_settings_updated", { settings }).catch(
      () => undefined,
    );
    return c.json({ settings });
  },
);

// ---------------------------------------------------------------------------
// Two-factor authentication (TOTP authenticator app)
//
// Better Auth's `twoFactor` plugin exposes the heavy lifting via the auth
// handler (/api/auth/two-factor/*), but the management endpoints are wrapped
// here so we can attach audit-log entries and the 2fa-enabled / 2fa-disabled
// notification emails. The sign-in second-factor verification is NOT here: it
// happens before there is a full session, so the client calls the plugin's
// verifyTOTP endpoint directly from the /two-factor page.
//
// Flow:
//   1. POST /api/me/2fa/enable {password}  -> {totpURI, backupCodes} (unverified)
//   2. user scans the QR, then POST /api/me/2fa/verify {code} -> marks verified
//   3. POST /api/me/2fa/disable {password}  -> removes 2FA
// ---------------------------------------------------------------------------

meRouter.get("/api/me/2fa", async (c) => {
  const user = c.get("user");
  const [row] = await db
    .select({ verified: schema.twoFactor.verified })
    .from(schema.twoFactor)
    .where(eq(schema.twoFactor.userId, user.id))
    .limit(1);
  return c.json({ enabled: row?.verified === true });
});

meRouter.post(
  "/api/me/2fa/enable",
  zValidator("json", enable2faSchema, (result, c) => {
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
    const body = c.req.valid("json");
    try {
      const res = (await auth.api.enableTwoFactor({
        body: { password: body.password },
        headers: c.req.raw.headers,
      })) as { totpURI?: string; backupCodes?: string[] };
      return c.json({
        totpURI: res.totpURI ?? null,
        backupCodes: res.backupCodes ?? [],
      });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      const message = err instanceof Error ? err.message : "Could not enable 2FA";
      return jsonError(c, status as ContentfulStatusCode, "2fa_enable_failed", message);
    }
  },
);

meRouter.post(
  "/api/me/2fa/verify",
  zValidator("json", verify2faSchema, (result, c) => {
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
    try {
      await auth.api.verifyTOTP({
        body: { code: body.code },
        headers: c.req.raw.headers,
      });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      const message = err instanceof Error ? err.message : "Invalid verification code";
      return jsonError(c, status as ContentfulStatusCode, "2fa_verify_failed", message);
    }
    await enqueueEmail("2fa-enabled", user.email, { name: user.name }).catch((err: unknown) => {
      console.warn("[api] 2fa-enabled email failed", err);
    });
    await audit(null, user.id, "account.2fa_enabled", {}).catch(() => undefined);
    return c.json({ ok: true });
  },
);

meRouter.post(
  "/api/me/2fa/disable",
  zValidator("json", disable2faSchema, (result, c) => {
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
    try {
      await auth.api.disableTwoFactor({
        body: { password: body.password },
        headers: c.req.raw.headers,
      });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      const message = err instanceof Error ? err.message : "Could not disable 2FA";
      return jsonError(c, status as ContentfulStatusCode, "2fa_disable_failed", message);
    }
    await enqueueEmail("2fa-disabled", user.email, { name: user.name }).catch((err: unknown) => {
      console.warn("[api] 2fa-disabled email failed", err);
    });
    await audit(null, user.id, "account.2fa_disabled", {}).catch(() => undefined);
    return c.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// Passkeys (WebAuthn)
//
// Registration and sign-in happen client-side via the passkey plugin (they
// drive the browser WebAuthn prompt). Listing and deletion go through these
// thin wrappers so we can audit removals and keep the shape uniform with the
// rest of /api/me.
// ---------------------------------------------------------------------------

meRouter.get("/api/me/passkeys", async (c) => {
  const user = c.get("user");
  const rows = await db
    .select({
      id: schema.passkey.id,
      name: schema.passkey.name,
      deviceType: schema.passkey.deviceType,
      backedUp: schema.passkey.backedUp,
      createdAt: schema.passkey.createdAt,
    })
    .from(schema.passkey)
    .where(eq(schema.passkey.userId, user.id))
    .orderBy(desc(schema.passkey.createdAt));
  return c.json({
    passkeys: rows.map((r) => ({
      id: r.id,
      name: r.name ?? null,
      deviceType: r.deviceType,
      backedUp: r.backedUp,
      createdAt: r.createdAt,
    })),
  });
});

meRouter.delete("/api/me/passkeys/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  try {
    await auth.api.deletePasskey({ body: { id }, headers: c.req.raw.headers });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 400;
    const message = err instanceof Error ? err.message : "Could not remove passkey";
    return jsonError(c, status as ContentfulStatusCode, "passkey_delete_failed", message);
  }
  await audit(null, user.id, "account.passkey_removed", { passkeyId: id }).catch(() => undefined);
  return c.json({ ok: true });
});
