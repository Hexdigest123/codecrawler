import { auth } from "@codecrawler/auth";
import { db, schema } from "@codecrawler/db";
import { env } from "@codecrawler/shared";
import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requireOrgAdmin } from "../lib/auth";
import { audit, requirePlan } from "../lib/db-helpers";
import { resolveSsoSchema, upsertSsoSchema } from "../lib/schemas";
import { ApiError, type AppEnv, jsonError } from "../lib/types";

export const ssoRouter = new Hono<AppEnv>();

ssoRouter.get("/api/teams/:id/audit", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAdmin(c, orgId, user.id);
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.orgId, orgId))
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(50);
  return c.json(rows);
});

// ---------------------------------------------------------------------------
// Team SSO (Pro feature)
//
// Backed by Better Auth's SSO plugin (`@better-auth/sso`), which stores
// provider configs in the `ssoProvider` table and mounts the SAML/OIDC
// handshake endpoints under `/api/auth/sso/*`. These routes are thin wrappers
// that:
//   • gate the feature on the Pro plan + org-admin role
//   • pin each org to a single provider (slug `org-${orgId}`) so callback URLs
//     stay stable across reconfiguration
//   • map the form payload to/from Better Auth's native shape
//
// Any standards-compliant IdP works (Authentik, Okta, Entra, Keycloak, Zitadel,
// Google Workspace, …) — speak SAML 2.0 or OIDC to it.
// ---------------------------------------------------------------------------

function ssoProviderSlug(orgId: string): string {
  return `org-${orgId}`;
}

function ssoCallbackUrl(slug: string): string {
  // SP ACS URL — Better Auth's SAML plugin reads the SAMLResponse here.
  return `${env.BETTER_AUTH_URL}/api/auth/sso/saml2/callback/${slug}`;
}

function deriveProtocol(p: { oidcConfig?: unknown; samlConfig?: unknown }): "saml" | "oidc" | null {
  if (p.samlConfig) return "saml";
  if (p.oidcConfig) return "oidc";
  return null;
}

ssoRouter.get("/api/teams/:id/sso", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAdmin(c, orgId, user.id);
  await requirePlan(orgId, "pro");

  // List is per-user (all their orgs); filter to this one. We pin the slug so
  // the lookup is exact even if a stale row lingers elsewhere.
  const slug = ssoProviderSlug(orgId);
  let providers: { providerId: string }[] = [];
  try {
    const res = (await auth.api.listSSOProviders({
      headers: c.req.raw.headers,
    })) as unknown as { providers?: { providerId: string }[] };
    providers = res.providers ?? [];
  } catch (err) {
    console.warn("[api] listSSOProviders failed", err);
    return c.json(null);
  }
  const found = providers.find((p) => p.providerId === slug);
  if (!found) return c.json(null);

  // Fetch the full (redacted) provider detail — gives us cert fingerprint,
  // discovery endpoints, etc. for display.
  let detail: Record<string, unknown> | null = null;
  try {
    detail = (await auth.api.getSSOProvider({
      query: { providerId: slug },
      headers: c.req.raw.headers,
    })) as unknown as Record<string, unknown> | null;
  } catch (err) {
    console.warn("[api] getSSOProvider failed", err);
  }
  const protocol = deriveProtocol(detail ?? {});
  return c.json({ ...(detail ?? {}), protocol });
});

ssoRouter.post(
  "/api/teams/:id/sso",
  zValidator("json", upsertSsoSchema, (result, c) => {
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
    await requirePlan(orgId, "pro");
    const body = c.req.valid("json");

    // Validate per-protocol required fields. On a *fresh* registration we also
    // require the secret material (cert / client secret); on an update we go
    // through `updateSSOProvider`, which patches only the provided fields, so
    // the admin can change e.g. just the domain without re-pasting the cert.
    if (body.protocol === "saml") {
      if (!body.saml?.entryURL || !body.saml.entityId) {
        throw new ApiError(400, "validation_error", "SAML config requires entryURL and entityId");
      }
    } else if (body.protocol === "oidc") {
      if (!body.oidc?.clientId || !body.oidc.issuerUrl) {
        throw new ApiError(400, "validation_error", "OIDC config requires clientId and issuerUrl");
      }
    } else {
      throw new ApiError(400, "validation_error", "Unknown SSO protocol");
    }

    const slug = ssoProviderSlug(orgId);
    const headers = c.req.raw.headers;

    // Detect an existing provider for this org so we can pick the right plugin
    // method (register vs update) and enforce secret-presence rules.
    let existingSlug: string | null = null;
    try {
      const res = (await auth.api.listSSOProviders({ headers })) as unknown as {
        providers?: { providerId: string }[];
      };
      if (res.providers?.some((p) => p.providerId === slug)) {
        existingSlug = slug;
      }
    } catch (err) {
      console.warn("[api] listSSOProviders (pre-upsert) failed", err);
    }

    if (!existingSlug) {
      // First registration — secret material is mandatory.
      if (body.protocol === "saml" && !body.saml?.certificate) {
        throw new ApiError(
          400,
          "validation_error",
          "A certificate is required when registering a new SAML provider.",
        );
      }
      if (body.protocol === "oidc" && !body.oidc?.clientSecret) {
        throw new ApiError(
          400,
          "validation_error",
          "A client secret is required when registering a new OIDC provider.",
        );
      }
    }

    try {
      if (!existingSlug) {
        // Register — full config required.
        if (body.protocol === "saml" && body.saml) {
          await auth.api.registerSSOProvider({
            body: {
              providerId: slug,
              domain: body.domain.trim().toLowerCase(),
              issuer: body.saml.entityId.trim(),
              organizationId: orgId,
              samlConfig: {
                entryPoint: body.saml.entryURL.trim(),
                cert: body.saml.certificate?.trim() ?? "",
                callbackUrl: ssoCallbackUrl(slug),
                spMetadata: {},
              },
            },
            headers,
          });
        } else if (body.protocol === "oidc" && body.oidc) {
          const scopes = (body.oidc.scopes ?? "").trim().split(/\s+/).filter(Boolean);
          await auth.api.registerSSOProvider({
            body: {
              providerId: slug,
              domain: body.domain.trim().toLowerCase(),
              issuer: body.oidc.issuerUrl.trim().replace(/\/+$/, ""),
              organizationId: orgId,
              oidcConfig: {
                clientId: body.oidc.clientId.trim(),
                clientSecret: body.oidc.clientSecret?.trim() ?? "",
                ...(scopes.length > 0 ? { scopes } : {}),
              },
            },
            headers,
          });
        }
      } else {
        // Update — patch only the provided fields. The plugin keeps the stored
        // cert/secret when the optional fields are omitted.
        const updateBody: {
          providerId: string;
          issuer?: string;
          domain?: string;
          samlConfig?: { entryPoint?: string; cert?: string; callbackUrl?: string };
          oidcConfig?: {
            clientId?: string;
            clientSecret?: string;
            scopes?: string[];
          };
        } = { providerId: slug, domain: body.domain.trim().toLowerCase() };

        if (body.protocol === "saml" && body.saml) {
          updateBody.issuer = body.saml.entityId.trim();
          updateBody.samlConfig = {
            entryPoint: body.saml.entryURL.trim(),
            callbackUrl: ssoCallbackUrl(slug),
            ...(body.saml.certificate && body.saml.certificate.trim().length > 0
              ? { cert: body.saml.certificate.trim() }
              : {}),
          };
        } else if (body.protocol === "oidc" && body.oidc) {
          updateBody.issuer = body.oidc.issuerUrl.trim().replace(/\/+$/, "");
          const scopes = (body.oidc.scopes ?? "").trim().split(/\s+/).filter(Boolean);
          updateBody.oidcConfig = {
            clientId: body.oidc.clientId.trim(),
            ...(body.oidc.clientSecret && body.oidc.clientSecret.length > 0
              ? { clientSecret: body.oidc.clientSecret }
              : {}),
            ...(scopes.length > 0 ? { scopes } : {}),
          };
        }
        await auth.api.updateSSOProvider({ body: updateBody, headers });
      }
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      const message =
        err instanceof Error && err.message
          ? err.message
          : "SSO registration failed. If OIDC, check that the issuer URL is reachable and serves a valid discovery document.";
      return jsonError(c, status as ContentfulStatusCode, "sso_registration_failed", message);
    }

    await audit(orgId, user.id, "team.sso_configured", {
      protocol: body.protocol,
      domain: body.domain,
    });
    return c.json({ ok: true });
  },
);

ssoRouter.delete("/api/teams/:id/sso", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("id");
  await requireOrgAdmin(c, orgId, user.id);
  await requirePlan(orgId, "pro");
  const slug = ssoProviderSlug(orgId);
  try {
    await auth.api.deleteSSOProvider({
      body: { providerId: slug },
      headers: c.req.raw.headers,
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 400;
    const message = err instanceof Error ? err.message : "SSO removal failed";
    return jsonError(c, status as ContentfulStatusCode, "sso_removal_failed", message);
  }
  await audit(orgId, user.id, "team.sso_removed", {});
  return c.json({ ok: true });
});

ssoRouter.post(
  "/api/sso/resolve",
  zValidator("json", resolveSsoSchema, (result, c) => {
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
    const domain = body.email.split("@")[1]?.toLowerCase() ?? "";
    if (!domain) {
      throw new ApiError(400, "validation_error", "Invalid email");
    }
    // The plugin's sign-in endpoint can resolve by email directly; we expose a
    // thin lookup so the /sso landing page can tell the user whether SSO exists
    // for their domain (and which protocol) before kicking off the handshake.
    const [row] = await db
      .select({
        providerId: schema.ssoProvider.providerId,
        organizationId: schema.ssoProvider.organizationId,
      })
      .from(schema.ssoProvider)
      .where(eq(schema.ssoProvider.domain, domain))
      .limit(1);
    return c.json(row ?? null);
  },
);
