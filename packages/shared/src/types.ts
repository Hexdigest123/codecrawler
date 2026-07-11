import type { Severity } from "./constants";

export type {
  BillingMode,
  CoverageStrategy,
  DepthTier,
  GraphType,
  ProviderId,
  ReviewAgentMode,
  ReviewNodeRole,
  Severity,
} from "./constants";
export type { PlanId } from "./plans";

export type ApiKeyProvider =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "zai"
  | "kimi"
  | "mistral"
  | "nvidia"
  | "minimax"
  | "qwen"
  | "deepseek"
  | "saia";

export type ReviewStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type VcsProvider = "github" | "gitlab" | "gitea";

export interface ReviewFinding {
  file: string;
  line: number;
  severity: Severity;
  category: string;
  message: string;
  suggestion?: string;
}
