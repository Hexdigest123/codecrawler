import type { ApiKeyProvider, ProviderId } from "@codecrawler/shared";
import { env } from "@codecrawler/shared";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { getByokKeyByApiKeyProvider } from "./byok";
import {
  BYOK_BASE_URL,
  OPENAI_COMPATIBLE_BYOK_PROVIDERS,
  PROVIDER_ID_TO_API_KEY_PROVIDER,
  SAIA_BASE_URL,
  stripGatewayPrefix,
} from "./providers";
import { resolveProvider } from "./resolve";

export interface CreateLangChainClientOpts {
  modelId: string;
  orgId?: string;
  temperature?: number;
}

export async function createLangChainClient(
  opts: CreateLangChainClientOpts,
): Promise<BaseChatModel> {
  const { modelId, orgId, temperature } = opts;
  const resolved = await resolveProvider(modelId, orgId);

  if (resolved.gateway === "saia") {
    return buildSaiaClient({ modelId, orgId, temperature });
  }

  const provider = resolved.provider;
  const apiKeyProvider = provider ? PROVIDER_ID_TO_API_KEY_PROVIDER[provider] : undefined;

  if (resolved.billingMode === "byok" && orgId && provider && apiKeyProvider) {
    const client = await buildByokClient({
      modelId,
      orgId,
      apiKeyProvider,
      provider,
      temperature,
    });
    if (client) return client;
  }

  return new ChatOpenAI({
    model: modelId,
    apiKey: env.OPENROUTER_API_KEY,
    configuration: { baseURL: env.OPENROUTER_BASE_URL },
    temperature,
    timeout: env.AI_TIMEOUT_MS,
  });
}

async function buildSaiaClient(opts: {
  modelId: string;
  orgId: string | undefined;
  temperature: number | undefined;
}): Promise<BaseChatModel> {
  const { modelId, orgId, temperature } = opts;
  const apiModelId = stripGatewayPrefix(modelId);
  if (!orgId) {
    throw new Error("SAIA models require a team (orgId) with a registered SAIA API key");
  }
  const key = await getByokKeyByApiKeyProvider(orgId, "saia");
  if (!key) {
    throw new Error("No valid SAIA API key registered for this team");
  }
  return new ChatOpenAI({
    model: apiModelId,
    apiKey: key,
    configuration: { baseURL: SAIA_BASE_URL ?? BYOK_BASE_URL.saia },
    temperature,
    timeout: env.AI_TIMEOUT_MS,
  });
}

async function buildByokClient(opts: {
  modelId: string;
  orgId: string;
  apiKeyProvider: ApiKeyProvider;
  provider: ProviderId;
  temperature: number | undefined;
}): Promise<BaseChatModel | null> {
  const { modelId, orgId, apiKeyProvider, provider, temperature } = opts;
  if (provider !== "zAI" && provider !== "MiniMax") {
    const directKey = await getByokKeyByApiKeyProvider(orgId, apiKeyProvider);
    if (directKey) {
      if (apiKeyProvider === "anthropic") {
        return new ChatAnthropic({
          model: modelId,
          apiKey: directKey,
          temperature,
          clientOptions: { timeout: env.AI_TIMEOUT_MS },
        });
      }
      if (apiKeyProvider === "google") {
        return new ChatGoogleGenerativeAI({ model: modelId, apiKey: directKey, temperature });
      }
      const baseURL = BYOK_BASE_URL[apiKeyProvider];
      if (OPENAI_COMPATIBLE_BYOK_PROVIDERS.has(apiKeyProvider) && baseURL) {
        return new ChatOpenAI({
          model: modelId,
          apiKey: directKey,
          configuration: { baseURL },
          temperature,
          timeout: env.AI_TIMEOUT_MS,
        });
      }
    }
  }
  const openRouterKey = await getByokKeyByApiKeyProvider(orgId, "openrouter");
  if (openRouterKey) {
    return new ChatOpenAI({
      model: modelId,
      apiKey: openRouterKey,
      configuration: { baseURL: BYOK_BASE_URL.openrouter },
      temperature,
      timeout: env.AI_TIMEOUT_MS,
    });
  }
  return null;
}
