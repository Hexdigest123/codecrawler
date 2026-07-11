import { z } from "zod";

export const PROVIDER_VALUES = [
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

export const COVERAGE_VALUES = ["by_commit", "by_filegroup", "full"] as const;

export const createTeamSchema = z.object({
  name: z.string().min(1),
});

export const createProjectSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(["github", "gitlab", "gitea"]),
  repoFullName: z.string().min(1),
  pollingEnabled: z.boolean().optional(),
});

export const createApiKeySchema = z.object({
  provider: z.enum(PROVIDER_VALUES),
  label: z.string().min(1),
  key: z.string().min(1),
});

export const putAgentProfileSchema = z.object({
  nodeModels: z.record(z.string(), z.string()).optional(),
  coverageStrategy: z.enum(COVERAGE_VALUES).optional(),
  defaultDepth: z.enum(["static", "quick", "deep"]).optional(),
});

export const putGraphNodeSchema = z.object({
  modelId: z.string().min(1),
});

export const vcsConnectSchema = z.object({
  orgId: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  token: z.string().min(1),
});

export const triggerReviewSchema = z.object({
  repoPath: z.string().min(1).optional(),
  depth: z.enum(["static", "quick", "deep"]).optional(),
  synthetic: z
    .object({
      pr: z.unknown(),
      diff: z.unknown(),
    })
    .optional(),
});

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["member", "admin"]),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(["member", "admin", "owner"]),
});

// SSO provider config — payload is mapped to Better Auth's
// `registerSSOProvider`/`updateSSOProvider` shapes in the route handler. The
// `protocol` discriminator selects which sub-config is required. `providerId`
// is a stable per-org slug (`org-${orgId}`) so callback URLs stay stable across
// reconfiguration.
export const samlFormSchema = z.object({
  entryURL: z.string().url(),
  entityId: z.string().min(1),
  certificate: z.string().optional(),
});

export const oidcFormSchema = z.object({
  clientId: z.string().min(1),
  issuerUrl: z.string().url(),
  clientSecret: z.string().optional(),
  scopes: z.string().optional(),
});

export const upsertSsoSchema = z.object({
  domain: z.string().min(1),
  protocol: z.enum(["saml", "oidc"]),
  saml: samlFormSchema.optional(),
  oidc: oidcFormSchema.optional(),
});

export const resolveSsoSchema = z.object({
  email: z.string().email(),
});

export const checkoutSchema = z.object({
  plan: z.enum(["plus", "pro"]),
});

export const changePasswordSchema = z.object({
  newPassword: z.string().min(8),
  currentPassword: z.string().min(1),
});

export const changeEmailSchema = z.object({
  newEmail: z.string().email(),
});

export const notificationSettingsSchema = z.object({
  reviews: z.boolean(),
  teams: z.boolean(),
  billing: z.boolean(),
  integrations: z.boolean(),
});

export const enable2faSchema = z.object({
  password: z.string().min(1),
});

export const verify2faSchema = z.object({
  code: z.string().min(4).max(10),
});

export const disable2faSchema = z.object({
  password: z.string().min(1),
});

export const denySignupSchema = z.object({ reason: z.string().optional() });

export const BILLING_PLAN_CATALOG = [
  {
    id: "free" as const,
    label: "Free",
    priceEur: 0,
    features: [
      "BYOK exclusively — bring your own API keys",
      "Unlimited reviews via BYOK",
      "3 teams",
      "5 members / team",
    ],
  },
  {
    id: "plus" as const,
    label: "Plus",
    priceEur: 29,
    features: ["50 hosted reviews / day", "Hosted + BYOK", "Unlimited teams", "5 members / team"],
  },
  {
    id: "pro" as const,
    label: "Pro",
    priceEur: 99,
    features: [
      "Unlimited hosted reviews",
      "Custom SSO",
      "Any model weight",
      "Unlimited teams & members",
    ],
  },
];
