<script lang="ts">
  import { untrack } from "svelte";
  import GraphEditor from "$lib/components/graph/GraphEditor.svelte";
  import { ApiError, api } from "$lib/api";
  import { toastError, toastSuccess } from "$lib/toast.svelte";
  import {
    DEPTH_DESCRIPTION,
    DEPTH_LABEL,
    DEPTH_TIERS,
    type DepthTier,
    PLAN_LABEL,
    type PlanId,
    planRank,
  } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const title = "Agent graph — PR review";

  // defaultDepth lives on the agent profile, not the per-node graph, so it's
  // edited through the agent-profile endpoint. The server resolves the actual
  // run tier from REVIEW_AGENT_MODE + this default; "deep" is Plus/Pro only.
  const canDeep = $derived(planRank(data.teamPlan as PlanId) >= planRank("plus"));
  // Mutable copy of the loaded default; untrack signals we deliberately seed
  // from the load snapshot rather than tracking it reactively.
  let currentDepth = $state<DepthTier>(
    untrack(() => (data.profile?.defaultDepth as DepthTier | null | undefined) ?? "quick"),
  );
  let savingDepth = $state(false);

  const depthDisabled = $derived((tier: DepthTier) => tier === "deep" && !canDeep);

  async function saveDepth(tier: DepthTier) {
    if (tier === currentDepth || savingDepth || depthDisabled(tier)) return;
    savingDepth = true;
    const prev = currentDepth;
    currentDepth = tier;
    try {
      await api(`/api/teams/${data.teamId}/agent-profile`, {
        method: "PUT",
        body: JSON.stringify({ defaultDepth: tier }),
      });
      toastSuccess(`Default review depth set to ${DEPTH_LABEL[tier]}.`);
    } catch (err) {
      currentDepth = prev;
      toastError(err instanceof ApiError ? err.message : "Could not save default depth.");
    } finally {
      savingDepth = false;
    }
  }
</script>

<svelte:head>
  <title>{title} — {PLAN_LABEL[data.teamPlan]} — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-6">
  <div class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Default review depth
      </h2>
      {#if !canDeep}
        <span class="text-xs text-neutral-500">Deep requires Plus or Pro.</span>
      {/if}
    </div>
    <p class="mt-1 text-xs text-neutral-500">
      The tier used when a review is triggered without an explicit depth (e.g. a polled
      PR). Comment <code class="rounded bg-neutral-100 px-1 dark:bg-neutral-800">/codecrawler deep</code>
      on a PR to override per-review. The global <code class="rounded bg-neutral-100 px-1 dark:bg-neutral-800">REVIEW_AGENT_MODE</code>
      setting can force the static path regardless.
    </p>
    <div class="mt-3 grid gap-2 sm:grid-cols-3">
      {#each DEPTH_TIERS as tier (tier)}
        {@const disabled = depthDisabled(tier)}
        <button
          type="button"
          onclick={() => saveDepth(tier)}
          disabled={disabled || savingDepth}
          aria-pressed={currentDepth === tier}
          class="flex flex-col gap-1 rounded-lg border p-3 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-50 {currentDepth ===
          tier
            ? "border-brand-500 bg-brand-50 dark:bg-brand-950"
            : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700"}"
        >
          <span class="flex items-center justify-between">
            <span class="font-medium">{DEPTH_LABEL[tier]}</span>
            {#if currentDepth === tier}
              <span class="text-[10px] font-medium uppercase text-brand-600 dark:text-brand-400">current</span>
            {/if}
          </span>
          <span class="text-xs text-neutral-500">{DEPTH_DESCRIPTION[tier]}</span>
        </button>
      {/each}
    </div>
  </div>

  <GraphEditor teamId={data.teamId} graphType="pr_review" teamPlan={data.teamPlan} />
</section>
