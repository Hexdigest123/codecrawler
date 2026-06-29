<script lang="ts">
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import GitPullRequest from "@lucide/svelte/icons/git-pull-request";
  import { api } from "$lib/api";
  import { renderMarkdown } from "$lib/markdown";
  import type {
    Diff,
    DiffFile,
    ReviewFinding,
    ReviewResponse,
  } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  let override = $state<ReviewResponse | null>(null);
  let pollError = $state<string | null>(null);

  const detail = $derived(override ?? data.detail);
  const review = $derived(detail.review);
  const pullRequest = $derived(detail.pullRequest);
  const project = $derived(detail.project);
  const diff = $derived<Diff | null>(detail.diff ?? null);
  const findings = $derived<ReviewFinding[]>(detail.findings ?? []);

  const SEVERITY_ORDER = ["critical", "high", "medium", "low", "nitpick"];

  const severityStyles: Record<string, string> = {
    critical: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    high: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
    medium: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    low: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
    nitpick: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  };

  const statusStyles: Record<string, string> = {
    completed: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
    running: "bg-brand-100 text-brand-800 dark:bg-brand-950 dark:text-brand-300",
    queued: "bg-brand-100 text-brand-800 dark:bg-brand-950 dark:text-brand-300",
    pending: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    cancelled: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  };

  const billingStyles: Record<string, string> = {
    byok: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
    hosted: "bg-brand-50 text-brand-600",
    mixed: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  };

  const isRunning = $derived(
    review.status === "running" || review.status === "pending" || review.status === "queued",
  );

  const walkthroughHtml = $derived(review.walkthrough ? renderMarkdown(review.walkthrough) : "");

  const pageTitle = $derived(
    pullRequest
      ? `#${pullRequest.externalNumber ?? ""} ${pullRequest.title ?? "Review"} — CodeCrawler`
      : "Review — CodeCrawler",
  );

  const groupedFindings = $derived.by(() => {
    const groups = new Map<string, ReviewFinding[]>();
    for (const finding of findings) {
      const key = (finding.severity ?? "low").toLowerCase();
      const list = groups.get(key) ?? [];
      list.push(finding);
      groups.set(key, list);
    }
    return SEVERITY_ORDER.filter((severity) => groups.has(severity)).map((severity) => ({
      severity,
      items: groups.get(severity) ?? [],
    }));
  });

  // Build a map of file path -> DiffFile so finding snippets are O(1).
  const diffByPath = $derived.by(() => {
    const m = new Map<string, DiffFile>();
    for (const f of diff?.files ?? []) {
      if (f?.path) m.set(f.path, f);
    }
    return m;
  });

  $effect(() => {
    if (!isRunning) return;
    const id = data.id;
    const handle = setInterval(async () => {
      try {
        override = await api<ReviewResponse>(`/api/reviews/${id}`);
      } catch (err) {
        pollError = err instanceof Error ? err.message : "Failed to refresh review.";
      }
    }, 2500);
    return () => clearInterval(handle);
  });

  function formatDate(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
  }

  /**
   * Extract a tight code snippet from a unified-diff patch around the line the
   * finding references. Returns null if no usable context. The `line` from the
   * reviewer is a HEAD-side (new) line number, so we walk added/context lines.
   */
  function snippetForFinding(file: DiffFile | undefined, targetLine: number | null | undefined): string | null {
    if (!file?.patch || !Number.isFinite(targetLine ?? 0) || (targetLine ?? 0) <= 0) return null;
    const patch = file.patch;
    const lines = patch.split("\n");
    let currentNew = 0;
    const interesting: { n: number; text: string; kind: "add" | "del" | "ctx" }[] = [];
    for (const line of lines) {
      const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (hunkMatch) {
        currentNew = Number.parseInt(hunkMatch[1] ?? "1", 10);
        continue;
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        interesting.push({ n: currentNew, text: line.slice(1), kind: "add" });
        currentNew += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        interesting.push({ n: currentNew, text: line.slice(1), kind: "del" });
      } else if (line.startsWith(" ")) {
        interesting.push({ n: currentNew, text: line.slice(1), kind: "ctx" });
        currentNew += 1;
      }
    }
    const t = targetLine as number;
    const idx = interesting.findIndex((l) => l.n === t && l.kind !== "del");
    if (idx === -1) return null;
    const start = Math.max(0, idx - 3);
    const end = Math.min(interesting.length, idx + 4);
    return interesting
      .slice(start, end)
      .map((l) => {
        const marker = l.n === t ? "▶" : " ";
        const sigil = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
        return `${marker} ${sigil} ${l.text}`;
      })
      .join("\n");
  }
</script>

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <!-- PR header -->
  <header class="flex flex-wrap items-start justify-between gap-4">
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <GitPullRequest class="size-6 text-neutral-400" />
          {#if pullRequest}
            <span class="font-mono text-base text-neutral-500">#{pullRequest.externalNumber ?? "?"}</span>
            <span class="truncate">{pullRequest.title ?? "(no title)"}</span>
          {:else}
            Review
          {/if}
        </h1>
        <span
          class={`rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${statusStyles[review.status] ?? statusStyles.pending}`}
        >
          {review.status}
        </span>
        {#if review.source}
          <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:bg-neutral-800">
            {review.source}
          </span>
        {/if}
        {#if review.billingMode}
          <span
            class={`rounded-full px-2 py-0.5 text-xs font-medium ${billingStyles[review.billingMode] ?? "bg-neutral-100 text-neutral-700"}`}
          >
            {review.billingMode}
          </span>
        {/if}
      </div>
      <p class="mt-1 text-xs text-neutral-500">
        {#if pullRequest?.author}by {pullRequest.author} · {/if}
        {#if project}{project.provider ?? "github"} · {project.repoFullName ?? project.name}{/if}
      </p>
      <div class="mt-2 flex flex-wrap items-center gap-3 text-xs">
        {#if pullRequest?.htmlUrl}
          <a
            href={pullRequest.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1 text-brand-700 hover:underline dark:text-brand-300"
          >
            <ExternalLink class="size-3.5" />
            Open on {project?.provider ?? "GitHub"}
          </a>
        {/if}
        <span class="text-neutral-400">Review ID: <span class="font-mono">{review.id}</span></span>
        <span class="text-neutral-400">Created: {formatDate(review.createdAt)}</span>
        {#if review.completedAt}
          <span class="text-neutral-400">Completed: {formatDate(review.completedAt)}</span>
        {/if}
      </div>
    </div>
    <dl class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
      <dt class="text-neutral-500">Credits</dt>
      <dd class="font-medium">{review.creditsCost ?? "0"}</dd>
      <dt class="text-neutral-500">Token spend</dt>
      <dd class="font-medium">${Number(review.tokenSpendUsd ?? 0).toFixed(4)}</dd>
    </dl>
  </header>

  {#if isRunning}
    <p
      role="status"
      class="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700 dark:border-brand-900 dark:bg-brand-950 dark:text-brand-200"
    >
      Review in progress. This page will refresh automatically.
    </p>
  {/if}
  {#if pollError}
    <p role="alert" class="text-sm text-red-600 dark:text-red-400">{pollError}</p>
  {/if}

  {#if review.modelIds && review.modelIds.length > 0}
    <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Models used</h2>
      <div class="mt-3 flex flex-wrap gap-2">
        {#each review.modelIds as modelId (modelId)}
          <span class="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium dark:bg-neutral-800">
            {modelId}
          </span>
        {/each}
      </div>
    </section>
  {/if}

  <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Walkthrough</h2>
    {#if isRunning || !review.walkthrough}
      <p class="mt-3 text-sm text-neutral-500">
        The walkthrough will appear once the review completes.
      </p>
    {:else}
      <div class="prose-review mt-3 text-sm leading-relaxed">
        {@html walkthroughHtml}
      </div>
    {/if}
  </section>

  <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
      Findings ({findings.length})
    </h2>
    {#if findings.length === 0}
      <p class="mt-3 text-sm text-neutral-500">
        {#if isRunning}Findings will appear as the review progresses.{:else}No findings.{/if}
      </p>
    {:else}
      <div class="mt-4 flex flex-col gap-6">
        {#each groupedFindings as group (group.severity)}
          <div>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {group.severity} ({group.items.length})
            </h3>
            <ul class="mt-2 flex flex-col gap-3">
              {#each group.items as finding, i (finding.id ?? i)}
                {@const file = diffByPath.get(finding.file ?? "")}
                {@const snippet = snippetForFinding(file, finding.line)}
                <li class="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                  <div class="flex flex-wrap items-center gap-2">
                    <span
                      class={`rounded-full px-2 py-0.5 text-xs font-medium ${severityStyles[group.severity] ?? severityStyles.nitpick}`}
                    >
                      {group.severity}
                    </span>
                    <span
                      class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium capitalize dark:bg-neutral-800"
                    >
                      {finding.category?.replace("_", " ") ?? "issue"}
                    </span>
                    <span class="font-mono text-xs text-neutral-500">
                      {finding.file ?? "(unknown file)"}{#if finding.line}:{finding.line}{/if}
                    </span>
                  </div>
                  <p class="mt-2 text-sm">{finding.message}</p>
                  {#if snippet}
                    <pre class="mt-2 overflow-x-auto rounded-md bg-neutral-50 p-2 text-xs leading-relaxed dark:bg-neutral-900"><code>{snippet}</code></pre>
                  {/if}
                  {#if finding.suggestion}
                    <p class="mt-2 rounded-md bg-neutral-50 p-2 text-sm dark:bg-neutral-900">
                      <span class="font-medium">Suggestion: </span>{finding.suggestion}
                    </p>
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  {#if diff && diff.files.length > 0}
    <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
      <details>
        <summary class="cursor-pointer text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Reviewed diff ({diff.files.length} file{diff.files.length === 1 ? "" : "s"})
        </summary>
        <ul class="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
          {#each diff.files as f (f.path)}
            <li class="py-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-mono text-xs">{f.path}</span>
                <span class="text-xs text-neutral-500">
                  {f.status ?? "—"} · +{f.additions ?? 0}/-{f.deletions ?? 0}
                </span>
              </div>
              {#if f.patch}
                <pre class="mt-1 max-h-60 overflow-auto rounded-md bg-neutral-50 p-2 text-xs leading-relaxed dark:bg-neutral-900"><code>{f.patch}</code></pre>
              {/if}
            </li>
          {/each}
        </ul>
      </details>
    </section>
  {/if}
</section>

<style>
  .prose-review :global(h1),
  .prose-review :global(h2),
  .prose-review :global(h3),
  .prose-review :global(h4) {
    font-weight: 600;
    margin-top: 1rem;
    margin-bottom: 0.5rem;
    line-height: 1.3;
  }
  .prose-review :global(h1) { font-size: 1.25rem; }
  .prose-review :global(h2) { font-size: 1.125rem; }
  .prose-review :global(h3) { font-size: 1rem; }
  .prose-review :global(h4) { font-size: 0.875rem; }
  .prose-review :global(p) { margin: 0.5rem 0; }
  .prose-review :global(ul),
  .prose-review :global(ol) { margin: 0.5rem 0; padding-left: 1.25rem; }
  .prose-review :global(ul) { list-style: disc; }
  .prose-review :global(ol) { list-style: decimal; }
  .prose-review :global(li) { margin: 0.15rem 0; }
  .prose-review :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
    background: rgba(120, 120, 120, 0.15);
    padding: 0.1rem 0.3rem;
    border-radius: 0.25rem;
  }
  .prose-review :global(pre) {
    background: rgba(120, 120, 120, 0.1);
    padding: 0.75rem;
    border-radius: 0.375rem;
    overflow-x: auto;
    margin: 0.5rem 0;
  }
  .prose-review :global(pre code) {
    background: transparent;
    padding: 0;
  }
  .prose-review :global(blockquote) {
    border-left: 3px solid rgba(120, 120, 120, 0.3);
    padding-left: 0.75rem;
    color: rgb(115, 115, 115);
    margin: 0.5rem 0;
  }
  .prose-review :global(a) {
    color: rgb(220, 100, 50);
    text-decoration: underline;
  }
  .prose-review :global(hr) {
    border: 0;
    border-top: 1px solid rgba(120, 120, 120, 0.25);
    margin: 1rem 0;
  }
  .prose-review :global(table) {
    border-collapse: collapse;
    margin: 0.5rem 0;
  }
  .prose-review :global(th),
  .prose-review :global(td) {
    border: 1px solid rgba(120, 120, 120, 0.25);
    padding: 0.25rem 0.5rem;
  }
</style>
