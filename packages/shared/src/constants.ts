import { env } from "./env";

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

export const GRAPH_TYPES = ["pr_review"] as const;
export type GraphType = (typeof GRAPH_TYPES)[number];

export const COVERAGE_STRATEGIES = ["by_commit", "by_filegroup", "full"] as const;
export type CoverageStrategy = (typeof COVERAGE_STRATEGIES)[number];

export const DEFAULT_COVERAGE_STRATEGY: CoverageStrategy = "by_filegroup";

export const REVIEW_NODE_ROLES = ["orchestrator", "reviewer", "summarizer"] as const;
export type ReviewNodeRole = (typeof REVIEW_NODE_ROLES)[number];

export const BILLING_MODES = ["hosted", "byok", "mixed"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

// Agentic review depth. "static" is the legacy single-shot path (no tools);
// "quick"/"deep" run the ReAct agent loop with read-only repo tools, differing
// only in step/budget caps (see REVIEW_AGENT_MAX_STEPS_* / REVIEW_AGENT_BUDGET_USD_*).
export const DEPTH_TIERS = ["static", "quick", "deep"] as const;
export type DepthTier = (typeof DEPTH_TIERS)[number];
export const DEFAULT_DEPTH_TIER: DepthTier = "quick";

export const REVIEW_AGENT_MODES = ["off", "auto", "quick", "deep"] as const;
export type ReviewAgentMode = (typeof REVIEW_AGENT_MODES)[number];

/**
 * Resolve the effective depth tier from the global REVIEW_AGENT_MODE flag,
 * optionally overridden by a per-run value (set by the API when the trigger
 * pins a tier, e.g. `/codecrawler deep`). Lives in shared so the API preflight,
 * the agents graph, and the quota projection all agree on a tier.
 *
 * - `off` always yields "static" (the legacy single-shot path).
 * - `quick`/`deep` force that tier (an explicit "deep" override is clamped to
 *   "quick" when the global mode is "quick").
 * - `auto` resolves an override, else defaults to "quick".
 */
export function resolveDepthFromMode(override?: DepthTier): DepthTier {
  if (override === "static" || override === "quick" || override === "deep") {
    if (env.REVIEW_AGENT_MODE === "off") return "static";
    if (env.REVIEW_AGENT_MODE === "quick" && override === "deep") return "quick";
    return override;
  }
  switch (env.REVIEW_AGENT_MODE) {
    case "quick":
      return "quick";
    case "deep":
      return "deep";
    case "auto":
      return "quick";
    default:
      return "static";
  }
}

export const SEVERITIES = ["critical", "high", "medium", "low", "nitpick"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const DEFAULT_NODE_MODELS: Record<ReviewNodeRole, string> = {
  orchestrator: "minimax/minimax-m3",
  reviewer: "minimax/minimax-m3",
  summarizer: "minimax/minimax-m3",
};
