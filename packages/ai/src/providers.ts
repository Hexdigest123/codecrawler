import type { ApiKeyProvider, ProviderId } from "@codecrawler/shared";

export const SAIA_BASE_URL = "https://chat-ai.academiccloud.de/v1";
export const SAIA_PREFIX = "saia/";

export type ModelGateway = "openrouter" | "saia";

export interface ProviderPrefixEntry {
  prefixes: readonly string[];
  provider: ProviderId;
}

export const PROVIDER_PREFIXES: readonly ProviderPrefixEntry[] = [
  { prefixes: ["anthropic/"], provider: "Anthropic" },
  { prefixes: ["openai/"], provider: "OpenAI" },
  { prefixes: ["google/"], provider: "Google" },
  { prefixes: ["xai/", "x-ai/"], provider: "xAI" },
  { prefixes: ["zai/", "z-ai/"], provider: "zAI" },
  { prefixes: ["moonshot/", "moonshotai/"], provider: "Kimi" },
  { prefixes: ["mistralai/"], provider: "Mistral" },
  { prefixes: ["nvidia/"], provider: "NVIDIA" },
  { prefixes: ["minimax/"], provider: "MiniMax" },
  { prefixes: ["qwen/"], provider: "Qwen" },
  { prefixes: ["deepseek/"], provider: "DeepSeek" },
];

export const PROVIDER_ID_TO_API_KEY_PROVIDER: Record<ProviderId, ApiKeyProvider> = {
  xAI: "xai",
  zAI: "zai",
  Anthropic: "anthropic",
  OpenAI: "openai",
  Kimi: "kimi",
  Mistral: "mistral",
  Google: "google",
  NVIDIA: "nvidia",
  MiniMax: "minimax",
  Qwen: "qwen",
  DeepSeek: "deepseek",
};

export const BYOK_BASE_URL: Partial<Record<ApiKeyProvider, string>> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "",
  google: "",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  kimi: "https://api.moonshot.cn/v1",
  minimax: "",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  zai: "",
  saia: SAIA_BASE_URL,
};

export const OPENAI_COMPATIBLE_BYOK_PROVIDERS: ReadonlySet<ApiKeyProvider> = new Set([
  "openrouter",
  "openai",
  "xai",
  "mistral",
  "deepseek",
  "kimi",
  "qwen",
  "nvidia",
  "saia",
]);

export function providerFromModelId(modelId: string): ProviderId | null {
  const lower = modelId.toLowerCase();
  for (const entry of PROVIDER_PREFIXES) {
    if (entry.prefixes.some((p) => lower.startsWith(p))) {
      return entry.provider;
    }
  }
  if (lower.includes("kimi")) return "Kimi";
  if (lower.includes("mistral")) return "Mistral";
  if (lower.includes("qwen")) return "Qwen";
  return null;
}

export function gatewayFromModelId(modelId: string): ModelGateway {
  return modelId.toLowerCase().startsWith(SAIA_PREFIX) ? "saia" : "openrouter";
}

export function stripGatewayPrefix(modelId: string): string {
  return modelId.toLowerCase().startsWith(SAIA_PREFIX)
    ? modelId.slice(SAIA_PREFIX.length)
    : modelId;
}

const SAIA_VENDOR_RULES: ReadonlyArray<{ match: string; vendor: string }> = [
  { match: "nemotron", vendor: "NVIDIA" },
  { match: "llama", vendor: "Meta" },
  { match: "internvl", vendor: "InternVL" },
  { match: "deepseek", vendor: "DeepSeek" },
  { match: "devstral", vendor: "Mistral" },
  { match: "codestral", vendor: "Mistral" },
  { match: "mistral", vendor: "Mistral" },
  { match: "qwen", vendor: "Qwen" },
  { match: "gemma", vendor: "Google" },
  { match: "glm", vendor: "zAI" },
  { match: "gpt-oss", vendor: "OpenAI" },
  { match: "apertus", vendor: "Apertus" },
  { match: "teuken", vendor: "Teuken" },
];

export function saiaVendorFromId(apiModelId: string): string {
  const lower = apiModelId.toLowerCase();
  for (const rule of SAIA_VENDOR_RULES) {
    if (lower.includes(rule.match)) return rule.vendor;
  }
  return "SAIA";
}

export function saiaWeightForModel(paramB: number): number {
  if (paramB >= 300) return 4;
  if (paramB >= 60) return 3;
  if (paramB >= 20) return 2;
  return 1;
}

export interface SaiaKnownModel {
  id: string;
  name: string;
  vendor: string;
  paramB: number;
}

// Fallback list used only when a team has no live SAIA key (display-only).
// With a valid SAIA key the catalog is fetched live from /v1/models.
export const SAIA_KNOWN_MODELS: readonly SaiaKnownModel[] = [
  { id: "meta-llama-3.1-8b-instruct", name: "Llama 3.1 8B Instruct", vendor: "Meta", paramB: 8 },
  { id: "teuken-7b-instruct-research", name: "Teuken 7B Research", vendor: "Teuken", paramB: 7 },
  { id: "qwen3-coder-30b-a3b-instruct", name: "Qwen3 Coder 30B A3B", vendor: "Qwen", paramB: 30 },
  { id: "qwen3-30b-a3b-instruct-2507", name: "Qwen3 30B A3B", vendor: "Qwen", paramB: 30 },
  { id: "qwen3-omni-30b-a3b-instruct", name: "Qwen3 Omni 30B A3B", vendor: "Qwen", paramB: 30 },
  { id: "internvl3.5-30b-a3b", name: "InternVL3.5 30B A3B", vendor: "InternVL", paramB: 30 },
  { id: "qwen3.6-35b-a3b", name: "Qwen3.6 35B A3B", vendor: "Qwen", paramB: 35 },
  { id: "gemma-4-31b-it", name: "Gemma 4 31B", vendor: "Google", paramB: 31 },
  { id: "medgemma-27b-it", name: "MedGemma 27B", vendor: "Google", paramB: 27 },
  { id: "apertus-70b-instruct-2509", name: "Apertus 70B", vendor: "Apertus", paramB: 70 },
  {
    id: "deepseek-r1-distill-llama-70b",
    name: "DeepSeek R1 Distill Llama 70B",
    vendor: "DeepSeek",
    paramB: 70,
  },
  { id: "openai-gpt-oss-120b", name: "OpenAI GPT-OSS 120B", vendor: "OpenAI", paramB: 120 },
  { id: "qwen3.5-122b-a10b", name: "Qwen3.5 122B A10B", vendor: "Qwen", paramB: 122 },
  { id: "devstral-2-123b-instruct-2512", name: "Devstral 2 123B", vendor: "Mistral", paramB: 123 },
  { id: "glm-4.7", name: "GLM 4.7", vendor: "zAI", paramB: 100 },
  { id: "qwen3.5-397b-a17b", name: "Qwen3.5 397B A17B", vendor: "Qwen", paramB: 397 },
  {
    id: "mistral-large-3-675b-instruct-2512",
    name: "Mistral Large 3 675B",
    vendor: "Mistral",
    paramB: 400,
  },
];
