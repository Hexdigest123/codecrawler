import { db, schema } from "@codecrawler/db";
import type { BillingMode, PlanId, ProviderId } from "@codecrawler/shared";
import { env } from "@codecrawler/shared";
import { eq } from "drizzle-orm";
import { getValidByokProviders } from "./byok";
import {
  gatewayFromModelId,
  PROVIDER_ID_TO_API_KEY_PROVIDER,
  providerFromModelId,
  SAIA_KNOWN_MODELS,
  saiaVendorFromId,
  saiaWeightForModel,
  stripGatewayPrefix,
} from "./providers";
import { computeWeight, minPlanForWeight } from "./weight";

export interface ResolvedModel {
  modelId: string;
  provider?: ProviderId;
  vendor: string;
  gateway: "openrouter" | "saia";
  weight: number;
  billingMode: BillingMode;
  displayName: string;
  minPlan: PlanId;
}

export async function resolveProvider(modelId: string, orgId?: string): Promise<ResolvedModel> {
  const gateway = gatewayFromModelId(modelId);
  if (gateway === "saia") {
    return resolveSaia(modelId, orgId);
  }
  const provider = providerFromModelId(modelId);
  if (!provider) {
    throw new Error(`Unknown provider for model: ${modelId}`);
  }
  const { weight, displayName, minPlan } = await resolveWeightAndPlan(modelId);
  const billingMode = await resolveBillingMode(orgId, provider);
  return {
    modelId,
    provider,
    vendor: provider,
    gateway: "openrouter",
    weight,
    billingMode,
    displayName,
    minPlan,
  };
}

async function resolveSaia(modelId: string, orgId?: string): Promise<ResolvedModel> {
  const apiId = stripGatewayPrefix(modelId);
  const known = SAIA_KNOWN_MODELS.find((m) => m.id.toLowerCase() === apiId.toLowerCase());
  const vendor = known?.vendor ?? saiaVendorFromId(apiId);
  const weight = known ? saiaWeightForModel(known.paramB) : 1;
  const billingMode = orgId ? await resolveSaiaBillingMode(orgId) : "hosted";
  return {
    modelId,
    provider: undefined,
    vendor,
    gateway: "saia",
    weight,
    billingMode,
    displayName: known?.name ?? apiId,
    minPlan: "free",
  };
}

async function resolveSaiaBillingMode(orgId: string): Promise<BillingMode> {
  const byokProviders = await getValidByokProviders(orgId);
  return byokProviders.has("saia") ? "byok" : "hosted";
}

async function resolveWeightAndPlan(
  modelId: string,
): Promise<{ weight: number; displayName: string; minPlan: PlanId }> {
  const rows = await db
    .select()
    .from(schema.modelWeights)
    .where(eq(schema.modelWeights.openrouterModelId, modelId))
    .limit(1);
  if (rows.length > 0) {
    const row = rows[0];
    const weight = Number.parseFloat(row.weight) || 1;
    const displayName = row.displayName ?? modelId;
    const minPlan = row.minPlan ?? "free";
    return { weight, displayName, minPlan };
  }
  const pricing = await fetchSingleModelPricing(modelId);
  if (pricing) {
    const weight = computeWeight(pricing.promptPricePer1k, pricing.completionPricePer1k);
    return { weight, displayName: modelId, minPlan: minPlanForWeight(weight) };
  }
  return { weight: 1, displayName: modelId, minPlan: "free" };
}

async function resolveBillingMode(
  orgId: string | undefined,
  provider: ProviderId,
): Promise<BillingMode> {
  if (!orgId) return "hosted";
  const apiKeyProvider = PROVIDER_ID_TO_API_KEY_PROVIDER[provider];
  const byokProviders = await getValidByokProviders(orgId);
  if (byokProviders.has(apiKeyProvider) || byokProviders.has("openrouter")) {
    return "byok";
  }
  return "hosted";
}

interface OpenRouterModel {
  id?: string;
  pricing?: { prompt?: string; completion?: string };
}

interface OpenRouterModelResponse {
  data?: OpenRouterModel;
}

async function fetchSingleModelPricing(
  modelId: string,
): Promise<{ promptPricePer1k: number; completionPricePer1k: number } | null> {
  const baseURL = env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  try {
    const headers: Record<string, string> = {};
    if (env.OPENROUTER_API_KEY) {
      headers.Authorization = `Bearer ${env.OPENROUTER_API_KEY}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${baseURL}/model/${modelId}`, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as OpenRouterModelResponse;
    const data = json.data;
    if (!data?.pricing) return null;
    const prompt = num(data.pricing.prompt) * 1000;
    const completion = num(data.pricing.completion) * 1000;
    return { promptPricePer1k: prompt, completionPricePer1k: completion };
  } catch {
    return null;
  }
}

function num(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
