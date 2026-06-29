export type { ApiKeyProvider, ProviderId } from "@codecrawler/shared";
export {
  getActiveByokKey,
  getByokKeyByApiKeyProvider,
  getValidByokProviders,
  verifyByokKey,
} from "./byok";
export type { CatalogModel } from "./catalog";
export { fetchModelCatalog } from "./catalog";
export type { CreateLangChainClientOpts } from "./client";
export { createLangChainClient } from "./client";
export type { ModelGateway, SaiaKnownModel } from "./providers";
export {
  BYOK_BASE_URL,
  gatewayFromModelId,
  OPENAI_COMPATIBLE_BYOK_PROVIDERS,
  PROVIDER_ID_TO_API_KEY_PROVIDER,
  PROVIDER_PREFIXES,
  providerFromModelId,
  SAIA_BASE_URL,
  SAIA_KNOWN_MODELS,
  SAIA_PREFIX,
  saiaVendorFromId,
  saiaWeightForModel,
  stripGatewayPrefix,
} from "./providers";
export type { ResolvedModel } from "./resolve";
export { resolveProvider } from "./resolve";
export {
  computeWeight,
  minPlanForWeight,
  WEIGHT_BASELINE_USD_PER_1K,
  WEIGHT_PLAN_BANDS,
} from "./weight";
