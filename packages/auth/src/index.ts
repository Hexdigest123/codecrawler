import { passkey } from "@better-auth/passkey";
import { sso } from "@better-auth/sso";
import { db, schema } from "@codecrawler/db";
import { enqueueEmail } from "@codecrawler/email";
import { decryptSecret, encryptSecret, env } from "@codecrawler/shared";
import { betterAuth, type DBAdapter } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { organization, twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";

export type SignupMode = "open" | "closed" | "domain_restricted" | "approval";

// WebAuthn Relying Party config for passkeys. The rpID is the registrable
// domain of the web app (where the browser runs the ceremony), and `origin` is
// the full web origin. Both derive from PUBLIC_WEB_URL so dev (localhost) and
// prod (codecrawler.merckel.dev) work without per-env code changes.
const publicWebOrigin = env.PUBLIC_WEB_URL.replace(/\/$/, "");
const passkeyRpID = (() => {
  try {
    return new URL(publicWebOrigin).hostname;
  } catch {
    return "localhost";
  }
})();

/**
 * Platform-wide sign-up + account gate, read on every sign-up attempt. Sourced
 * from the singleton `app_settings` row (Admin → Signups). Defaults to "open"
 * if the row is somehow missing so the instance stays usable.
 */
async function readSignupMode(): Promise<{
  mode: SignupMode;
  allowedDomains: string[];
}> {
  const [row] = await db
    .select({
      mode: schema.appSettings.signupMode,
      allowedDomains: schema.appSettings.allowedDomains,
    })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.id, "singleton"))
    .limit(1);
  if (!row) {
    return { mode: "open", allowedDomains: [] };
  }
  return {
    mode: (row.mode as SignupMode) ?? "open",
    allowedDomains: (row.allowedDomains ?? []).map((d) => d.toLowerCase()),
  };
}

async function countUsers(): Promise<number> {
  const rows = await db.select({ id: schema.user.id }).from(schema.user);
  return rows.length;
}

async function getAdminEmails(): Promise<string[]> {
  const rows = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.role, "admin"));
  return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
}

// ---------------------------------------------------------------------------
// Transparent at-rest encryption for the OIDC clientSecret stored by Better
// Auth's SSO plugin inside `sso_provider.oidc_config` (a JSON blob the plugin
// parses back with `safeJsonParse`). The plugin has no encryption hook of its
// own and reads the secret at handshake time to do the OIDC code exchange, so
// we wrap the drizzle adapter and rewrite the `clientSecret` field on the way
// in/out. The AAD "sso:oidc:client_secret" binds the ciphertext to this use so
// a leaked blob can't be replayed against e.g. the VCS or BYOK tables.
// ---------------------------------------------------------------------------

const SSO_OIDC_AAD = "sso:oidc:client_secret";

type AnyRecord = Record<string, unknown>;

// Better-auth's `database` option accepts an adapter *factory*: a function
// `(options) => DBAdapter`. `drizzleAdapter(db, …)` returns exactly such a
// factory. We wrap that factory so the returned adapter transparently
// encrypts/decrypts the OIDC `clientSecret` on `ssoProvider` rows.
type AdapterFactory = (options: any) => DBAdapter;

function rewriteOidcConfig<T>(raw: T, fn: (clientSecret: string) => string): T {
  // The SSO plugin stores oidcConfig as a JSON *string* (see buildOIDCConfig),
  // but be defensive and accept an object too in case the adapter round-trips
  // the jsonb column as a parsed object.
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.clientSecret === "string" &&
        parsed.clientSecret.length > 0
      ) {
        parsed.clientSecret = fn(parsed.clientSecret);
        return JSON.stringify(parsed) as T;
      }
    } catch {
      // Not JSON — leave untouched.
    }
    return raw;
  }
  if (raw && typeof raw === "object" && "clientSecret" in raw) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.clientSecret === "string" && obj.clientSecret.length > 0) {
      return { ...obj, clientSecret: fn(obj.clientSecret) } as T;
    }
  }
  return raw;
}

function encryptOidc<T>(raw: T): T {
  return rewriteOidcConfig(raw, (s) => encryptSecret(s, { aad: SSO_OIDC_AAD }));
}

function decryptOidc<T>(raw: T): T {
  return rewriteOidcConfig(raw, (s) => {
    try {
      return decryptSecret(s, { aad: SSO_OIDC_AAD });
    } catch {
      // Already plaintext (e.g. written before this wrapper shipped) — leave as-is.
      return s;
    }
  });
}

function wrapRow<T>(row: T): T {
  if (row && typeof row === "object" && "oidcConfig" in (row as AnyRecord)) {
    const r = row as AnyRecord;
    return { ...r, oidcConfig: decryptOidc(r.oidcConfig) } as T;
  }
  return row;
}

function withSsoEncryption<F extends AdapterFactory>(factory: F): F {
  // Better-auth checks `typeof options.database === "function"` to decide
  // whether to invoke our factory vs. falling back to the built-in Kysely
  // loader. We must therefore return a function (the wrapped factory), not a
  // pre-built adapter object — otherwise init fails with
  // "Failed to initialize database adapter".
  const wrapped = (options: Parameters<F>[0]) => {
    const adapter = factory(options);
    const override = {
      async create<T extends Record<string, any>, R = T>(args: {
        model: string;
        data: Omit<T, "id"> & { oidcConfig?: unknown };
        select?: string[];
        forceAllowId?: boolean;
      }): Promise<R> {
        const { model, data, forceAllowId } = args;
        const next =
          model === "ssoProvider" && data.oidcConfig != null
            ? { ...data, oidcConfig: encryptOidc(data.oidcConfig) }
            : data;
        const created = await adapter.create({ model, data: next as Omit<T, "id">, forceAllowId });
        return (model === "ssoProvider" ? wrapRow(created) : created) as unknown as R;
      },
      async findOne<T>(args: {
        model: string;
        where: Parameters<DBAdapter["findOne"]>[0]["where"];
        select?: string[];
        join?: Parameters<DBAdapter["findOne"]>[0]["join"];
      }): Promise<T | null> {
        const found = await adapter.findOne<T>(args);
        return args.model === "ssoProvider" ? wrapRow(found) : found;
      },
      async findMany<T>(args: {
        model: string;
        where?: Parameters<DBAdapter["findMany"]>[0]["where"];
        limit?: number;
        select?: string[];
        sortBy?: Parameters<DBAdapter["findMany"]>[0]["sortBy"];
        offset?: number;
        join?: Parameters<DBAdapter["findMany"]>[0]["join"];
      }): Promise<T[]> {
        const rows = await adapter.findMany<T>(args);
        return args.model === "ssoProvider" ? rows.map((r) => wrapRow(r)) : rows;
      },
      async update<T>(args: {
        model: string;
        where: Parameters<DBAdapter["update"]>[0]["where"];
        update: Record<string, any> & { oidcConfig?: unknown };
      }): Promise<T | null> {
        const next =
          args.model === "ssoProvider" && args.update.oidcConfig != null
            ? { ...args.update, oidcConfig: encryptOidc(args.update.oidcConfig) }
            : args.update;
        const updated = await adapter.update<T>({
          model: args.model,
          where: args.where,
          update: next,
        });
        return args.model === "ssoProvider" ? wrapRow(updated) : updated;
      },
      async updateMany(args: {
        model: string;
        where: Parameters<DBAdapter["updateMany"]>[0]["where"];
        update: Record<string, any> & { oidcConfig?: unknown };
      }): Promise<number> {
        const next =
          args.model === "ssoProvider" && args.update.oidcConfig != null
            ? { ...args.update, oidcConfig: encryptOidc(args.update.oidcConfig) }
            : args.update;
        return adapter.updateMany({ model: args.model, where: args.where, update: next });
      },
    };
    return { ...adapter, ...override } as DBAdapter;
  };
  return wrapped as F;
}

export const auth = betterAuth({
  database: withSsoEncryption(drizzleAdapter(db, { provider: "pg", schema })),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.CORS_ORIGIN, env.PUBLIC_WEB_URL],
  emailAndPassword: {
    enabled: true,
    // Password reset ("forgot password") flow. Better Auth generates a signed,
    // single-use token and embeds it into `url`; we hand the URL to the existing
    // `password-reset` email template. The mail send is fire-and-forget to
    // avoid leaking whether an account exists via response timing.
    sendResetPassword: async ({ user, url }) => {
      const name = user.name ?? "";
      void enqueueEmail("password-reset", user.email, {
        name,
        resetUrl: url,
      }).catch((err) => {
        console.warn("[auth] password-reset email failed", err);
      });
    },
    resetPasswordTokenExpiresIn: 60 * 60,
  },
  socialProviders: {
    ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
          },
        }
      : {}),
  },
  plugins: [
    organization({ allowUserToCreateOrganization: true }),
    sso(),
    twoFactor(),
    passkey({
      rpID: passkeyRpID,
      rpName: env.PUBLIC_APP_NAME,
      origin: publicWebOrigin,
    }),
  ],
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "user",
        input: false,
      },
      status: {
        type: "string",
        required: false,
        defaultValue: "active",
        input: false,
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (incoming) => {
          // First user ever becomes the initial administrator.
          const total = await countUsers();
          if (total === 0) {
            return {
              data: {
                ...incoming,
                role: "admin",
                status: "active",
              },
            };
          }

          const { mode, allowedDomains } = await readSignupMode();
          const email = (incoming.email ?? "").trim().toLowerCase();
          const domain = email.split("@")[1]?.toLowerCase() ?? "";

          if (mode === "closed") {
            throw new APIError("FORBIDDEN", {
              message: "New sign-ups are currently disabled.",
            });
          }
          if (mode === "domain_restricted") {
            if (!domain || !allowedDomains.includes(domain)) {
              throw new APIError("FORBIDDEN", {
                message: "Sign-ups are restricted to approved email domains for this instance.",
              });
            }
            return { data: { ...incoming, role: "user", status: "active" } };
          }
          if (mode === "approval") {
            // The account is created in a "pending" state; the session hook
            // below blocks sign-in until an admin approves the request.
            return { data: { ...incoming, role: "user", status: "pending" } };
          }
          // "open"
          return { data: { ...incoming, role: "user", status: "active" } };
        },
        after: async (created) => {
          const email = created.email ?? "";
          const name = created.name ?? "";
          const status = (created.status as string) ?? "active";
          const signInUrl = `${env.PUBLIC_WEB_URL}/sign-in`;

          if (status === "pending") {
            try {
              await db
                .insert(schema.signupRequests)
                .values({
                  userId: created.id,
                  email,
                  name,
                  status: "pending",
                })
                .onConflictDoNothing({ target: schema.signupRequests.userId });
            } catch (err) {
              console.warn("[auth] signup_requests insert failed", err);
            }
            try {
              await enqueueEmail("signup-received", email, {
                name,
                signInUrl,
              });
            } catch (err) {
              console.warn("[auth] signup-received email failed", err);
            }
            try {
              const adminEmails = await getAdminEmails();
              const dashboardUrl = `${env.PUBLIC_WEB_URL}/admin/signups`;
              for (const addr of adminEmails) {
                await enqueueEmail("signup-pending-admin", addr, {
                  name,
                  email,
                  dashboardUrl,
                });
              }
            } catch (err) {
              console.warn("[auth] admin pending-notify email failed", err);
            }
            return;
          }

          // Active account (open / domain_restricted / first admin).
          try {
            await enqueueEmail("welcome", email, {
              name,
              dashboardUrl: `${env.PUBLIC_WEB_URL}/dashboard`,
            });
          } catch (err) {
            console.warn("[auth] welcome email failed", err);
          }
        },
      },
    },
    session: {
      create: {
        before: async (incoming) => {
          const userId = incoming.userId;
          if (!userId) {
            return true;
          }
          const [u] = await db
            .select({ status: schema.user.status })
            .from(schema.user)
            .where(eq(schema.user.id, userId))
            .limit(1);
          const status = (u?.status as string) ?? "active";
          if (status === "pending") {
            throw new APIError("FORBIDDEN", {
              message:
                "Your account is pending administrator approval. You'll receive an email once it's reviewed.",
            });
          }
          if (status === "denied") {
            throw new APIError("FORBIDDEN", {
              message:
                "Your sign-up request was denied. If you believe this is an error, contact the instance administrator.",
            });
          }
          return true;
        },
      },
    },
  },
});
