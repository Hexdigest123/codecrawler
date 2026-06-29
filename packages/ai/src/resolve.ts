import type { BillingMode, PlanId, ProviderId } from "@codecrawler/shared";
import { getValidByokProviders } from "./byok";
import { findCatalogModelById } from "./catalog";
import {
  gatewayFromModelId,
  PROVIDER_ID_TO_API_KEY_PROVIDER,
  providerFromModelId,
  SAIA_KNOWN_MODELS,
  saiaVendorFromId,
  saiaWeightForModel,
  stripGatewayPrefix,
} from "./providers";

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
  const entry = await findCatalogModelById(modelId);
  if (entry) {
    return { weight: entry.weight, displayName: entry.name, minPlan: entry.minPlan };
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
