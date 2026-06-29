import "./load-env";
import { z } from "zod";

const asString = z.string();

const asNumber = z.preprocess((v) => {
  if (typeof v === "number") {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    return Number(v);
  }
  return undefined;
}, z.number());

const asBoolean = z.preprocess((v) => {
  if (typeof v === "boolean") {
    return v;
  }
  if (typeof v === "string") {
    return v === "true";
  }
  return false;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PUBLIC_APP_NAME: asString.default("CodeCrawler"),
  PUBLIC_WEB_URL: asString.url(),
  PUBLIC_API_URL: asString.url(),
  PUBLIC_SITE_URL: asString.url(),
  PORT: asNumber.default(3001),
  CORS_ORIGIN: asString.default("http://localhost:5173"),
  BETTER_AUTH_URL: asString.url(),
  BETTER_AUTH_SECRET: asString.min(1, "BETTER_AUTH_SECRET is required"),
  TOKEN_ENCRYPTION_KEY: asString.min(1, "TOKEN_ENCRYPTION_KEY is required"),
  WEBHOOK_PUBLIC_URL: asString.url(),
  DATABASE_URL: asString.min(1, "DATABASE_URL is required"),
  REDIS_URL: asString.min(1, "REDIS_URL is required"),
  OPENROUTER_API_KEY: asString.default(""),
  OPENROUTER_BASE_URL: asString.default("https://openrouter.ai/api/v1"),
  OPENROUTER_DEFAULT_MODEL: asString.default("minimax/minimax-m3"),
  AI_TIMEOUT_MS: asNumber.default(180000),
  CREDITS_PER_USD: asNumber.default(1333),
  LANGCHAIN_TRACING_V2: asBoolean.default(false),
  LANGCHAIN_API_KEY: asString.optional(),
  LANGCHAIN_PROJECT: asString.default("codecrawler"),
  SNYK_TOKEN: asString.optional(),
  SNYK_API: asString.default("https://api.snyk.io"),
  SNYK_ORG_ID: asString.optional(),
  MOLLIE_API_KEY: asString.optional(),
  MOLLIE_REDIRECT_URL: asString.optional(),
  MOLLIE_WEBHOOK_URL: asString.optional(),
  SMTP_HOST: asString.default("127.0.0.1"),
  SMTP_PORT: asNumber.default(1025),
  SMTP_SECURE: asBoolean.default(false),
  SMTP_USERNAME: asString.optional(),
  SMTP_PASSWORD: asString.optional(),
  MAIL_FROM: asString.default("CodeCrawler <noreply@codecrawler.local>"),
  REVIEW_MAX_DIFF_BYTES: asNumber.default(1500000),
  REVIEW_MAX_SLICES: asNumber.default(16),
  SECURITY_SCAN_TIMEOUT_MS: asNumber.default(900000),
  // GitHub App credentials. When GH_APP_ID + GH_APP_PRIVATE_KEY are set, VCS
  // access for GitHub uses installation tokens minted by the App (production
  // path). GH_TEST_PAT remains as a local-dev escape hatch only.
  GH_APP_ID: asString.optional(),
  GH_APP_PRIVATE_KEY: asString.optional(),
  GH_APP_CLIENT_ID: asString.optional(),
  GH_APP_CLIENT_SECRET: asString.optional(),
  GH_WEBHOOK_SECRET: asString.optional(),
  GH_TEST_PAT: asString.optional(),
  GITLAB_WEBHOOK_SECRET: asString.optional(),
  GITEA_WEBHOOK_SECRET: asString.optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

function loadEnv(): AppEnv {
  const result = envSchema.safeParse(process.env);
  if (result.success) {
    return result.data;
  }
  const flat = result.error.flatten();
  const lines: string[] = ["Invalid environment variables:"];
  for (const [field, messages] of Object.entries(flat.fieldErrors)) {
    if (!messages) {
      continue;
    }
    for (const message of messages) {
      lines.push(`  - ${field}: ${message}`);
    }
  }
  for (const message of flat.formErrors) {
    lines.push(`  - ${message}`);
  }
  throw new Error(lines.join("\n"));
}

export const env: AppEnv = loadEnv();
