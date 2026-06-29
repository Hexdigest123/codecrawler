<script lang="ts">
  import { Handle, Position } from "@xyflow/svelte";
  import { gatewayLabel, roleLabel, type AgentNodeData } from "./types";

  interface Props {
    data: AgentNodeData;
    id?: string;
    selected?: boolean;
  }

  let { data }: Props = $props();

  const gateway = $derived(gatewayLabel(data.gateway));
  const weight = $derived(
    data.weight !== null && data.weight !== undefined && data.weight !== ""
      ? String(data.weight)
      : null,
  );
</script>

  <div
    class="relative flex w-60 flex-col gap-2 rounded-xl border bg-white p-4 text-left shadow-sm dark:bg-neutral-900 {data
      .modelBearing
      ? "border-brand-500 ring-1 ring-brand-500/30"
      : "border-neutral-300 dark:border-neutral-700"}"
  >
    <Handle type="target" position={Position.Left} />
    <Handle type="source" position={Position.Right} />
    <div class="flex items-start justify-between gap-2">
      <span class="text-base font-semibold leading-tight">{data.label}</span>
      <span
        class="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-700"
      >
        {roleLabel(data.role)}
      </span>
    </div>

    {#if data.modelBearing}
      <div class="flex flex-col gap-1">
        <span class="text-sm text-neutral-700 dark:text-neutral-200">
          {data.modelDisplayName ?? data.vendor ?? "No model assigned"}
        </span>
        {#if data.vendor}
          <span class="text-xs text-neutral-500">{data.vendor}</span>
        {/if}
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        {#if gateway}
          <span
            class="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300"
          >
            {gateway}
          </span>
        {/if}
        {#if data.byok}
          <span
            class="rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-700 dark:bg-green-950 dark:text-green-300"
          >
            BYOK
          </span>
        {:else}
          <span
            class="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          >
            metered
          </span>
        {/if}
        {#if weight}
          <span class="text-[11px] text-neutral-400">&times;{weight}</span>
        {/if}
      </div>
      <span class="mt-0.5 text-[11px] font-medium text-brand-600 dark:text-brand-400">
        Click to change model
      </span>
    {:else}
      <span class="text-xs text-neutral-400">Fixed pipeline step</span>
    {/if}
  </div>
