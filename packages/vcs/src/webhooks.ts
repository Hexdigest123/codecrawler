import { createHmac, timingSafeEqual } from "node:crypto";
import type { VerifiedWebhook } from "./types";

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function findHeader(
  headers: Record<string, string>,
  match: (lowerKey: string) => boolean,
): string | undefined {
  for (const key of Object.keys(headers)) {
    if (match(key.toLowerCase())) return headers[key];
  }
  return undefined;
}

function hmacSha256Hex(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export async function verifyGitlabWebhook(
  token: string,
  headers: Record<string, string>,
  rawBody: string,
): Promise<VerifiedWebhook | null> {
  const provided = getHeader(headers, "x-gitlab-token");
  if (!token || !provided || provided !== token) return null;
  const name = getHeader(headers, "x-gitlab-event") ?? "push";
  try {
    return { name, payload: JSON.parse(rawBody) as Record<string, unknown> };
  } catch {
    return null;
  }
}

export async function verifyGiteaWebhook(
  secret: string,
  headers: Record<string, string>,
  rawBody: string,
): Promise<VerifiedWebhook | null> {
  const signature = findHeader(
    headers,
    (k) => k.includes("gitea-signature") || k.includes("guitea-signature"),
  );
  if (!secret || !signature) return null;
  let expected: string;
  try {
    expected = hmacSha256Hex(secret, rawBody);
  } catch {
    return null;
  }
  if (!safeEqualHex(signature, expected)) return null;
  const name =
    getHeader(headers, "x-gitea-event") ?? getHeader(headers, "x-github-event") ?? "push";
  try {
    return { name, payload: JSON.parse(rawBody) as Record<string, unknown> };
  } catch {
    return null;
  }
}
