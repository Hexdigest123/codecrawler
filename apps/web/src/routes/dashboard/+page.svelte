<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Plus from "@lucide/svelte/icons/plus";
  import Search from "@lucide/svelte/icons/search";
  import { PLAN_RANK, PLAN_LABEL, type PlanId, type TeamMembership } from "$lib/types";
  import type { PageProps } from "./$types";

  const PAGE_SIZE = 8;
  const TEAMS_PER_USER: Record<PlanId, number | null> = {
    free: 3,
    plus: null,
    pro: null,
  };

  let { data }: PageProps = $props();

  const teams = $derived<TeamMembership[]>(data.me?.teams ?? []);
  const hasTeams = $derived(teams.length > 0);

  const governingPlan = $derived.by<PlanId>(() => {
    let best: PlanId = "free";
    for (const t of teams) {
      if (t.role !== "owner" && t.role !== "admin") continue;
      const rank = t.plan in PLAN_RANK ? PLAN_RANK[t.plan] : PLAN_RANK.free;
      if (rank > PLAN_RANK[best]) best = t.plan;
    }
    return best;
  });
  const teamsCap = $derived(TEAMS_PER_USER[governingPlan]);
  const teamsCapReached = $derived(
    teamsCap !== null && teams.length >= teamsCap,
  );

  let query = $state("");
  let visibleCount = $state(PAGE_SIZE);

  const filteredTeams = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return teams;
    return teams.filter(
      (t) =>
        t.organization.name.toLowerCase().includes(q) ||
        t.organization.slug.toLowerCase().includes(q),
    );
  });
  const visibleTeams = $derived(filteredTeams.slice(0, visibleCount));
  const hasMore = $derived(visibleCount < filteredTeams.length);

  const ROLE_BADGE_STYLES: Record<string, string> = {
    owner: "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
    admin: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    member: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  };

  const PLAN_BADGE_STYLES: Record<string, string> = {
    free: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
    plus: "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
    pro: "bg-brand-600 text-white",
  };
</script>

<svelte:head>
  <title>Dashboard — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <header class="flex flex-wrap items-center justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Signed in as {data.me?.user?.email ?? "your account"}.
      </p>
    </div>
    <a
      href="/teams/new"
      aria-disabled={teamsCapReached}
      class="btn btn-primary px-4 py-2 text-sm"
      class:pointer-events-none={teamsCapReached}
      class:cursor-not-allowed={teamsCapReached}
      class:opacity-50={teamsCapReached}
      title={teamsCapReached
        ? `Team limit reached (${teamsCap}) on the ${PLAN_LABEL[governingPlan]} plan`
        : undefined}
    >
      <Plus class="size-4" />
      New team
    </a>
  </header>

  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="Your teams"
  >
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Your teams
      </h2>
    </div>

    {#if hasTeams}
      <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
        <label class="relative block w-full max-w-xs">
          <span class="sr-only">Search teams</span>
          <Search class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-neutral-400" />
          <input
            type="search"
            bind:value={query}
            oninput={() => (visibleCount = PAGE_SIZE)}
            placeholder="Search teams…"
            class="input w-full py-1.5 pl-8 text-sm"
          />
        </label>
        <span class="text-xs text-neutral-500">
          {#if filteredTeams.length === 0}
            No matches.
          {:else}
            Showing {visibleTeams.length} of {filteredTeams.length}
          {/if}
        </span>
      </div>

      {#if filteredTeams.length === 0}
        <p class="mt-4 text-sm text-neutral-500">
          No teams match “{query}”.
        </p>
      {:else}
        <ul class="mt-3 grid gap-3 sm:grid-cols-2">
          {#each visibleTeams as team (team.organization.id)}
            <li>
              <a
                href={`/teams/${team.organization.id}`}
                class="group flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white p-4 transition-colors hover:border-brand-400 hover:bg-brand-50/40 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-brand-500 dark:hover:bg-brand-950/30"
              >
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="truncate font-medium">{team.organization.name}</span>
                    <span
                      class={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${PLAN_BADGE_STYLES[team.plan] ?? PLAN_BADGE_STYLES.free}`}
                    >
                      {PLAN_LABEL[team.plan] ?? team.plan}
                    </span>
                  </div>
                  <p class="mt-1 text-xs text-neutral-500">
                    Your role:
                    <span
                      class={`ml-1 rounded px-1.5 py-0.5 font-medium ${ROLE_BADGE_STYLES[team.role] ?? ROLE_BADGE_STYLES.member}`}
                    >
                      {team.role}
                    </span>
                  </p>
                </div>
                <ChevronRight class="size-5 shrink-0 text-neutral-400 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-600 dark:group-hover:text-brand-400" />
              </a>
            </li>
          {/each}
        </ul>
        {#if hasMore}
          <div class="mt-4 flex items-center justify-center">
            <button
              type="button"
              onclick={() => (visibleCount += PAGE_SIZE)}
              class="btn btn-outline px-4 py-1.5 text-sm"
            >
              Show more
              <span class="text-neutral-400">
                ({filteredTeams.length - visibleCount} left)
              </span>
            </button>
          </div>
        {/if}
      {/if}
    {:else}
      <div
        class="mt-4 rounded-lg border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700"
      >
        <p class="text-sm text-neutral-500">You don't belong to a team yet.</p>
        <a
          href="/teams/new"
          class="btn btn-primary mt-4 px-3 py-1.5 text-sm"
        >
          <Plus class="size-4" />
          Create your first team
        </a>
      </div>
    {/if}
  </section>
</section>
