<script lang="ts">
  import { PLAN_LABEL, type AuditEntry } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const entries = $derived<AuditEntry[]>(data.entries ?? []);
  const isAdmin = $derived(
    data.team?.role === "owner" || data.team?.role === "admin",
  );

  function formatDateTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function actionLabel(action: string): string {
    return action
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function metadataSummary(entry: AuditEntry): string {
    const meta = entry.metadata;
    if (!meta || typeof meta !== "object") return "";
    const parts: string[] = [];
    for (const [key, value] of Object.entries(meta)) {
      if (value === null || value === undefined) continue;
      parts.push(`${key}: ${formatValue(value)}`);
    }
    return parts.join(" · ");
  }

  function formatValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
</script>

<svelte:head>
  <title>Audit log — {data.team?.organization?.name ?? "Team"} — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <header>
    <div class="flex items-center gap-3">
      <h1 class="text-2xl font-semibold tracking-tight">Audit log</h1>
      <span
        class="rounded-full border border-neutral-300 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-700"
      >
        {data.team ? PLAN_LABEL[data.team.plan] : "—"}
      </span>
    </div>
    <p class="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
      A record of administrative and account events in this team. Owners and admins can
      review who did what and when.
    </p>
  </header>

  {#if data.forbidden || !isAdmin}
    <section
      class="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800"
      aria-label="Restricted"
    >
      <h2 class="text-lg font-semibold">Admins only</h2>
      <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        The audit log is visible to team owners and admins. Ask an admin if you need
        access.
      </p>
    </section>
  {:else if entries.length === 0}
    <section
      class="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800"
      aria-label="Empty"
    >
      <h2 class="text-lg font-semibold">No events yet</h2>
      <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Administrative actions, membership changes, and plan events will appear here as
        they happen.
      </p>
    </section>
  {:else}
    <section
      class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
      aria-label="Audit entries"
    >
      <ol class="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
        {#each entries as entry (entry.id)}
          <li class="flex flex-col gap-1 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex flex-col gap-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium">{actionLabel(entry.action)}</span>
                {#if entry.actorUserId}
                  <span
                    class="rounded-full bg-neutral-100 px-2 py-0.5 font-mono text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  >
                    {entry.actorUserId}
                  </span>
                {/if}
              </div>
              {#if metadataSummary(entry)}
                <p class="text-xs text-neutral-500">{metadataSummary(entry)}</p>
              {/if}
            </div>
            <time
              datetime={entry.createdAt}
              class="shrink-0 text-xs text-neutral-500 sm:text-right"
            >
              {formatDateTime(entry.createdAt)}
            </time>
          </li>
        {/each}
      </ol>
    </section>
  {/if}
</section>
