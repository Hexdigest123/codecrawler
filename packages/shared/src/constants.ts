export const PROVIDERS = [
  "xAI",
  "zAI",
  "Anthropic",
  "OpenAI",
  "Kimi",
  "Mistral",
  "Google",
  "NVIDIA",
  "MiniMax",
  "Qwen",
  "DeepSeek",
] as const;

export type ProviderId = (typeof PROVIDERS)[number];

export const GRAPH_TYPES = ["pr_review", "security"] as const;
export type GraphType = (typeof GRAPH_TYPES)[number];

export const COVERAGE_STRATEGIES = ["by_commit", "by_filegroup", "full"] as const;
export type CoverageStrategy = (typeof COVERAGE_STRATEGIES)[number];

export const DEFAULT_COVERAGE_STRATEGY: CoverageStrategy = "by_filegroup";

export const REVIEW_NODE_ROLES = [
  "orchestrator",
  "reviewer",
  "summarizer",
  "securityAnalyst",
] as const;
export type ReviewNodeRole = (typeof REVIEW_NODE_ROLES)[number];

export const BILLING_MODES = ["hosted", "byok", "mixed"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export const SEVERITIES = ["critical", "high", "medium", "low", "nitpick"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const DEFAULT_NODE_MODELS: Record<ReviewNodeRole, string> = {
  orchestrator: "minimax/minimax-m3",
  reviewer: "minimax/minimax-m3",
  summarizer: "minimax/minimax-m3",
  securityAnalyst: "minimax/minimax-m3",
};
