<script lang="ts">
  import { goto } from "$app/navigation";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import GitPullRequest from "@lucide/svelte/icons/git-pull-request";
  import Loader from "@lucide/svelte/icons/loader-circle";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { ApiError, api } from "$lib/api";
  import type {
    OpenPullRequest,
    ProjectReviewListItem,
    TriggerReviewResponse,
  } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const provider = $derived((data.project?.provider ?? "github").toLowerCase());
  const changeNoun = $derived(provider === "gitlab" ? "MR" : "PR");
  const providerLabel = $derived(
    provider === "gitlab" ? "GitLab" : provider === "gitea" ? "Gitea" : "GitHub",
  );
  const teamHref = $derived(
    data.project?.orgId ? `/teams/${data.project.orgId}` : "/dashboard",
  );

  const openPulls = $state<OpenPullRequest[]>([]);
  const recentReviews = $state<ProjectReviewListItem[]>([]);
  let hydratedProjectId = $state<string | null>(null);

  $effect(() => {
    if (hydratedProjectId === data.projectId) return;
    // hydrate from load output, then keep locally mutable so we don't refetch on every focus
    openPulls.splice(0, openPulls.length, ...(data.openPulls ?? []));
    recentReviews.splice(0, recentReviews.length, ...(data.recentReviews ?? []));
    hydratedProjectId = data.projectId;
  });

  let loadingOpen = $state(false);
  let openError = $state<string | null>(null);
  let reviewingNumber = $state<number | null>(null);
  let reviewError = $state<{ n: number; msg: string } | null>(null);
  let freeByokOnly = $state(false);

  async function refreshOpen() {
    loadingOpen = true;
    openError = null;
    try {
      const res = await api<{ items: OpenPullRequest[] }>(
        `/api/projects/${data.projectId}/pulls/open?state=open`,
      );
      openPulls.splice(0, openPulls.length, ...(res.items ?? []));
    } catch (err) {
      openError = err instanceof ApiError ? err.message : "Could not load open PRs.";
    } finally {
      loadingOpen = false;
    }
  }

  async function triggerReview(n: number) {
    if (reviewingNumber !== null) return;
    reviewingNumber = n;
    reviewError = null;
    freeByokOnly = false;
    try {
      const trigger = await api<TriggerReviewResponse>(
        `/api/projects/${data.projectId}/pulls/${n}/review`,
        { method: "POST", body: JSON.stringify({}) },
      );
      await goto(`/reviews/${trigger.reviewId}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "free_byok_only") {
        freeByokOnly = true;
      }
      reviewError = {
        n,
        msg: err instanceof ApiError ? err.message : "Could not trigger review.",
      };
    } finally {
      reviewingNumber = null;
    }
  }

  function formatDate(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
  }

  const STATUS_BADGE: Record<string, string> = {
    completed: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
    running: "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
    pending: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    queued: "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
    failed: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
    cancelled: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  };

</script>

<svelte:head>
  <title>{data.project?.name ?? "Project"} — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <nav aria-label="Breadcrumb" class="text-sm">
    <a
      href={teamHref}
      class="inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
    >
      <ArrowLeft class="size-4" />
      Back to team
    </a>
  </nav>

  <header>
    <h1 class="text-2xl font-semibold tracking-tight">{data.project?.name ?? "Project"}</h1>
    <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
      {providerLabel} · {data.project?.repoFullName ?? data.projectId}
    </p>
  </header>

  {#if freeByokOnly}
    <aside
      class="rounded-lg border border-brand-300 bg-brand-50 p-4 text-sm text-brand-800 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-200"
      role="note"
    >
      <p class="font-medium">Free plan is BYOK-only.</p>
      <p class="mt-1">
        This team has no hosted credits and no provider key covering the selected model.
        Add a BYOK API key in your team settings, or upgrade to a paid plan.
      </p>
    </aside>
  {/if}

  <!-- Open PRs from the provider -->
  <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          <GitPullRequest class="size-4" />
          Open {changeNoun}s from {providerLabel}
        </h2>
        <p class="mt-1 text-xs text-neutral-500">
          Triggered reviews run the full LangGraph pipeline against the real PR diff.
        </p>
      </div>
      <button
        type="button"
        onclick={refreshOpen}
        disabled={loadingOpen}
        class="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium bg-white hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        {#if loadingOpen}
          <Loader class="size-3.5 animate-spin" />
          Refreshing…
        {:else}
          <RefreshCw class="size-3.5" />
          Refresh
        {/if}
      </button>
    </div>

    {#if openError}
      <div class="mt-4 rounded-lg border border-dashed border-red-300 p-4 text-sm text-red-700 dark:border-red-900 dark:text-red-300">
        <p class="font-medium">Could not list {changeNoun}s from {providerLabel}.</p>
        <p class="mt-1 text-xs">{openError}</p>
        <p class="mt-2 text-xs">
          Make sure the GitHub App is installed on this repo, or connect a token in
          <a class="underline" href="/dashboard">team settings → VCS</a>.
        </p>
      </div>
    {:else if openPulls.length === 0}
      <p class="mt-4 text-sm text-neutral-500">
        No open {changeNoun}s on {data.project?.repoFullName ?? "this repo"}.
      </p>
    {:else}
      <ul class="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">
        {#each openPulls as pr (pr.number)}
          <li class="py-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-xs text-neutral-500">#{pr.number}</span>
                  <a
                    href={pr.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="truncate font-medium hover:underline"
                  >
                    {pr.title || "(no title)"}
                  </a>
                  {#if pr.htmlUrl}
                    <a
                      href={pr.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                      title="Open on {providerLabel}"
                    >
                      <ExternalLink class="size-3.5" />
                    </a>
                  {/if}
                </div>
                <p class="mt-0.5 text-xs text-neutral-500">
                  by {pr.author || "—"} · updated {formatDate(pr.updatedAt)}
                </p>
                {#if reviewError && reviewError.n === pr.number}
                  <p class="mt-1 text-xs text-red-600 dark:text-red-400">{reviewError.msg}</p>
                {/if}
              </div>
              <button
                type="button"
                onclick={() => triggerReview(pr.number)}
                disabled={reviewingNumber !== null}
                class="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {#if reviewingNumber === pr.number}
                  <Loader class="size-3.5 animate-spin" />
                  Triggering…
                {:else}
                  Review {changeNoun}
                {/if}
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Recent reviews -->
  <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
      Recent reviews
    </h2>
    {#if recentReviews.length === 0}
      <p class="mt-4 text-sm text-neutral-500">
        No reviews yet for this project. Trigger one from the list above or via a {providerLabel} webhook.
      </p>
    {:else}
      <ul class="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">
        {#each recentReviews as r (r.id)}
          <li>
            <a
              href={`/reviews/${r.id}`}
              class="flex flex-wrap items-center justify-between gap-3 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900/40"
            >
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STATUS_BADGE[r.status] ?? STATUS_BADGE.pending}`}>
                    {r.status}
                  </span>
                  {#if r.source}
                    <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] uppercase tracking-wide text-neutral-500 dark:bg-neutral-800">
                      {r.source}
                    </span>
                  {/if}
                  <span class="font-mono text-xs text-neutral-500">
                    #{r.pullRequest.externalNumber ?? "?"}
                  </span>
                  <span class="truncate font-medium">
                    {r.pullRequest.title ?? "(no title)"}
                  </span>
                </div>
                <p class="mt-0.5 text-xs text-neutral-500">
                  {r.pullRequest.author ?? "—"} · {formatDate(r.createdAt)}
                </p>
              </div>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

</section>
