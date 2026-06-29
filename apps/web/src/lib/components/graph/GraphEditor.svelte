<script lang="ts">
  import { onMount } from "svelte";
  import { Background, Panel, SvelteFlow, type Edge, type Node } from "@xyflow/svelte";
  import "@xyflow/svelte/dist/style.css";

  import { ApiError, api } from "$lib/api";
  import { toastError } from "$lib/toast.svelte";
  import { type ModelOption, type PlanId, planRank } from "$lib/types";

  import AgentNode from "./AgentNode.svelte";
  import { buildFlow } from "./layout";
  import {
    type AgentNodeData,
    type GraphDescriptor,
    type GraphType,
    gatewayLabel,
    roleLabel,
  } from "./types";

  interface Props {
    teamId: string;
    graphType: GraphType;
    teamPlan: PlanId;
  }

  let { teamId, graphType, teamPlan }: Props = $props();

  const nodeTypes = { agent: AgentNode };

  let nodes = $state.raw<Node<AgentNodeData>[]>([]);
  let edges = $state.raw<Edge[]>([]);
  let descriptor = $state<GraphDescriptor | null>(null);
  let models = $state<ModelOption[]>([]);

  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let selectedKey = $state<string | null>(null);
  let saving = $state(false);
  let query = $state("");

  let searchInput = $state<HTMLInputElement | null>(null);

  const planRankLimit = $derived(planRank(teamPlan));
  const isFreePlan = $derived(teamPlan === "free");
  const selectedNode = $derived(descriptor?.nodes.find((n) => n.key === selectedKey) ?? null);

  const eligibleModels = $derived(
    models.filter((m) => {
      if (isFreePlan) return m.byok === true;
      return planRank(m.minPlan) <= planRankLimit || m.byok === true;
    }),
  );

  const filteredModels = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return eligibleModels;
    return eligibleModels.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        (m.vendor ?? "").toLowerCase().includes(q) ||
        (m.provider ?? "").toLowerCase().includes(q),
    );
  });

  const groupedModels = $derived.by(() => {
    const map = new Map<string, ModelOption[]>();
    for (const m of filteredModels) {
      const key = m.vendor ?? m.provider ?? "Other";
      const list = map.get(key) ?? [];
      list.push(m);
      map.set(key, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  $effect(() => {
    if (selectedKey && searchInput) {
      searchInput.focus();
    }
  });

  function applyDescriptor(desc: GraphDescriptor) {
    descriptor = desc;
    const flow = buildFlow(desc);
    nodes = flow.nodes;
    edges = flow.edges;
  }

  async function load() {
    loading = true;
    loadError = null;
    try {
      const [desc, catalog] = await Promise.all([
        api<GraphDescriptor>(`/api/teams/${teamId}/agent-graph/${graphType}`),
        api<ModelOption[]>(`/api/models?orgId=${encodeURIComponent(teamId)}`),
      ]);
      applyDescriptor(desc);
      models = catalog;
    } catch (err) {
      loadError = err instanceof ApiError ? err.message : "Could not load the agent graph.";
    } finally {
      loading = false;
    }
  }

  function onNodeClick(event: { node?: Node }) {
    const data = event.node?.data as AgentNodeData | undefined;
    if (data && data.modelBearing) {
      selectedKey = data.key;
      query = "";
    }
  }

  function closePicker() {
    selectedKey = null;
  }

  function onBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      closePicker();
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && selectedKey) {
      closePicker();
    }
  }

  async function chooseModel(modelId: string) {
    if (!selectedKey || saving) return;
    saving = true;
    try {
      const updated = await api<GraphDescriptor>(
        `/api/teams/${teamId}/agent-graph/${graphType}/nodes/${encodeURIComponent(selectedKey)}`,
        { method: "PUT", body: JSON.stringify({ modelId }) },
      );
      applyDescriptor(updated);
      selectedKey = null;
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : "Could not update the node model.");
    } finally {
      saving = false;
    }
  }

  onMount(load);
</script>

<svelte:window onkeydown={onKeydown} />

<section class="flex flex-col gap-4">
  {#if loading}
    <div
      class="flex min-h-[28rem] items-center justify-center rounded-xl border border-neutral-200 text-sm text-neutral-500 dark:border-neutral-800"
    >
      Loading graph…
    </div>
  {:else if loadError}
    <div
      class="flex min-h-[28rem] items-center justify-center rounded-xl border border-red-300 p-6 text-center text-sm text-red-600 dark:border-red-900 dark:text-red-400"
      role="alert"
    >
      {loadError}
    </div>
  {:else}
    <div
      class="codecrawler-agent-flow relative h-[34rem] w-full min-h-[28rem] overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950"
    >
      <SvelteFlow
        class="codecrawler-agent-flow"
        nodes={nodes}
        edges={edges}
        {nodeTypes}
        onnodeclick={onNodeClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll
        fitView
        fitViewOptions={{ minZoom: 0.8, padding: 0.15 }}
      >
        <Background />
        <Panel position="bottom-left">
          <div
            class="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 bg-white/90 px-3 py-2 text-[11px] text-neutral-600 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/90 dark:text-neutral-300"
          >
            <span class="flex items-center gap-1.5">
              <span
                class="rounded-full bg-green-50 px-2 py-0.5 font-semibold text-green-700 dark:bg-green-950 dark:text-green-300"
                >BYOK</span
              >
              team key covers it
            </span>
            <span class="flex items-center gap-1.5">
              <span
                class="rounded-full bg-neutral-100 px-2 py-0.5 font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                >metered</span
              >
              hosted key
            </span>
            <span class="flex items-center gap-1.5">
              <span
                class="rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                >via SAIA</span
              >
              /
              <span
                class="rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                >OpenRouter</span
              >
              gateway
            </span>
          </div>
        </Panel>
      </SvelteFlow>
    </div>
  {/if}
</section>

{#if selectedNode}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="graph-picker-title"
    onclick={onBackdropClick}
    onkeydown={(e) => { if (e.key === "Escape") closePicker(); }}
  >
    <div
      class="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
    >
      <header class="flex items-center justify-between gap-4 border-b border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 id="graph-picker-title" class="text-base font-semibold">
            {selectedNode.label}
          </h2>
          <p class="text-xs text-neutral-500">
            {roleLabel(selectedNode.role)} &middot; pick the model that powers this node
          </p>
        </div>
        <button
          type="button"
          onclick={closePicker}
          aria-label="Close model picker"
          class="rounded-md border border-neutral-300 px-2 py-1 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >Close</button
        >
      </header>

      <div class="border-b border-neutral-200 p-4 dark:border-neutral-800">
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Search models</span>
          <input
            bind:this={searchInput}
            bind:value={query}
            type="search"
            placeholder="Filter by name, vendor or provider"
            class="input px-3 py-2"
          />
        </label>
        <p class="mt-2 text-xs text-neutral-500">
          Showing models eligible for your plan or any registered BYOK key ({eligibleModels.length}).
        </p>
      </div>

      <div class="flex-1 overflow-y-auto p-2">
        {#if groupedModels.length === 0}
          <p class="p-6 text-center text-sm text-neutral-500">No models match your filter.</p>
        {:else}
          {#each groupedModels as [vendor, group] (vendor)}
            <div class="p-2">
              <p class="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                {vendor}
              </p>
              <ul class="flex flex-col gap-1">
                {#each group as model (model.id)}
                  <li>
                    <button
                      type="button"
                      onclick={() => chooseModel(model.id)}
                      disabled={saving}
                      aria-pressed={selectedNode.modelId === model.id}
                      class="flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition disabled:opacity-50 {selectedNode
                        .modelId ===
                      model.id
                        ? "border-brand-500 bg-brand-50 dark:bg-brand-950"
                        : "border-transparent hover:border-neutral-300 hover:bg-neutral-100 dark:hover:border-neutral-700 dark:hover:bg-neutral-800"}"
                    >
                      <span class="flex flex-col">
                        <span class="font-medium">{model.name}</span>
                        <span class="text-xs text-neutral-500"
                          >{model.vendor ?? model.provider ?? "model"}{model.weight !==
                          undefined && model.weight !== "" && !model.byok
                            ? ` · ×${model.weight}`
                            : ""}</span
                        >
                      </span>
                      <span class="flex shrink-0 items-center gap-1.5">
                        {#if gatewayLabel(model.gateway)}
                          <span
                            class="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                            >{gatewayLabel(model.gateway)}</span
                          >
                        {/if}
                        {#if model.byok}
                          <span
                            class="rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-semibold text-green-700 dark:bg-green-950 dark:text-green-300"
                            >BYOK</span
                          >
                        {:else}
                          <span
                            class="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                            >metered</span
                          >
                        {/if}
                        {#if selectedNode.modelId === model.id}
                          <span class="text-[10px] font-medium text-brand-600 dark:text-brand-400"
                            >current</span
                          >
                        {/if}
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
        {/if}
      </div>

      {#if saving}
        <p class="flex items-center gap-2 border-t border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-800">
          <span
            class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent"
          ></span>
          Saving new model…
        </p>
      {/if}
    </div>
  </div>
{/if}

<style>
  :global(.codecrawler-agent-flow) {
    --cc-flow-edge: #737373;
  }

  :global(.dark .codecrawler-agent-flow) {
    --cc-flow-edge: #a3a3a3;
  }

  :global(.codecrawler-agent-flow .svelte-flow__edge-path) {
    stroke: var(--cc-flow-edge);
  }
</style>
