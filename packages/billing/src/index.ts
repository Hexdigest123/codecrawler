import { db, schema } from "@codecrawler/db";
import type { PlanId } from "@codecrawler/shared";
import { env } from "@codecrawler/shared";
import createMollieClientFactory, { SequenceType } from "@mollie/api-client";
import { and, eq } from "drizzle-orm";

type Mollie = ReturnType<typeof createMollieClientFactory>;

type PaidPlan = Exclude<PlanId, "free">;
type PaymentMetadata = { orgId?: string; plan?: PaidPlan };

export interface MolliePlanInfo {
  name: string;
  amountEur: number;
  description: string;
}

export interface StartCheckoutInput {
  orgId: string;
  plan: PaidPlan;
  redirectUrl: string;
  webhookUrl: string;
}

export interface StartCheckoutResult {
  checkoutUrl: string;
  customerId: string;
  paymentId: string;
}

export interface SyncPaymentResult {
  orgId?: string;
  status: string;
  plan?: PaidPlan;
  subscriptionId?: string;
}

export interface SyncSubscriptionResult {
  status: string;
  plan: PlanId;
}

export const MOLLIE_PLANS: Record<PaidPlan, MolliePlanInfo> = {
  plus: {
    name: "Plus",
    amountEur: 29,
    description: "CodeCrawler Plus — monthly",
  },
  pro: {
    name: "Pro",
    amountEur: 99,
    description: "CodeCrawler Pro — monthly",
  },
};

let mollieSingleton: Mollie | null = null;

export async function createMollieClient(): Promise<Mollie> {
  if (mollieSingleton) {
    return mollieSingleton;
  }
  const apiKey = env.MOLLIE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("MOLLIE_API_KEY is not configured");
  }
  mollieSingleton = createMollieClientFactory({ apiKey });
  return mollieSingleton;
}

function euros(amount: number): { currency: "EUR"; value: string } {
  return { currency: "EUR", value: amount.toFixed(2) };
}

function addMonth(from: Date): Date {
  const next = new Date(from.getTime());
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

async function loadSubscription(orgId: string) {
  const rows = await db
    .select()
    .from(schema.teamSubscriptions)
    .where(eq(schema.teamSubscriptions.orgId, orgId))
    .limit(1);
  return rows[0] ?? null;
}

async function getOrgBillingProfile(orgId: string): Promise<{ name: string; email: string }> {
  const orgRows = await db
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .limit(1);
  const name = orgRows[0]?.name ?? `CodeCrawler team ${orgId}`;
  const ownerRows = await db
    .select({ email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")))
    .limit(1);
  const email = ownerRows[0]?.email ?? `billing+${orgId}@codecrawler.local`;
  return { name, email };
}

type SubscriptionUpdate = Partial<{
  mollieCustomerId: string;
  mollieSubscriptionId: string;
  plan: PlanId;
  status: string;
  currentPeriodEnd: Date;
}>;

async function upsertOrg(orgId: string, fields: SubscriptionUpdate): Promise<void> {
  await db
    .insert(schema.teamSubscriptions)
    .values({ orgId, ...fields })
    .onConflictDoUpdate({
      target: schema.teamSubscriptions.orgId,
      set: fields,
    });
}

export async function ensureMollieCustomer(orgId: string): Promise<{ customerId: string }> {
  const existing = await loadSubscription(orgId);
  if (existing?.mollieCustomerId) {
    return { customerId: existing.mollieCustomerId };
  }
  const { name, email } = await getOrgBillingProfile(orgId);
  try {
    const mollie = await createMollieClient();
    const customer = await mollie.customers.create({
      name,
      email,
      metadata: { orgId },
    });
    await upsertOrg(orgId, { mollieCustomerId: customer.id });
    return { customerId: customer.id };
  } catch (error) {
    throw new Error(`Failed to create Mollie customer for org ${orgId}: ${stringifyError(error)}`);
  }
}

export async function startCheckout(input: StartCheckoutInput): Promise<StartCheckoutResult> {
  const { orgId, plan, redirectUrl, webhookUrl } = input;
  const { customerId } = await ensureMollieCustomer(orgId);
  const planInfo = MOLLIE_PLANS[plan];
  try {
    const mollie = await createMollieClient();
    const payment = await mollie.customerPayments.create({
      customerId,
      amount: euros(planInfo.amountEur),
      description: planInfo.description,
      sequenceType: SequenceType.first,
      redirectUrl,
      webhookUrl,
      metadata: { orgId, plan },
    });
    const checkoutUrl = readCheckoutUrl(payment);
    if (!checkoutUrl) {
      throw new Error("Mollie first payment did not return a checkout URL");
    }
    return { checkoutUrl, customerId, paymentId: payment.id };
  } catch (error) {
    throw new Error(
      `Failed to start checkout for org ${orgId} (${plan}): ${stringifyError(error)}`,
    );
  }
}

export function parsePaymentIdFromWebhook(body: { id?: unknown }): string | null {
  return typeof body?.id === "string" && body.id.trim() !== "" ? body.id : null;
}

export async function syncPayment(paymentId: string): Promise<SyncPaymentResult> {
  let mollie: Mollie;
  try {
    mollie = await createMollieClient();
  } catch (error) {
    throw new Error(`syncPayment needs Mollie: ${stringifyError(error)}`);
  }
  const payment = await mollie.payments.get(paymentId);
  const meta = (payment.metadata ?? {}) as PaymentMetadata;
  const orgId = meta.orgId;
  const plan = meta.plan;
  const status = payment.status;

  if (orgId && plan) {
    await upsertOrg(orgId, { plan, status });
    if (status === "paid") {
      await tryCreateSubscription(orgId, plan, paymentId);
    }
  }

  const row = orgId ? await loadSubscription(orgId) : null;
  return {
    orgId,
    status,
    plan,
    subscriptionId: row?.mollieSubscriptionId ?? undefined,
  };
}

async function tryCreateSubscription(
  orgId: string,
  plan: PaidPlan,
  paymentId: string,
): Promise<boolean> {
  const row = await loadSubscription(orgId);
  if (!row?.mollieCustomerId || row.mollieSubscriptionId) {
    return false;
  }
  const webhookUrl = env.MOLLIE_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return false;
  }
  const planInfo = MOLLIE_PLANS[plan];
  try {
    const mollie = await createMollieClient();
    const subscription = await mollie.customerSubscriptions.create({
      customerId: row.mollieCustomerId,
      amount: euros(planInfo.amountEur),
      interval: "1 month",
      description: planInfo.description,
      webhookUrl,
      metadata: { orgId, plan, seedPaymentId: paymentId },
    });
    const currentPeriodEnd = parseNextPeriodEnd(subscription.nextPaymentDate);
    await upsertOrg(orgId, {
      mollieSubscriptionId: subscription.id,
      plan,
      status: "active",
      currentPeriodEnd,
    });
    return true;
  } catch {
    return false;
  }
}

export async function syncSubscription(orgId: string): Promise<SyncSubscriptionResult> {
  const row = await loadSubscription(orgId);
  const plan: PlanId = row?.plan ?? "free";
  if (!row?.mollieSubscriptionId || !row?.mollieCustomerId) {
    return { status: row?.status ?? "none", plan };
  }
  try {
    const mollie = await createMollieClient();
    const subscription = await mollie.customerSubscriptions.get(row.mollieSubscriptionId, {
      customerId: row.mollieCustomerId,
    });
    const status = subscription.status;
    const currentPeriodEnd = parseNextPeriodEnd(subscription.nextPaymentDate);
    await upsertOrg(orgId, { status, currentPeriodEnd });
    return { status, plan };
  } catch (error) {
    throw new Error(`Failed to sync subscription for org ${orgId}: ${stringifyError(error)}`);
  }
}

/**
 * On-demand reconciliation used when a webhook may have been missed (e.g. local
 * dev where Mollie cannot reach the API). Works from just the stored
 * `mollieCustomerId`: first re-links a subscription Mollie already created but
 * we never recorded; otherwise seeds one from a paid first payment. In prod the
 * webhook remains authoritative — this is the fallback.
 */
export async function recoverSubscription(orgId: string): Promise<SyncSubscriptionResult> {
  const row = await loadSubscription(orgId);
  const customerId = row?.mollieCustomerId ?? undefined;
  if (!customerId) {
    return { status: row?.status ?? "none", plan: (row?.plan ?? "free") as PlanId };
  }
  // Already tracked? Just resync the known subscription.
  if (row?.mollieSubscriptionId) {
    return syncSubscription(orgId);
  }

  let mollie: Mollie;
  try {
    mollie = await createMollieClient();
  } catch (error) {
    throw new Error(`recoverSubscription needs Mollie: ${stringifyError(error)}`);
  }

  // 1. Recover a subscription Mollie already created but we never recorded.
  try {
    const subs = await mollie.customerSubscriptions.page({ customerId, limit: 50 });
    const live = subs.find((s) => s.status === "active") ?? subs[0];
    if (live) {
      const meta = (live.metadata ?? {}) as PaymentMetadata;
      const recoveredPlan = (meta.plan ?? row?.plan ?? "free") as PlanId;
      await upsertOrg(orgId, {
        mollieSubscriptionId: live.id,
        plan: recoveredPlan,
        status: live.status,
        currentPeriodEnd: parseNextPeriodEnd(live.nextPaymentDate),
      });
      return { status: live.status, plan: recoveredPlan };
    }
  } catch (error) {
    console.warn(`[billing] recover: subscription lookup failed for ${orgId}`, error);
  }

  // 2. No subscription yet — seed one from a paid first payment.
  try {
    const payments = await mollie.customerPayments.page({ customerId, limit: 50 });
    const paid = payments.find((p) => p.status === "paid");
    if (paid) {
      const meta = (paid.metadata ?? {}) as PaymentMetadata;
      const paidPlan = (meta.plan ?? row?.plan ?? "free") as PaidPlan;
      await upsertOrg(orgId, { plan: paidPlan, status: "paid" });
      await tryCreateSubscription(orgId, paidPlan, paid.id);
    }
  } catch (error) {
    console.warn(`[billing] recover: payment lookup failed for ${orgId}`, error);
  }

  const updated = await loadSubscription(orgId);
  return { status: updated?.status ?? "none", plan: (updated?.plan ?? "free") as PlanId };
}

export async function cancelSubscription(orgId: string): Promise<void> {
  const row = await loadSubscription(orgId);
  if (row?.mollieSubscriptionId && row?.mollieCustomerId) {
    try {
      const mollie = await createMollieClient();
      await mollie.customerSubscriptions.cancel(row.mollieSubscriptionId, {
        customerId: row.mollieCustomerId,
      });
    } catch (error) {
      throw new Error(
        `Failed to cancel Mollie subscription for org ${orgId}: ${stringifyError(error)}`,
      );
    }
  }
  await upsertOrg(orgId, { status: "cancelled" });
}

function readCheckoutUrl(payment: { _links?: unknown }): string | null {
  const links = payment._links as { checkout?: { href?: string } } | undefined;
  const href = links?.checkout?.href;
  return typeof href === "string" && href !== "" ? href : null;
}

function parseNextPeriodEnd(nextPaymentDate: string | null | undefined): Date {
  if (!nextPaymentDate) {
    return addMonth(new Date());
  }
  const parsed = new Date(nextPaymentDate);
  return Number.isNaN(parsed.getTime()) ? addMonth(new Date()) : parsed;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "unknown error";
}
