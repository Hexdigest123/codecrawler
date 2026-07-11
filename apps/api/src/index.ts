import { env } from "@codecrawler/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { requireSession } from "./lib/auth";
import { rateLimitMiddleware } from "./lib/rate-limit";
import { isPublicApiPath } from "./lib/review";
import { ApiError, type AppEnv, jsonError } from "./lib/types";
import { adminRouter } from "./routes/admin";
import { meRouter } from "./routes/me";
import { membersRouter } from "./routes/members";
import { modelsRouter } from "./routes/models";
import { projectsRouter } from "./routes/projects";
import { publicRouter } from "./routes/public";
import { signupRouter } from "./routes/signup";
import { ssoRouter } from "./routes/sso";
import { teamsRouter } from "./routes/teams";

const app = new Hono<AppEnv>();

// --- Global middleware ---

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["set-cookie"],
  }),
);
app.use("*", rateLimitMiddleware);

// --- Public routes (no session required) ---

app.route("/", publicRouter);

// --- Session middleware ---
// Runs for all remaining /api/* routes. Public paths (health, auth, payments,
// signup-config, internal) are skipped — they're already handled above or
// registered on the public router.

app.use("/api/*", async (c, next) => {
  if (isPublicApiPath(c.req.path)) {
    return next();
  }
  const user = await requireSession(c);
  c.set("user", user);
  await next();
});

// --- Authenticated routes ---

app.route("/", meRouter);
app.route("/", teamsRouter);
app.route("/", modelsRouter);
app.route("/", projectsRouter);
app.route("/", membersRouter);
app.route("/", ssoRouter);
app.route("/", signupRouter);
app.route("/", adminRouter);

// --- Error handling ---

app.notFound((c) => jsonError(c, 404, "not_found", "Not found"));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return jsonError(c, err.status, err.code, err.message);
  }
  console.error("[api] unhandled", err);
  return jsonError(c, 500, "internal_error", err instanceof Error ? err.message : "Internal error");
});

Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
});

console.log(`[api] listening on http://localhost:${env.PORT}`);

export default app;
