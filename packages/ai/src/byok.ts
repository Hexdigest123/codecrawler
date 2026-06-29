import { db, schema } from "@codecrawler/db";
import type { ApiKeyProvider, ProviderId } from "@codecrawler/shared";
import { decryptSecret } from "@codecrawler/shared";
import { and, desc, eq } from "drizzle-orm";
import {
  BYOK_BASE_URL,
  OPENAI_COMPATIBLE_BYOK_PROVIDERS,
  PROVIDER_ID_TO_API_KEY_PROVIDER,
} from "./providers";

export async function getByokKeyByApiKeyProvider(
  orgId: string,
  provider: ApiKeyProvider,
): Promise<string | null> {
  const rows = await db
    .select({ encryptedKey: schema.apiKeys.encryptedKey })
    .from(schema.apiKeys)
    .where(
      and(
        eq(schema.apiKeys.orgId, orgId),
        eq(schema.apiKeys.provider, provider),
        eq(schema.apiKeys.status, "valid"),
      ),
    )
    .orderBy(desc(schema.apiKeys.createdAt))
    .limit(1);
  if (rows.length === 0) return null;
  return decryptSecret(rows[0].encryptedKey);
}

export async function getActiveByokKey(
  orgId: string,
  provider: ProviderId,
): Promise<string | null> {
  return getByokKeyByApiKeyProvider(orgId, PROVIDER_ID_TO_API_KEY_PROVIDER[provider]);
}

export async function getValidByokProviders(orgId: string): Promise<Set<ApiKeyProvider>> {
  const rows = await db
    .select({ provider: schema.apiKeys.provider })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.orgId, orgId), eq(schema.apiKeys.status, "valid")));
  return new Set(rows.map((r) => r.provider));
}

export async function verifyByokKey(provider: ApiKeyProvider, key: string): Promise<boolean> {
  if (provider === "anthropic") return verifyAnthropic(key);
  if (provider === "google") return verifyGoogle(key);
  const baseURL = BYOK_BASE_URL[provider];
  if (OPENAI_COMPATIBLE_BYOK_PROVIDERS.has(provider) && baseURL) {
    return verifyOpenAICompatible(baseURL, key);
  }
  return false;
}

async function verifyOpenAICompatible(baseURL: string, key: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function verifyAnthropic(key: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.status !== 401 && res.status !== 403;
  } catch {
    return false;
  }
}

async function verifyGoogle(key: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
      key,
    )}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
