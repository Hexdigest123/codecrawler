<script lang="ts">
import ArrowLeft from "@lucide/svelte/icons/arrow-left";
import { PLAN_LABEL, type UsageState } from "$lib/types";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const team = $derived(data.team);
const projects = $derived(data.projects ?? []);
const memberCount = $derived(team?.membersCount ?? team?.members?.length ?? null);

function formatRemaining(u: UsageState | undefined): string {
  if (!u) return "—";
  if (u.limit === null) return "Unlimited";
  if (u.limit === 0) return "0";
  const remaining = Math.max(0, u.limit - u.used);
  return String(remaining);
}

function usedDisplay(u: UsageState | undefined): string {
  if (!u) return "0";
  return Number.isFinite(u.used) ? String(Math.round(u.used)) : "0";
}

function limitDisplay(u: UsageState | undefined): string {
  if (!u) return "—";
  if (u.limit === null) return "∞";
  return String(u.limit);
}

function usagePct(u: UsageState | undefined): number {
  if (!u || u.limit === null || u.limit <= 0) return 0;
  return Math.min(100, Math.round((u.used / u.limit) * 100));
}

function usageTone(u: UsageState | undefined): string {
  if (!u || u.limit === null || u.limit <= 0) return "bg-brand-600";
  const pct = (u.used / u.limit) * 100;
  if (pct >= 100) return "bg-red-500";
  if (pct >= 80) return "bg-amber-500";
  return "bg-brand-600";
}
</script>

<svelte:head>
  <title>{team?.organization?.name ?? "Team"} — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <nav aria-label="Breadcrumb" class="text-sm">
    <a
      href="/dashboard"
      class="inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
    >
      <ArrowLeft class="size-4" />
      Back to dashboard
    </a>
  </nav>

  <header class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <div class="flex items-center gap-3">
        <h1 class="text-2xl font-semibold tracking-tight">
          {team?.organization?.name ?? "Team"}
        </h1>
        <span
          class="rounded-full border border-neutral-300 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-700"
        >
          {team ? PLAN_LABEL[team.plan] ?? team.plan : "—"}
        </span>
      </div>
      <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Your role: <span class="font-medium">{team?.role ?? "—"}</span>
      </p>
    </div>
    <nav class="flex flex-wrap gap-2 text-sm" aria-label="Team settings">
      <a
        href={`/teams/${team?.organization?.id}/settings/members`}
        class="rounded-md border border-neutral-300 px-3 py-1.5 font-medium bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        Members
      </a>
      <a
        href={`/teams/${team?.organization?.id}/settings/graph`}
        class="rounded-md border border-neutral-300 px-3 py-1.5 font-medium bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        Graph
      </a>
      <a
        href={`/teams/${team?.organization?.id}/settings/keys`}
        class="rounded-md border border-neutral-300 px-3 py-1.5 font-medium bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        API keys
      </a>
      <a
        href={`/teams/${team?.organization?.id}/settings/vcs`}
        class="rounded-md border border-neutral-300 px-3 py-1.5 font-medium bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        VCS
      </a>
      <a
        href={`/teams/${team?.organization?.id}/settings/billing`}
        class="rounded-md border border-neutral-300 px-3 py-1.5 font-medium bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        Billing
      </a>
      <a
        href={`/teams/${team?.organization?.id}/settings/sso`}
        class="rounded-md border border-neutral-300 px-3 py-1.5 font-medium bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        SSO
      </a>
      <a
        href={`/teams/${team?.organization?.id}/settings/audit`}
        class="rounded-md border border-neutral-300 px-3 py-1.5 font-medium bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        Audit
      </a>
    </nav>
  </header>

  <div class="grid gap-5 sm:grid-cols-3">
    <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Members</h2>
      <p class="mt-4 text-2xl font-semibold">{memberCount ?? "—"}</p>
    </section>
    <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Plan</h2>
      <p class="mt-4 text-2xl font-semibold">{team ? PLAN_LABEL[team.plan] ?? team.plan : "—"}</p>
    </section>
    <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">PR reviews</h2>
        <span class="text-xs text-neutral-400">today</span>
      </div>
      <p class="mt-4 text-2xl font-semibold">{formatRemaining(team?.usage?.prReview)}</p>
      <p class="mt-1 text-xs text-neutral-500">
        {usedDisplay(team?.usage?.prReview)} / {limitDisplay(team?.usage?.prReview)} used
      </p>
      {#if team?.usage?.prReview && team.usage.prReview.limit !== null && team.usage.prReview.limit > 0}
        <div class="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          <div
            class={`h-full rounded-full transition-all ${usageTone(team.usage.prReview)}`}
            style={`width: ${usagePct(team.usage.prReview)}%`}
          ></div>
        </div>
      {/if}
    </section>
  </div>

  {#if team?.usage?.prReview?.limit === 0}
    <aside
      class="rounded-lg border border-brand-300 bg-brand-50 p-4 text-sm text-brand-800 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-200"
      role="note"
    >
      <p class="font-medium">Free plan is BYOK-only.</p>
      <p class="mt-1">
        Add a provider API key in
        <a class="underline" href={`/teams/${team?.organization?.id}/settings/keys`}>API keys</a>
        to run reviews, or
        <a class="underline" href={`/teams/${team?.organization?.id}/settings/billing`}>upgrade your plan</a>.
      </p>
    </aside>
  {/if}

  <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Projects</h2>
      <a
        href={`/teams/${team?.organization?.id}/projects/new`}
        class="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500"
      >
        Connect a repo
      </a>
    </div>

    {#if projects.length === 0}
      <div class="mt-4 rounded-lg border border-dashed border-neutral-300 p-6 text-center dark:border-neutral-700">
        <p class="text-sm text-neutral-500">No projects yet.</p>
        <a
          href={`/teams/${team?.organization?.id}/projects/new`}
          class="mt-3 inline-flex rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        >
          Connect your first repo
        </a>
      </div>
    {:else}
      <ul class="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">
        {#each projects as project (project.id)}
          <li class="flex items-center justify-between py-3">
            <div>
              <p class="font-medium">{project.name}</p>
              <p class="text-xs text-neutral-500">
                {project.provider ?? "github"} · {project.repoFullName ?? "—"}
              </p>
            </div>
            <a
              href={`/projects/${project.id}`}
              class="rounded-md border border-neutral-300 px-3 py-1 text-sm font-medium bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
            >
              Open
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>
