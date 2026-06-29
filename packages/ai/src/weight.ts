import type { PlanId } from "@codecrawler/shared";

export const WEIGHT_BASELINE_USD_PER_1K = 0.02;
export const WEIGHT_PLAN_BANDS = { free: 1.5, plus: 3 } as const;

export function computeWeight(promptPricePer1k: number, completionPricePer1k: number): number {
  const blended = promptPricePer1k + completionPricePer1k;
  if (!Number.isFinite(blended) || blended <= 0) {
    return 1;
  }
  const raw = blended / WEIGHT_BASELINE_USD_PER_1K;
  const rounded = Math.round(raw * 100) / 100;
  return Math.max(1, rounded);
}

export function minPlanForWeight(weight: number): PlanId {
  if (weight <= WEIGHT_PLAN_BANDS.free) return "free";
  if (weight <= WEIGHT_PLAN_BANDS.plus) return "plus";
  return "pro";
}
