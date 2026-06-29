<script lang="ts">
  import GraphEditor from "$lib/components/graph/GraphEditor.svelte";
  import { PLAN_LABEL } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const title = "Agent graph — PR review";
</script>

<svelte:head>
  <title>{title} — {PLAN_LABEL[data.teamPlan]} — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-6">
  <GraphEditor teamId={data.teamId} graphType="pr_review" teamPlan={data.teamPlan} />
</section>
