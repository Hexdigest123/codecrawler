import { pgEnum } from "drizzle-orm/pg-core";

export const planEnum = pgEnum("plan", ["free", "plus", "pro"]);

export const providerEnum = pgEnum("provider", [
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "xai",
  "zai",
  "kimi",
  "mistral",
  "nvidia",
  "minimax",
  "qwen",
  "deepseek",
  "saia",
]);

export const graphTypeEnum = pgEnum("graph_type", ["pr_review"]);

export const coverageStrategyEnum = pgEnum("coverage_strategy", [
  "by_commit",
  "by_filegroup",
  "full",
]);

export const billingModeEnum = pgEnum("billing_mode", ["hosted", "byok", "mixed"]);

export const reviewDepthEnum = pgEnum("review_depth", ["static", "quick", "deep"]);

export const reviewStatusEnum = pgEnum("review_status", [
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const reviewCategoryEnum = pgEnum("review_category", [
  "possible_issue",
  "security",
  "performance",
  "nitpick",
  "praise",
]);

export const severityEnum = pgEnum("severity", ["critical", "high", "medium", "low", "nitpick"]);

export const apiKeyStatusEnum = pgEnum("api_key_status", ["valid", "invalid", "unverified"]);

export const vcsProviderEnum = pgEnum("vcs_provider", ["github", "gitlab", "gitea"]);

export const vcsKindEnum = pgEnum("vcs_kind", ["oauth", "github_app"]);
