import { db, schema } from "@codecrawler/db";
import { enqueueEmail } from "@codecrawler/email";
import { env } from "@codecrawler/shared";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";

export type SignupMode = "open" | "closed" | "domain_restricted" | "approval";

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

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.CORS_ORIGIN, env.PUBLIC_WEB_URL],
  emailAndPassword: { enabled: true },
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
  plugins: [organization({ allowUserToCreateOrganization: true })],
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
