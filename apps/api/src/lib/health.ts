import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { client } from "@codecrawler/db";
import { env } from "@codecrawler/shared";

const HEALTH_CHECK_TIMEOUT_MS = Math.max(100, Number(process.env.HEALTH_CHECK_TIMEOUT_MS) || 2000);

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function pingDb(): Promise<"ok" | "fail"> {
  try {
    const res = await withTimeout(client`SELECT 1`, HEALTH_CHECK_TIMEOUT_MS);
    return Array.isArray(res) && res.length > 0 ? "ok" : "fail";
  } catch {
    return "fail";
  }
}

export function pingRedis(): Promise<"ok" | "fail"> {
  return new Promise<"ok" | "fail">((resolve) => {
    let settled = false;
    let socket: Socket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: "ok" | "fail") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (socket) {
        try {
          socket.destroy();
        } catch {
          // socket already closed
        }
      }
      resolve(result);
    };

    let url: URL;
    try {
      url = new URL(env.REDIS_URL);
    } catch {
      resolve("fail");
      return;
    }
    const useTls = url.protocol === "rediss:";
    const port = url.port ? Number(url.port) : 6379;
    const hostname = url.hostname;
    const password = url.password ? decodeURIComponent(url.password) : "";
    const username = url.username ? decodeURIComponent(url.username) : "";

    const sock = useTls
      ? tlsConnect({ port, host: hostname, servername: hostname })
      : netConnect({ port, host: hostname });
    socket = sock;
    timer = setTimeout(() => finish("fail"), HEALTH_CHECK_TIMEOUT_MS);

    let phase: "auth" | "ping" = password ? "auth" : "ping";
    let buffer = "";

    sock.on("connect", () => {
      if (phase === "auth") {
        sock.write(`AUTH ${username || "default"} ${password}\r\n`);
      } else {
        sock.write("PING\r\n");
      }
    });

    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (phase === "auth") {
        if (buffer.includes("+")) {
          phase = "ping";
          buffer = "";
          sock.write("PING\r\n");
        } else if (buffer.includes("-")) {
          finish("fail");
        }
        return;
      }
      if (buffer.includes("+PONG")) {
        finish("ok");
      } else if (buffer.includes("-")) {
        finish("fail");
      }
    });

    sock.on("error", () => finish("fail"));
  });
}
