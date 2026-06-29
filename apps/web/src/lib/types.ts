export type PlanId = "free" | "plus" | "pro";

export const PLAN_RANK: Record<PlanId, number> = {
  free: 0,
  plus: 1,
  pro: 2,
};

export const PLAN_LABEL: Record<PlanId, string> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
};

export const API_KEY_PROVIDERS = [
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
] as const;

export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

export interface User {
  id: string;
  email: string;
  name?: string | null;
}

export interface TeamMembership {
  organization: { id: string; name: string; slug: string };
  role: string;
  plan: PlanId;
}

export interface MeResponse {
  user: User;
  teams: TeamMembership[];
}

export interface UsageState {
  used: number;
  limit: number | null;
}

export interface TeamUsage {
  prReview: UsageState;
}

export interface TeamDetail {
  organization: { id: string; name: string; slug: string };
  role: string;
  plan: PlanId;
  status?: string;
  membersCount?: number;
  members?: Array<{ id: string }>;
  createdAt?: string;
  logo?: string | null;
  usage?: TeamUsage;
}

export interface Project {
  id: string;
  orgId?: string | null;
  name: string;
  provider?: string | null;
  repoFullName?: string | null;
}

export interface ModelOption {
  id: string;
  name: string;
  provider?: string;
  vendor?: string;
  gateway?: "openrouter" | "saia";
  weight: number | string;
  minPlan: PlanId;
  byok: boolean;
}

export interface NodeModels {
  orchestrator?: string;
  reviewer?: string;
  summarizer?: string;
}

export interface AgentProfile {
  id?: string;
  nodeModels: NodeModels;
}

export type ApiKeyStatus = "valid" | "invalid" | "unverified";

export interface ApiKeyRow {
  id: string;
  provider: ApiKeyProvider;
  label?: string | null;
  status: ApiKeyStatus;
  lastVerifiedAt?: string | null;
}

export interface BillingPlan {
  id: PlanId;
  label: string;
  priceEur: number;
  features: string[];
  isCurrent: boolean;
}

export interface BillingDetail {
  plan: PlanId;
  status: string;
  currentPeriodEnd?: string;
  hasMollieCustomer?: boolean;
  plans: BillingPlan[];
}

export interface PullRequest {
  id: string;
  externalNumber?: number | null;
  title?: string | null;
  author?: string | null;
  state?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  openedAt?: string | null;
}

export interface ProjectPullsResponse {
  project?: Project | null;
  pulls: PullRequest[];
}

export interface ReviewFinding {
  id?: string;
  file?: string | null;
  line?: number | null;
  severity: string;
  category: string;
  message: string;
  suggestion?: string | null;
}

export interface Review {
  id: string;
  status: string;
  walkthrough?: string | null;
  billingMode?: string | null;
  creditsCost?: string | number;
  tokenSpendUsd?: string | number;
  modelIds?: string[] | null;
  source?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
}

export interface DiffFile {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

export interface Diff {
  files: DiffFile[];
}

export interface ReviewPullRequest {
  id: string;
  externalNumber?: number | null;
  title?: string | null;
  author?: string | null;
  state?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  htmlUrl?: string | null;
  openedAt?: string | null;
}

export interface ReviewProject {
  id: string;
  name: string;
  provider?: string | null;
  repoFullName?: string | null;
}

export interface ReviewResponse {
  review: Review;
  pullRequest: ReviewPullRequest | null;
  project: ReviewProject | null;
  diff: Diff | null;
  findings: ReviewFinding[];
}

export interface TriggerReviewResponse {
  reviewId: string;
  status: string;
}

export interface OpenPullRequest {
  number: number;
  title: string;
  author: string;
  state: "open" | "closed";
  headSha: string;
  baseSha: string;
  htmlUrl: string;
  updatedAt?: string;
}

export interface OpenPullRequestsResponse {
  items: OpenPullRequest[];
}

export interface ProjectReviewListItem {
  id: string;
  status: string;
  source?: string | null;
  billingMode?: string | null;
  creditsCost?: string | number;
  walkthrough?: string | null;
  createdAt: string;
  completedAt?: string | null;
  pullRequest: {
    externalNumber?: number | null;
    title?: string | null;
    author?: string | null;
    htmlUrl?: string | null;
  };
}

export interface ProjectReviewsResponse {
  items: ProjectReviewListItem[];
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function planRank(plan: string): number {
  if (plan === "plus") return PLAN_RANK.plus;
  if (plan === "pro") return PLAN_RANK.pro;
  return PLAN_RANK.free;
}

export type MemberRole = "owner" | "admin" | "member";

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: MemberRole;
  createdAt: string;
}

export interface Invitation {
  id: string;
  organizationId?: string;
  organizationName?: string;
  email: string;
  role: MemberRole;
  status: string;
  expiresAt: string;
}

export type SsoProvider = "saml" | "oidc";

export interface SsoConfig {
  domain: string;
  providerId: SsoProvider;
  config: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  action: string;
  actorUserId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}
