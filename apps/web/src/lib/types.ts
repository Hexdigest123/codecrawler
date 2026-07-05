export type PlanId = "free" | "plus" | "pro";

/** Agentic review depth tier (mirrors @codecrawler/shared DepthTier). */
export type DepthTier = "static" | "quick" | "deep";

export const DEPTH_TIERS: DepthTier[] = ["static", "quick", "deep"];

export const DEPTH_LABEL: Record<DepthTier, string> = {
  static: "Static",
  quick: "Quick",
  deep: "Deep",
};

export const DEPTH_DESCRIPTION: Record<DepthTier, string> = {
  static: "Single-shot review (no tools). Cheapest.",
  quick: "Agentic ReAct loop with read-only repo tools (≤6 steps).",
  deep: "Full agentic exploration (≤12 steps). Plus/Pro only.",
};

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
  role?: string;
  status?: string;
  teams: TeamMembership[];
}

export type NotificationCategoryKey = "reviews" | "teams" | "billing" | "integrations";

export type NotificationSettings = Record<NotificationCategoryKey, boolean>;

export interface NotificationSettingsResponse {
  settings: NotificationSettings;
}

export interface NotificationCategoryMeta {
  key: NotificationCategoryKey;
  label: string;
  description: string;
}

export const NOTIFICATION_CATEGORIES: NotificationCategoryMeta[] = [
  {
    key: "reviews",
    label: "Reviews",
    description: "Review completions, failures, and digests for your pull requests.",
  },
  {
    key: "teams",
    label: "Teams & collaboration",
    description: "Team invitations, membership changes, and role updates.",
  },
  {
    key: "billing",
    label: "Billing & quota",
    description: "Subscriptions, payments, plan changes, and quota warnings.",
  },
  {
    key: "integrations",
    label: "Integrations",
    description: "VCS connections: app installs/uninstalls, broken or expired tokens.",
  },
];

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
  coverageStrategy?: string | null;
  defaultDepth?: DepthTier | null;
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
  depth?: DepthTier | null;
  agentSteps?: number | null;
  toolCalls?: number | null;
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

// Backed by Better Auth's SSO plugin (`@better-auth/sso`). The admin form
// collects a small subset and the API maps it to the plugin's native shape; the
// GET response is the plugin's redacted provider view plus a derived protocol.
export type SsoProtocol = "saml" | "oidc";

export interface SsoProviderDetail {
  providerId: string;
  issuer: string;
  domain: string;
  organizationId: string | null;
  protocol: SsoProtocol | null;
  oidcConfig?: {
    discoveryEndpoint: string;
    clientIdLastFour: string;
    pkce: boolean;
    scopes?: string[];
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    userInfoEndpoint?: string;
    jwksEndpoint?: string;
  } | null;
  samlConfig?: {
    entryPoint: string;
    callbackUrl: string;
    audience?: string;
    wantAssertionsSigned?: boolean;
    authnRequestsSigned?: boolean;
    signatureAlgorithm?: string;
    digestAlgorithm?: string;
    certificate?:
      | {
          fingerprintSha256: string;
          notBefore: string;
          notAfter: string;
          publicKeyAlgorithm: string;
        }
      | { error: string }
      | null;
  } | null;
  spMetadataUrl?: string;
}

// Shape of the form payload POSTed to /api/teams/:id/sso.
export interface SsoFormPayload {
  domain: string;
  protocol: SsoProtocol;
  saml?: { entryURL: string; entityId: string; certificate?: string };
  oidc?: { clientId: string; issuerUrl: string; clientSecret?: string; scopes?: string };
}

export interface AuditEntry {
  id: string;
  action: string;
  actorUserId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type SignupMode = "open" | "closed" | "domain_restricted" | "approval";

export const SIGNUP_MODE_LABEL: Record<SignupMode, string> = {
  open: "Open",
  closed: "Closed",
  domain_restricted: "Domain-restricted",
  approval: "Approval queue",
};

export interface SignupConfig {
  signupMode: SignupMode;
  allowedDomains: string[];
  paymentsEnabled: boolean;
}

export interface AdminStats {
  users: { total: number; admins: number; active: number; pending: number; denied: number };
  teams: { total: number };
  reviews: { total: number; byStatus: Record<string, number> };
  tokens: { spendUsd: number; credits: number; usageCredits: number };
  signups: { pending: number };
  signupMode: SignupMode;
  paymentsEnabled: boolean;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface SignupRequestRow {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  status: string;
  denialReason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface AdminTeam {
  id: string;
  name: string;
  slug: string | null;
  createdAt: string;
  plan: PlanId;
  status: string;
  members: number;
  reviews: number;
  tokenSpendUsd: number;
  credits: number;
}

export interface PasskeyRow {
  id: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
}
