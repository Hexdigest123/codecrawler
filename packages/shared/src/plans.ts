export type PlanId = "free" | "plus" | "pro";

export interface PlanLimits {
  hostedReviewsPerDay: number | null;
  membersPerTeam: number | null;
  teamsPerUser: number | null;
  customSso: boolean;
  maxReviewerWeight: number | null;
  hostedAllowed: boolean;
}

export interface Plan {
  id: PlanId;
  label: string;
  description: string;
  limits: PlanLimits;
}

export function isUnlimited(value: number | null): boolean {
  return value === null;
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    hostedReviewsPerDay: 0,
    membersPerTeam: 5,
    teamsPerUser: 3,
    customSso: false,
    maxReviewerWeight: null,
    hostedAllowed: false,
  },
  plus: {
    hostedReviewsPerDay: 50,
    membersPerTeam: 5,
    teamsPerUser: null,
    customSso: false,
    maxReviewerWeight: 3,
    hostedAllowed: true,
  },
  pro: {
    hostedReviewsPerDay: null,
    membersPerTeam: null,
    teamsPerUser: null,
    customSso: true,
    maxReviewerWeight: null,
    hostedAllowed: true,
  },
};

export const plans: Plan[] = [
  {
    id: "free",
    label: "Free · BYOK only",
    description: "Bring your own API key. No hosted (metered) credits included.",
    limits: PLAN_LIMITS.free,
  },
  {
    id: "plus",
    label: "Plus",
    description: "Hosted review budget for busy teams.",
    limits: PLAN_LIMITS.plus,
  },
  {
    id: "pro",
    label: "Pro",
    description: "Unlimited hosted reviews, custom SSO, any model weight.",
    limits: PLAN_LIMITS.pro,
  },
];

export function getPlanLimits(plan: PlanId): PlanLimits {
  return PLAN_LIMITS[plan];
}

export function planRank(plan: PlanId | null | undefined): number {
  switch (plan) {
    case "plus":
      return 1;
    case "pro":
      return 2;
    default:
      return 0;
  }
}

export function isHostedAllowedForPlan(plan: PlanId): boolean {
  return PLAN_LIMITS[plan].hostedAllowed;
}

export function isModelEligibleForPlan(
  plan: PlanId,
  model: { minPlan?: PlanId | null; byok?: boolean },
): boolean {
  if (plan === "pro") {
    return true;
  }
  if (plan === "plus") {
    return model.byok === true || planRank(model.minPlan) <= 1;
  }
  return model.byok === true;
}
