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
  // Agentic review workflow (CodeRabbit-style tool-calling reviewers).
  // REVIEW_AGENT_MODE gates the feature globally: "off" forces the legacy
  // static path everywhere; "auto" resolves depth per run from the trigger
  // (/codecrawler deep), the team's agent_profile.defaultDepth, and the plan
  // gate; "quick"/"deep" force that tier for every run (deep still plan-gated).
  REVIEW_AGENT_MODE: z.enum(["off", "auto", "quick", "deep"]).default("off"),
  REVIEW_AGENT_MAX_STEPS_QUICK: asNumber.default(6),
  REVIEW_AGENT_MAX_STEPS_DEEP: asNumber.default(12),
  REVIEW_AGENT_BUDGET_USD_QUICK: asNumber.default(0.5),
  REVIEW_AGENT_BUDGET_USD_DEEP: asNumber.default(2),
  REVIEW_AGENT_MAX_TOOL_OUTPUT_BYTES: asNumber.default(20000),
  REVIEW_AGENT_MAX_READ_BYTES: asNumber.default(50000),
  REVIEW_INDEX_MAX_BYTES: asNumber.default(30000),
  REVIEW_AGENT_TIMEOUT_MS: asNumber.default(240000),
  // GitHub (github.com) dev/local escape hatch — a personal access token used
  // to validate the adapter against a real repo when no stored VCS connection
  // exists yet. Production MUST connect a PAT via team settings instead.
  GH_TEST_PAT: asString.optional(),
  // Shared webhook secrets per provider (must match the provider's webhook
  // config). Webhooks are optional now that the poller can discover new PRs.
  GH_WEBHOOK_SECRET: asString.optional(),
  GITLAB_WEBHOOK_SECRET: asString.optional(),
  GITEA_WEBHOOK_SECRET: asString.optional(),
  // PR polling. The worker registers a repeatable BullMQ job at this cron.
  // On each tick it lists open PRs for every project with polling_enabled=true
  // (and a stored VCS connection) and enqueues a review for any PR whose head
  // sha hasn't been reviewed yet. Disable by leaving the projects' toggle off.
  PR_POLL_CRON: asString.default("*/5 * * * *"),
  // Caps to keep a single poll tick bounded (large fleet safety).
  PR_POLL_MAX_PROJECTS: asNumber.default(200),
  PR_POLL_PER_PAGE: asNumber.default(30),
  // Shared secret protecting the internal /api/internal/poll endpoint that the
  // worker's scheduler calls on a cron. Must be set in production; when unset
  // the poll endpoint returns 503 (disabled) and the worker skips the tick.
  INTERNAL_API_KEY: asString.optional(),
  // Base URL the worker uses to reach the API for internal calls. Defaults to
  // PUBLIC_API_URL. In docker-compose the worker reaches the API via the
  // `api` service name, so override with e.g. http://api:3001.
  INTERNAL_API_URL: asString.optional(),
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
