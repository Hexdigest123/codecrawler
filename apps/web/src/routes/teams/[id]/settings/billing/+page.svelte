<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { ApiError, api } from "$lib/api";
  import { PLAN_LABEL, type BillingDetail, type PlanId } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const billing = $derived<BillingDetail>(data.billing);
  const isFree = $derived(billing.plan === "free");
  const canSync = $derived(!isFree || billing.hasMollieCustomer === true);

  let busyPlan = $state<PlanId | "sync" | null>(null);
  let actionError = $state<string | null>(null);
  let actionInfo = $state<string | null>(null);

  function formatDate(iso?: string): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function statusLabel(status: string): string {
    switch (status) {
      case "active":
        return "Active";
      case "cancelled":
        return "Cancelled";
      case "past_due":
        return "Past due";
      case "trialing":
        return "Trialing";
      default:
        return status;
    }
  }

  function priceLabel(priceEur: number): string {
    if (priceEur === 0) return "€0";
    return `€${priceEur}`;
  }

  async function upgrade(plan: PlanId) {
    if (plan === "free" || busyPlan) return;
    busyPlan = plan;
    actionError = null;
    actionInfo = null;
    try {
      const { checkoutUrl } = await api<{ checkoutUrl: string }>(
        `/api/teams/${data.teamId}/billing/checkout`,
        { method: "POST", body: JSON.stringify({ plan }) },
      );
      if (checkoutUrl) {
        window.location.assign(checkoutUrl);
      } else {
        actionError = "Checkout could not be started. Please try again.";
      }
    } catch (err) {
      actionError =
        err instanceof ApiError
          ? err.message
          : "Checkout is unavailable right now. Mollie may not be configured.";
    } finally {
      busyPlan = null;
    }
  }

  async function downgrade() {
    if (busyPlan) return;
    if (
      !confirm(
        "Downgrade to the Free plan? Paid features end at the start of the next billing period.",
      )
    )
      return;
    busyPlan = "free";
    actionError = null;
    actionInfo = null;
    try {
      await api<{ ok: boolean }>(`/api/teams/${data.teamId}/billing/cancel`, {
        method: "POST",
      });
      actionInfo =
        "Subscription cancelled. Your plan changes to Free at the next period.";
      await invalidateAll();
    } catch (err) {
      actionError =
        err instanceof ApiError
          ? err.message
          : "Could not cancel the subscription.";
    } finally {
      busyPlan = null;
    }
  }

  async function syncNow() {
    if (busyPlan) return;
    busyPlan = "sync";
    actionError = null;
    actionInfo = null;
    try {
      await api<{ ok: boolean }>(`/api/teams/${data.teamId}/billing/sync`, {
        method: "POST",
      });
      actionInfo = "Reconciled with Mollie.";
      await invalidateAll();
    } catch (err) {
      actionError =
        err instanceof ApiError
          ? err.message
          : "Could not sync with Mollie right now. It may not be configured.";
    } finally {
      busyPlan = null;
    }
  }
</script>

<svelte:head>
  <title>Billing &amp; plans — {data.team?.organization?.name ?? "Team"} — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <header class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <div class="flex items-center gap-3">
        <h1 class="text-2xl font-semibold tracking-tight">Billing &amp; plans</h1>
        <span
          class="rounded-full border border-neutral-300 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-700"
        >
          {data.team ? PLAN_LABEL[data.team.plan] : "—"}
        </span>
      </div>
      <p class="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
        Choose the plan that fits your team. Upgrades are pro-rated by Mollie and take effect
        immediately; downgrades apply at the next period. Checkout is processed by Mollie — your
        card details never touch CodeCrawler.
      </p>
    </div>
    {#if canSync}
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={syncNow}
          disabled={busyPlan !== null}
          title="Reconcile the subscription state with Mollie"
          class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium bg-white hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        >
          {busyPlan === "sync" ? "Syncing…" : "Sync now"}
        </button>
      </div>
    {/if}
  </header>

  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="Current subscription"
  >
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
      Current subscription
    </h2>
    <dl class="mt-4 grid gap-4 sm:grid-cols-3">
      <div>
        <dt class="text-xs uppercase tracking-wide text-neutral-400">Plan</dt>
        <dd class="mt-1 text-lg font-semibold">
          {PLAN_LABEL[billing.plan] ?? billing.plan}
        </dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-neutral-400">Status</dt>
        <dd class="mt-1 text-lg font-semibold">{statusLabel(billing.status)}</dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-neutral-400">
          Current period ends
        </dt>
        <dd class="mt-1 text-lg font-semibold">{formatDate(billing.currentPeriodEnd)}</dd>
      </div>
    </dl>
    {#if isFree}
      <p class="mt-4 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700 dark:bg-brand-950 dark:text-brand-300">
        Free plan — BYOK only. Reviews run on your own API keys; there are no hosted credits.
      </p>
    {/if}
  </section>

  {#if actionError}
    <p role="alert" class="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
      {actionError}
    </p>
  {/if}
  {#if actionInfo}
    <p role="status" class="rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
      {actionInfo}
    </p>
  {/if}

  <div class="grid gap-5 md:grid-cols-3">
    {#each billing.plans as plan (plan.id)}
      <section
        class="relative flex flex-col rounded-xl border p-5 {plan.isCurrent
          ? "border-brand-500 ring-1 ring-brand-500 dark:border-brand-400 dark:ring-brand-400"
          : "border-neutral-200 dark:border-neutral-800"}"
        aria-label={`${plan.label} plan`}
      >
        {#if plan.isCurrent}
          <span
            class="absolute right-4 top-4 rounded-full bg-brand-600 px-2 py-0.5 text-xs font-semibold text-white"
          >
            Current
          </span>
        {/if}

        <h3 class="text-lg font-semibold tracking-tight">{plan.label}</h3>
        <p class="mt-2 text-3xl font-semibold">
          {priceLabel(plan.priceEur)}
          <span class="ml-1 text-sm font-normal text-neutral-500">/mo</span>
        </p>

        {#if plan.id === "free"}
          <p class="mt-2 rounded-md bg-neutral-100 px-2 py-1.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            BYOK only — bring your own API keys; no hosted credits.
          </p>
        {/if}

        <ul class="mt-4 flex flex-col gap-2 text-sm text-neutral-600 dark:text-neutral-400">
          {#each plan.features as feature (feature)}
            <li class="flex items-start gap-2">
              <span
                aria-hidden="true"
                class="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500"
              ></span>
              <span>{feature}</span>
            </li>
          {/each}
        </ul>

        <div class="mt-6 flex flex-1 items-end">
          {#if plan.isCurrent}
            <button
              type="button"
              disabled
              class="w-full cursor-default rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
            >
              Current plan
            </button>
          {:else if plan.id === "free"}
            <button
              type="button"
              onclick={downgrade}
              disabled={busyPlan !== null}
              class="w-full rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium bg-white hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
            >
              {busyPlan === "free" ? "Cancelling…" : "Downgrade"}
            </button>
          {:else}
            <button
              type="button"
              onclick={() => upgrade(plan.id)}
              disabled={busyPlan !== null}
              class="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-50"
            >
              {busyPlan === plan.id ? "Redirecting…" : `Upgrade to ${plan.label}`}
            </button>
          {/if}
        </div>
      </section>
    {/each}
  </div>
</section>
