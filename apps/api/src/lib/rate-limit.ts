import type { Context, MiddlewareHandler } from "hono";

const RATE_LIMIT_AUTH_PER_MIN = Math.max(1, Number(process.env.RATE_LIMIT_AUTH_PER_MIN) || 20);
const RATE_LIMIT_WEBHOOK_PER_MIN = Math.max(
  1,
  Number(process.env.RATE_LIMIT_WEBHOOK_PER_MIN) || 600,
);
const RATE_LIMIT_HEALTH_PER_MIN = Math.max(1, Number(process.env.RATE_LIMIT_HEALTH_PER_MIN) || 300);
const RATE_LIMIT_API_PER_MIN = Math.max(1, Number(process.env.RATE_LIMIT_API_PER_MIN) || 300);
const RATE_LIMIT_WINDOW_MS = 60_000;
const WEBHOOK_DEDUP_TTL_MS = Math.max(
  60_000,
  Number(process.env.WEBHOOK_DEDUP_TTL_MS) || 3_600_000,
);

type RouteClass = "auth" | "webhook" | "health" | "api";

type RateLimitBucket = { hits: number[] };

const ROUTE_CLASS_LIMITS: Record<RouteClass, number> = {
  auth: RATE_LIMIT_AUTH_PER_MIN,
  webhook: RATE_LIMIT_WEBHOOK_PER_MIN,
  health: RATE_LIMIT_HEALTH_PER_MIN,
  api: RATE_LIMIT_API_PER_MIN,
};

const rateLimitBuckets = new Map<string, RateLimitBucket>();
const webhookEventStore = new Map<string, number>();

function classifyRoute(method: string, path: string): RouteClass {
  if (path === "/api/health" || path === "/api/healthz") return "health";
  const isAuthPath = path === "/api/auth" || path.startsWith("/api/auth/");
  if (isAuthPath) {
    // GET auth reads (e.g. get-session) are polled on every navigation and are
    // not brute-force targets — bucket them with the general API limit. POST
    // auth (sign-in / sign-up) stays on the strict auth limit.
    if (method === "GET") return "api";
    return "auth";
  }
  if (path === "/api/payments/webhook") return "webhook";
  if (path === "/api/internal" || path.startsWith("/api/internal/")) return "webhook";
  return "api";
}

function getClientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0];
    if (first) return first.trim();
  }
  const xri = c.req.header("x-real-ip");
  if (xri) return xri.trim();
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf.trim();
  return "unknown";
}

export function checkRateLimit(
  bucketKey: string,
  limit: number,
  now: number = Date.now(),
): { allowed: boolean; retryAfter: number } {
  let bucket = rateLimitBuckets.get(bucketKey);
  if (!bucket) {
    bucket = { hits: [] };
    rateLimitBuckets.set(bucketKey, bucket);
  }
  bucket.hits = bucket.hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0] ?? now;
    const retryAfter = Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfter };
  }
  bucket.hits.push(now);
  return { allowed: true, retryAfter: 0 };
}

export const rateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return next();
  }
  const routeClass = classifyRoute(c.req.method, c.req.path);
  const limit = ROUTE_CLASS_LIMITS[routeClass];
  const decision = checkRateLimit(`${routeClass}:${getClientIp(c)}`, limit);
  if (!decision.allowed) {
    c.header("Retry-After", String(decision.retryAfter));
    return c.json({ error: { code: "rate_limited", message: "Too many requests" } }, 429);
  }
  return next();
};

export function checkWebhookDuplicate(
  provider: string,
  eventId: string,
  now: number = Date.now(),
): boolean {
  if (!eventId) return false;
  const key = `${provider}:${eventId}`;
  const expiresAt = webhookEventStore.get(key);
  if (expiresAt !== undefined && expiresAt > now) {
    return true;
  }
  webhookEventStore.set(key, now + WEBHOOK_DEDUP_TTL_MS);
  return false;
}

// Periodic cleanup of expired buckets and webhook dedup entries.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    bucket.hits = bucket.hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (bucket.hits.length === 0) {
      rateLimitBuckets.delete(key);
    }
  }
  for (const [key, expiresAt] of webhookEventStore) {
    if (expiresAt <= now) {
      webhookEventStore.delete(key);
    }
  }
}, 60_000).unref();
