<script lang="ts">
import { goto } from "$app/navigation";
import ArrowLeft from "@lucide/svelte/icons/arrow-left";
import ArrowRight from "@lucide/svelte/icons/arrow-right";
import { ApiError, api } from "$lib/api";
import type {
  SecurityReportSummary,
  TriggerSecurityScanResponse,
} from "$lib/types";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const CHEAP_MODEL = "minimax/minimax-m3";

let repoPath = $state("/home/user/Projects/codecrawler");
let modelId = $state(CHEAP_MODEL);
let running = $state(false);
let error = $state<string | null>(null);
let planRequired = $state(false);
let quotaExceeded = $state(false);

const statusStyles: Record<string, string> = {
  completed: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  running: "bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-200",
  queued: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  pending: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

function formatCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}

async function runScan(event: SubmitEvent) {
  event.preventDefault();
  if (running) return;
  error = null;
  planRequired = false;
  quotaExceeded = false;
  running = true;
  const body = {
    repoPath: repoPath.trim() || undefined,
    nodeModels: {
      orchestrator: modelId.trim() || CHEAP_MODEL,
      reviewer: modelId.trim() || CHEAP_MODEL,
      summarizer: modelId.trim() || CHEAP_MODEL,
    },
  };
  try {
    const trigger = await api<TriggerSecurityScanResponse>(
      `/api/projects/${data.projectId}/security/scan`,
      { method: "POST", body: JSON.stringify(body) },
    );
    await goto(`/security-reports/${trigger.reportId}`);
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 403 && err.code === "plan_required") {
        planRequired = true;
        error = err.message || "Security scanning requires Plus or Pro.";
      } else if (err.status === 402) {
        quotaExceeded = true;
        error = err.message || "Security scan quota exceeded for this period.";
      } else {
        error = err.message;
      }
    } else {
      error = "Could not start the security scan.";
    }
  } finally {
    running = false;
  }
}
</script>

<svelte:head>
  <title>Security — {data.project?.name ?? "Project"} — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <header>
    <div class="flex flex-wrap items-center gap-3 text-sm text-neutral-500">
      <a
        href={`/projects/${data.projectId}`}
        class="inline-flex items-center gap-1 hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        <ArrowLeft class="size-4" />
        Back to {data.project?.name ?? "project"}
      </a>
    </div>
    <h1 class="mt-2 text-2xl font-semibold tracking-tight">Security</h1>
    <p class="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
      Run a whole-project security scan: Snyk dependency vulnerabilities and SAST,
      secret detection across the tree, and an AI vulnerability analyst that
      surfaces logic flaws Snyk can't see.
    </p>
  </header>

  <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
      Run a scan
    </h2>
    <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
      The scan runs against a local checkout. MiniMax M3 is selected by default
      for every agent role to keep token cost low.
    </p>

    <form class="mt-4 flex flex-col gap-4" onsubmit={runScan} novalidate>
      <label class="flex max-w-xl flex-col gap-1 text-sm">
        <span class="font-medium">Repository path</span>
        <input
          type="text"
          bind:value={repoPath}
          autocomplete="off"
          spellcheck="false"
          class="input px-3 py-2 font-mono text-xs"
        />
      </label>
      <label class="flex max-w-xl flex-col gap-1 text-sm">
        <span class="font-medium">Model (all agent roles)</span>
        <input
          type="text"
          bind:value={modelId}
          autocomplete="off"
          spellcheck="false"
          class="input px-3 py-2 font-mono text-xs"
        />
        <span class="text-xs text-neutral-500">
          Defaults to {CHEAP_MODEL} (cheap). Upgrade to a stronger model for
          higher-quality findings.
        </span>
      </label>

      {#if error}
        <p role="alert" class="text-sm text-red-600 dark:text-red-400">{error}</p>
      {/if}

      {#if planRequired}
        <aside
          class="rounded-lg border border-brand-300 bg-brand-50 p-4 text-sm text-brand-800 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-200"
          role="note"
        >
          <p class="font-medium">Security scanning requires Plus or Pro.</p>
          <p class="mt-1">
            Upgrade your team's plan to run whole-project security scans.
          </p>
          <a
            href={data.project?.orgId
              ? `/teams/${data.project.orgId}/settings/billing`
              : "/dashboard"}
            class="mt-3 inline-block rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500"
          >
            Upgrade plan
          </a>
        </aside>
      {:else if quotaExceeded}
        <aside
          class="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          role="note"
        >
          <p class="font-medium">Weekly security scan quota reached.</p>
          <p class="mt-1">
            Your plan's security review limit for this period has been hit. Quotas
            reset weekly, or upgrade to Pro for unlimited scans.
          </p>
        </aside>
      {/if}

      <div class="flex items-center gap-4">
        <button
          type="submit"
          disabled={running}
          class="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? "Starting…" : "Run scan"}
        </button>
        {#if running}
          <span class="text-xs text-neutral-500" role="status">Starting scan…</span>
        {/if}
      </div>
    </form>
  </section>

  <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
      Scan history
    </h2>
    {#if data.reports.length === 0}
      <p class="mt-4 text-sm text-neutral-500">No scans yet.</p>
    {:else}
      <ul class="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">
        {#each data.reports as report (report.id)}
          <li>
            <a
              href={`/security-reports/${report.id}`}
              class="flex flex-wrap items-center justify-between gap-3 py-3 hover:opacity-80"
            >
              <div class="flex flex-wrap items-center gap-3">
                <span
                  class={`rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${statusStyles[report.status] ?? statusStyles.pending}`}
                >
                  {report.status}
                </span>
                <span class="text-xs text-neutral-500">
                  {formatDate(report.createdAt)}
                </span>
              </div>
              <div class="flex items-center gap-3 text-xs">
                {#if formatCount(report.criticalCount) > 0}
                  <span class="font-semibold text-red-600 dark:text-red-400">
                    {formatCount(report.criticalCount)} critical
                  </span>
                {/if}
                {#if formatCount(report.highCount) > 0}
                  <span class="font-semibold text-orange-600 dark:text-orange-400">
                    {formatCount(report.highCount)} high
                  </span>
                {/if}
                {#if formatCount(report.criticalCount) === 0 && formatCount(report.highCount) === 0}
                  <span class="text-neutral-500">No critical/high findings</span>
                {/if}
                <span class="inline-flex items-center gap-1 text-brand-600 dark:text-brand-300">
                  View
                  <ArrowRight class="size-4" />
                </span>
              </div>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>
