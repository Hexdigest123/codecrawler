<script lang="ts">
import { goto } from "$app/navigation";
import { SIGNUP_MODE_LABEL, type AdminStats, type SignupMode } from "$lib/types";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const s = $derived<AdminStats>(data.stats);

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtMoney(n: number): string {
  return `$${fmt(n)}`;
}

const STAT_CARDS = $derived([
  {
    label: "Users",
    value: fmt(s.users.total),
    sub: `${s.users.active} active · ${s.users.admins} admins`,
    tone: "default" as const,
  },
  {
    label: "Teams",
    value: fmt(s.teams.total),
    sub: "organizations",
    tone: "default" as const,
  },
  {
    label: "Reviews",
    value: fmt(s.reviews.total),
    sub: `${fmt(s.reviews.byStatus.completed ?? 0)} completed`,
    tone: "default" as const,
  },
  {
    label: "Token spend",
    value: fmtMoney(s.tokens.spendUsd),
    sub: `${fmt(s.tokens.credits)} credits`,
    tone: "brand" as const,
  },
  {
    label: "Pending sign-ups",
    value: fmt(s.signups.pending),
    sub: "awaiting review",
    tone: s.signups.pending > 0 ? ("warn" as const) : ("default" as const),
  },
]);

const TONE_STYLES: Record<string, string> = {
  default: "border-neutral-200 dark:border-neutral-800",
  brand: "border-brand-300 dark:border-brand-800",
  warn: "border-amber-300 dark:border-amber-800",
};
</script>

<svelte:head>
  <title>Admin overview — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {#each STAT_CARDS as card (card.label)}
      <div class={`rounded-xl border bg-white p-5 dark:bg-neutral-900 ${TONE_STYLES[card.tone]}`}>
        <p class="text-xs font-semibold uppercase tracking-wide text-neutral-500">{card.label}</p>
        <p class="mt-2 text-3xl font-semibold tracking-tight">{card.value}</p>
        <p class="mt-1 text-xs text-neutral-500">{card.sub}</p>
      </div>
    {/each}
  </div>

  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="Instance controls"
  >
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Instance controls</h2>
    <div class="mt-4 grid gap-4 sm:grid-cols-2">
      <div class="flex items-center justify-between rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <p class="text-sm font-medium">Sign-up mode</p>
          <p class="mt-0.5 text-xs text-neutral-500">
            Who can create an account on this instance.
          </p>
        </div>
        <span
          class="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700 dark:bg-brand-950 dark:text-brand-300"
        >
          {SIGNUP_MODE_LABEL[s.signupMode as SignupMode] ?? s.signupMode}
        </span>
      </div>
      <div class="flex items-center justify-between rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <p class="text-sm font-medium">Payments</p>
          <p class="mt-0.5 text-xs text-neutral-500">
            Checkout for paid plans.
          </p>
        </div>
        <span
          class={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            s.paymentsEnabled
              ? "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          }`}
        >
          {s.paymentsEnabled ? "Enabled" : "Disabled"}
        </span>
      </div>
    </div>
    <div class="mt-4 flex flex-wrap gap-2">
      <a href="/admin/signups" class="btn btn-outline px-3 py-1.5 text-sm">Manage sign-ups</a>
      <button
        type="button"
        onclick={() => goto("/admin/users")}
        class="btn btn-outline px-3 py-1.5 text-sm"
      >
        Manage users
      </button>
    </div>
  </section>

  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="Review breakdown"
  >
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
      Review status breakdown
    </h2>
    <div class="mt-4 overflow-x-auto">
      <table class="w-full text-sm">
        <tbody class="divide-y divide-neutral-200 dark:divide-neutral-800">
          {#each Object.entries(s.reviews.byStatus).sort((a, b) => b[1] - a[1]) as [status, total] (status)}
            <tr>
              <td class="py-2 pr-4 capitalize">{status}</td>
              <td class="py-2 pr-4 text-right font-medium">{fmt(total)}</td>
            </tr>
          {/each}
          {#if Object.keys(s.reviews.byStatus).length === 0}
            <tr>
              <td class="py-3 text-neutral-500">No reviews yet.</td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  </section>
</section>
