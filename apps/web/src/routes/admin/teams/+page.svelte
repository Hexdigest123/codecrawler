<script lang="ts">
import { PLAN_LABEL, type AdminTeam, type PlanId } from "$lib/types";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const teams = $derived<AdminTeam[]>(data.teams);

let query = $state("");
const filtered = $derived.by(() => {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return teams;
  return teams.filter(
    (t) => t.name.toLowerCase().includes(q) || (t.slug ?? "").toLowerCase().includes(q),
  );
});

const totals = $derived(
  teams.reduce(
    (acc, t) => {
      acc.members += t.members;
      acc.reviews += t.reviews;
      acc.spend += t.tokenSpendUsd;
      acc.credits += t.credits;
      return acc;
    },
    { members: 0, reviews: 0, spend: 0, credits: 0 },
  ),
);

const PLAN_BADGE: Record<string, string> = {
  free: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  plus: "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
  pro: "bg-brand-600 text-white",
};

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
</script>

<svelte:head>
  <title>Teams — Admin — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-6">
  <header class="flex flex-wrap items-end justify-between gap-4">
    <div>
      <h2 class="text-xl font-semibold tracking-tight">Teams</h2>
      <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {teams.length} team{teams.length === 1 ? "" : "s"} · {totals.members} members ·
        {fmt(totals.spend)} total token spend · {fmt(totals.credits)} credits
      </p>
    </div>
    <label class="block w-full max-w-xs">
      <span class="sr-only">Search teams</span>
      <input
        type="search"
        bind:value={query}
        placeholder="Search teams…"
        class="input w-full px-3 py-1.5 text-sm"
      />
    </label>
  </header>

  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="Teams"
  >
    {#if filtered.length === 0}
      <p class="text-sm text-neutral-500">No teams found.</p>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr
              class="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800"
            >
              <th scope="col" class="py-2 pr-4 font-medium">Team</th>
              <th scope="col" class="py-2 pr-4 font-medium">Plan</th>
              <th scope="col" class="py-2 pr-4 font-medium">Members</th>
              <th scope="col" class="py-2 pr-4 font-medium">Reviews</th>
              <th scope="col" class="py-2 pr-4 font-medium">Token spend</th>
              <th scope="col" class="py-2 pr-4 font-medium">Credits</th>
              <th scope="col" class="py-2 pr-4 font-medium">Created</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-200 dark:divide-neutral-800">
            {#each filtered as team (team.id)}
              <tr>
                <td class="py-3 pr-4">
                  <a
                    href={`/teams/${team.id}`}
                    class="font-medium text-brand-600 hover:underline dark:text-brand-400"
                  >
                    {team.name}
                  </a>
                  {#if team.slug}
                    <p class="text-xs text-neutral-500">{team.slug}</p>
                  {/if}
                </td>
                <td class="py-3 pr-4">
                  <span
                    class={`rounded-full px-2 py-0.5 text-xs font-semibold ${PLAN_BADGE[team.plan] ?? PLAN_BADGE.free}`}
                  >
                    {PLAN_LABEL[team.plan as PlanId] ?? team.plan}
                  </span>
                </td>
                <td class="py-3 pr-4">{team.members}</td>
                <td class="py-3 pr-4">{fmt(team.reviews)}</td>
                <td class="py-3 pr-4">${fmt(team.tokenSpendUsd)}</td>
                <td class="py-3 pr-4">{fmt(team.credits)}</td>
                <td class="py-3 pr-4 text-neutral-500">{formatDate(team.createdAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</section>
