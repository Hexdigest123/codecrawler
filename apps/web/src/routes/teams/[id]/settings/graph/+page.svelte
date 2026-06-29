<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import GraphEditor from "$lib/components/graph/GraphEditor.svelte";
  import { PLAN_LABEL } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const isSecurity = $derived(data.graphType === "security");

  const title = $derived(isSecurity ? "Agent graph — Security" : "Agent graph — PR review");

  function switchType(type: "pr_review" | "security") {
    const url = new URL(page.url);
    if (type === "security") {
      url.searchParams.set("type", "security");
    } else {
      url.searchParams.delete("type");
    }
    goto(url, { keepFocus: true, noScroll: true });
  }
</script>

<svelte:head>
  <title>{title} — {PLAN_LABEL[data.teamPlan]} — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-6">
  <div class="flex flex-wrap gap-2 text-sm" role="tablist" aria-label="Graph type">
    <button
      type="button"
      onclick={() => switchType("pr_review")}
      aria-pressed={!isSecurity}
      class="rounded-md border px-3 py-1.5 font-medium transition-colors {!isSecurity
        ? "border-brand-600 bg-brand-600 text-white hover:bg-brand-500"
        : "border-neutral-300 bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"}"
    >
      PR review
    </button>
    <button
      type="button"
      onclick={() => switchType("security")}
      aria-pressed={isSecurity}
      class="rounded-md border px-3 py-1.5 font-medium transition-colors {isSecurity
        ? "border-brand-600 bg-brand-600 text-white hover:bg-brand-500"
        : "border-neutral-300 bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"}"
    >
      Security
    </button>
  </div>

  {#key data.graphType}
    <GraphEditor teamId={data.teamId} graphType={data.graphType} teamPlan={data.teamPlan} />
  {/key}
</section>
