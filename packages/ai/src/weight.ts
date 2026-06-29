import type { PlanId } from "@codecrawler/shared";

export const WEIGHT_MIN = 1;
export const WEIGHT_MAX = 10;

export const WEIGHT_1X_USD_PER_1M = 0.3;
export const WEIGHT_7X_USD_PER_1M = 40;

const LOG_1X = Math.log(WEIGHT_1X_USD_PER_1M);
const LOG_7X = Math.log(WEIGHT_7X_USD_PER_1M);
const LOG_SPAN = LOG_7X - LOG_1X;

export const WEIGHT_PLAN_BANDS = { free: 1.5, plus: 3 } as const;

export function computeWeight(promptPricePer1k: number, completionPricePer1k: number): number {
  const blendPer1M = (((promptPricePer1k ?? 0) + (completionPricePer1k ?? 0)) / 2) * 1000;
  if (!Number.isFinite(blendPer1M) || blendPer1M <= 0) {
    return WEIGHT_MIN;
  }
  const raw = 1 + 6 * ((Math.log(blendPer1M) - LOG_1X) / LOG_SPAN);
  const rounded = Math.round(raw * 100) / 100;
  if (rounded < WEIGHT_MIN) return WEIGHT_MIN;
  if (rounded > WEIGHT_MAX) return WEIGHT_MAX;
  return rounded;
}

export function minPlanForWeight(weight: number): PlanId {
  if (weight <= WEIGHT_PLAN_BANDS.free) return "free";
  if (weight <= WEIGHT_PLAN_BANDS.plus) return "plus";
  return "pro";
}
