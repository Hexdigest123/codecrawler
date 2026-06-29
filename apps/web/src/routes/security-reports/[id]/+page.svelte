<script lang="ts">
import ArrowRight from "@lucide/svelte/icons/arrow-right";
import { api } from "$lib/api";
import type {
  SecurityFinding,
  SecurityReportDetail,
  Severity,
} from "$lib/types";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

let override = $state<SecurityReportDetail | null>(null);
let pollError = $state<string | null>(null);

const detail = $derived(override ?? data.report);
const report = $derived(detail.report);
const findings = $derived<SecurityFinding[]>(detail.findings ?? []);

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "nitpick"];

const severityStyles: Record<Severity, string> = {
  critical: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  low: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  nitpick: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

const statusStyles: Record<string, string> = {
  completed: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  running: "bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-200",
  queued: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  pending: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

const billingStyles: Record<string, string> = {
  byok: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
  hosted: "bg-brand-50 text-brand-600",
  mixed: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

const kindStyles: Record<string, string> = {
  dep: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300",
  sast: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  secret: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  ai: "bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-200",
};

const isRunning = $derived(
  report.status === "running" ||
    report.status === "pending" ||
    report.status === "queued",
);

$effect(() => {
  if (!isRunning) {
    return;
  }
  const id = data.id;
  const handle = setInterval(async () => {
    try {
      override = await api<SecurityReportDetail>(`/api/security-reports/${id}`);
    } catch (err) {
      pollError = err instanceof Error ? err.message : "Failed to refresh report.";
    }
  }, 3000);
  return () => clearInterval(handle);
});

const paragraphs = $derived((report.summary ?? "").split(/\n{2,}/));

const criticalCount = $derived(
  findings.filter((f) => (f.severity ?? "").toLowerCase() === "critical").length,
);

const snykLabel = $derived.by(() => {
  const source = (report.snykSource ?? "").toLowerCase();
  if (!source) return null;
  if (source === "cli" || source === "snyk" || source === "snyk_cli") {
    return { label: "Snyk CLI", tone: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300" };
  }
  return { label: "fixture (Snyk unavailable)", tone: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300" };
});

const groupedFindings = $derived.by(() => {
  const groups = new Map<Severity, SecurityFinding[]>();
  for (const finding of findings) {
    const key = (finding.severity ?? "low").toLowerCase() as Severity;
    const list = groups.get(key) ?? [];
    list.push(finding);
    groups.set(key, list);
  }
  return SEVERITY_ORDER.filter((s) => groups.has(s)).map((s) => ({
    severity: s,
    items: groups.get(s) ?? [],
  }));
});

function formatNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "0";
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? String(n) : "0";
}

function formatUsd(value: string | number | null | undefined): string {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? `$${n.toFixed(4)}` : "$0.0000";
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}
</script>

<svelte:head>
  <title>Security report — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <header class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-2xl font-semibold tracking-tight">Security report</h1>
        <span
          class={`rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${statusStyles[report.status] ?? statusStyles.pending}`}
        >
          {report.status}
        </span>
        {#if report.billingMode}
          <span
            class={`rounded-full px-2 py-0.5 text-xs font-medium ${billingStyles[report.billingMode] ?? "bg-neutral-100 text-neutral-700"}`}
          >
            {report.billingMode}
          </span>
        {/if}
        {#if snykLabel}
          <span class={`rounded-full px-2 py-0.5 text-xs font-medium ${snykLabel.tone}`}>
            {snykLabel.label}
          </span>
        {/if}
      </div>
      <p class="mt-1 text-xs text-neutral-500">Report {report.id}</p>
      <p class="mt-1 text-xs text-neutral-500">
        Created {formatDate(report.createdAt)}
        {#if report.completedAt}
          · Completed {formatDate(report.completedAt)}
        {/if}
      </p>
    </div>
    <dl class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
      <dt class="text-neutral-500">Credits</dt>
      <dd class="font-medium">{formatNumber(report.creditsCost)}</dd>
      <dt class="text-neutral-500">Token spend</dt>
      <dd class="font-medium">{formatUsd(report.tokenSpendUsd)}</dd>
    </dl>
  </header>

  {#if criticalCount > 0}
    <p
      role="alert"
      class="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm font-medium text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    >
      {criticalCount} critical {criticalCount === 1 ? "finding" : "findings"} require
      immediate attention.
    </p>
  {/if}

  {#if isRunning}
    <p
      role="status"
      class="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700 dark:border-brand-900 dark:bg-brand-950 dark:text-brand-200"
    >
      Scan in progress. This page will refresh automatically.
    </p>
  {/if}
  {#if pollError}
    <p role="alert" class="text-sm text-red-600 dark:text-red-400">{pollError}</p>
  {/if}

  {#if report.modelIds && report.modelIds.length > 0}
    <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Models used
      </h2>
      <div class="mt-3 flex flex-wrap gap-2">
        {#each report.modelIds as modelId (modelId)}
          <span class="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium dark:bg-neutral-800">
            {modelId}
          </span>
        {/each}
      </div>
    </section>
  {/if}

  <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Summary</h2>
    {#if isRunning || !report.summary}
      <p class="mt-3 text-sm text-neutral-500">
        The report summary will appear once the scan completes.
      </p>
    {:else}
      <div class="mt-3 space-y-3 text-sm leading-relaxed">
        {#each paragraphs as paragraph, i (i)}
          <p class="whitespace-pre-wrap">{paragraph}</p>
        {/each}
      </div>
    {/if}
  </section>

  <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
      Findings ({findings.length})
    </h2>
    {#if findings.length === 0}
      <p class="mt-3 text-sm text-neutral-500">
        {#if isRunning}Findings will appear as the scan progresses.{:else}No findings.{/if}
      </p>
    {:else}
      <div class="mt-4 flex flex-col gap-6">
        {#each groupedFindings as group (group.severity)}
          <div>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {group.severity} ({group.items.length})
            </h3>
            <ul class="mt-2 flex flex-col gap-3">
              {#each group.items as finding, i (i)}
                <li class="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                  <div class="flex flex-wrap items-center gap-2">
                    <span
                      class={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${severityStyles[group.severity] ?? severityStyles.nitpick}`}
                    >
                      {group.severity}
                    </span>
                    <span
                      class={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${kindStyles[finding.kind] ?? "bg-neutral-100 text-neutral-700 dark:bg-neutral-800"}`}
                    >
                      {finding.kind}
                    </span>
                    {#if finding.kind === "dep" && finding.package}
                      <span class="font-mono text-xs text-neutral-500">
                        {finding.package}
                        {#if finding.vulnVersion}
                          <span class="ml-1">@{finding.vulnVersion}</span>
                        {/if}
                        {#if finding.fixedVersion}
                          <span class="ml-1 inline-flex items-center gap-0.5">
                            <ArrowRight class="size-3" />
                            {finding.fixedVersion}
                          </span>
                        {/if}
                      </span>
                    {:else if finding.file}
                      <span class="font-mono text-xs text-neutral-500">
                        {finding.file}{#if finding.line}:{finding.line}{/if}
                      </span>
                    {/if}
                  </div>
                  <p class="mt-2 text-sm">{finding.message}</p>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      </div>
    {/if}
  </section>
</section>
