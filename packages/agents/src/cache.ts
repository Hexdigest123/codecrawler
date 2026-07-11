import { env } from "@codecrawler/shared";
import IORedis from "ioredis";

// Best-effort Redis cache (repo map keyed by commit SHA). All operations are
// fail-safe: if Redis is unreachable the caller rebuilds from disk, so a cache
// miss or outage never fails a review. The connection is shared and lazy —
// teams that never run agentic reviews pay nothing.

let connection: IORedis | null = null;
let connecting = false;

export function getCacheConnection(): IORedis | null {
  if (!env.REDIS_URL) return null;
  if (connection) return connection;
  if (connecting) return null;
  connecting = true;
  try {
    const conn = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 2000,
    });
    conn.on("error", () => {
      // Swallow — cache is best-effort. The first command will reject and the
      // caller falls back to a fresh build.
    });
    connection = conn;
  } catch {
    connection = null;
  } finally {
    connecting = false;
  }
  return connection;
}

export async function cacheGet(key: string): Promise<string | null> {
  const conn = getCacheConnection();
  if (!conn) return null;
  try {
    await conn.connect().catch(() => undefined);
    return await conn.get(key);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const conn = getCacheConnection();
  if (!conn) return;
  try {
    await conn.connect().catch(() => undefined);
    await conn.set(key, value, "EX", ttlSeconds);
  } catch {
    // Best-effort: a failed write just means the next run rebuilds the map.
  }
}
