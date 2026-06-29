import { db, schema } from "@codecrawler/db";
import type { PlanId, ProviderId } from "@codecrawler/shared";
import { env } from "@codecrawler/shared";
import { eq } from "drizzle-orm";
import { getByokKeyByApiKeyProvider, getValidByokProviders } from "./byok";
import {
  gatewayFromModelId,
  PROVIDER_ID_TO_API_KEY_PROVIDER,
  providerFromModelId,
  SAIA_BASE_URL,
  SAIA_KNOWN_MODELS,
  saiaVendorFromId,
  saiaWeightForModel,
  stripGatewayPrefix,
} from "./providers";
import { computeWeight, minPlanForWeight } from "./weight";

export interface CatalogModel {
  id: string;
  name: string;
  provider?: ProviderId;
  vendor: string;
  gateway: "openrouter" | "saia";
  promptPricePer1k: number;
  completionPricePer1k: number;
  contextLength: number;
  weight: number;
  minPlan: PlanId;
  byok: boolean;
}

interface OpenRouterListItem {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

interface OpenRouterListResponse {
  data?: OpenRouterListItem[];
}

interface SaiaListItem {
  id: string;
}

interface SaiaListResponse {
  data?: SaiaListItem[];
}

interface CatalogCache {
  expiresAt: number;
  models: CatalogModel[];
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: CatalogCache | null = null;

export async function fetchModelCatalog(orgId?: string): Promise<CatalogModel[]> {
  const base = await getBaseCatalog();
  const saia = await fetchSaiaCatalog(orgId);
  return applyByokFlag([...base, ...saia], orgId);
}

export async function findCatalogModelById(modelId: string): Promise<CatalogModel | null> {
  const base = await getBaseCatalog();
  return base.find((m) => m.id === modelId) ?? null;
}

async function getBaseCatalog(): Promise<CatalogModel[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.models;
  }
  const live = await tryFetchLiveCatalog();
  const base = live.length > 0 ? live : await fetchCatalogFromDb();
  cache = { expiresAt: now + CACHE_TTL_MS, models: base };
  return base;
}

async function tryFetchLiveCatalog(): Promise<CatalogModel[]> {
  const baseURL = env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  try {
    const headers: Record<string, string> = {};
    if (env.OPENROUTER_API_KEY) {
      headers.Authorization = `Bearer ${env.OPENROUTER_API_KEY}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${baseURL}/models`, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = (await res.json()) as OpenRouterListResponse;
    const items = json.data ?? [];
    const out: CatalogModel[] = [];
    for (const item of items) {
      const provider = providerFromModelId(item.id);
      if (!provider) continue;
      const prompt = num(item.pricing?.prompt) * 1000;
      const completion = num(item.pricing?.completion) * 1000;
      const weight = computeWeight(prompt, completion);
      out.push({
        id: item.id,
        name: item.name ?? item.id,
        provider,
        vendor: provider,
        gateway: "openrouter",
        promptPricePer1k: prompt,
        completionPricePer1k: completion,
        contextLength: item.context_length ?? 0,
        weight,
        minPlan: minPlanForWeight(weight),
        byok: false,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchCatalogFromDb(): Promise<CatalogModel[]> {
  const rows = await db
    .select()
    .from(schema.modelWeights)
    .where(eq(schema.modelWeights.enabled, true));
  const out: CatalogModel[] = [];
  for (const row of rows) {
    const provider = providerFromModelId(row.openrouterModelId) ?? undefined;
    const weight = Number.parseFloat(row.weight) || 1;
    out.push({
      id: row.openrouterModelId,
      name: row.displayName ?? row.openrouterModelId,
      provider,
      vendor: provider ?? saiaVendorFromId(stripGatewayPrefix(row.openrouterModelId)),
      gateway: gatewayFromModelId(row.openrouterModelId),
      promptPricePer1k: 0,
      completionPricePer1k: 0,
      contextLength: 0,
      weight,
      minPlan: row.minPlan ?? "free",
      byok: false,
    });
  }
  return out;
}

async function fetchSaiaCatalog(orgId: string | undefined): Promise<CatalogModel[]> {
  let key: string | null = null;
  if (orgId) {
    key = await getByokKeyByApiKeyProvider(orgId, "saia");
  }
  const apiIds = key ? await fetchSaiaModelIds(key) : null;
  const ids = apiIds ?? SAIA_KNOWN_MODELS.map((m) => m.id);
  const known = new Map(SAIA_KNOWN_MODELS.map((m) => [m.id.toLowerCase(), m]));
  const out: CatalogModel[] = [];
  for (const apiId of ids) {
    const knownModel = known.get(apiId.toLowerCase());
    const vendor = knownModel?.vendor ?? saiaVendorFromId(apiId);
    const paramB = knownModel?.paramB ?? 0;
    const weight = saiaWeightForModel(paramB || 8);
    out.push({
      id: `saia/${apiId}`,
      name: knownModel?.name ?? apiId,
      vendor,
      gateway: "saia",
      promptPricePer1k: 0,
      completionPricePer1k: 0,
      contextLength: 0,
      weight,
      minPlan: "free",
      byok: Boolean(key),
    });
  }
  return out;
}

async function fetchSaiaModelIds(key: string): Promise<string[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${SAIA_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as SaiaListResponse;
    const data = json.data ?? [];
    const ids = data
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

async function applyByokFlag(
  models: CatalogModel[],
  orgId: string | undefined,
): Promise<CatalogModel[]> {
  if (!orgId) {
    return models.map((m) => ({ ...m, byok: m.gateway === "saia" ? false : m.byok }));
  }
  const byokProviders = await getValidByokProviders(orgId);
  const hasOpenRouter = byokProviders.has("openrouter");
  const hasSaia = byokProviders.has("saia");
  return models.map((m) => {
    if (m.gateway === "saia") {
      return { ...m, byok: hasSaia };
    }
    const apiKeyProvider = m.provider ? PROVIDER_ID_TO_API_KEY_PROVIDER[m.provider] : null;
    return {
      ...m,
      byok: (apiKeyProvider != null && byokProviders.has(apiKeyProvider)) || hasOpenRouter,
    };
  });
}

function num(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
