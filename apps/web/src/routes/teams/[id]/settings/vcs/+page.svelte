<script lang="ts">
  import { ApiError, api } from "$lib/api";
  import type { PageProps } from "./$types";
  import type { VcsConnection } from "./+page";

  let { data }: PageProps = $props();

  const PROVIDERS = [
    { value: "github", label: "GitHub" },
    { value: "gitlab", label: "GitLab" },
    { value: "gitea", label: "Gitea" },
  ] as const;

  const PROVIDER_LABEL: Record<string, string> = {
    github: "GitHub",
    gitlab: "GitLab",
    gitea: "Gitea",
  };

  const PROVIDER_BADGE: Record<string, string> = {
    github: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200",
    gitlab: "bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
    gitea: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
  };

  function providerLabel(p: string): string {
    return PROVIDER_LABEL[p] ?? p;
  }

  function providerBadgeClass(p: string): string {
    return PROVIDER_BADGE[p] ?? PROVIDER_BADGE.github;
  }

  function kindLabel(kind: string | null | undefined): string {
    if (!kind) return "Token";
    if (kind === "github_app") return "GitHub App";
    if (kind === "oauth") return "OAuth";
    return kind;
  }

  function formatDate(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
  }

  let connectionsOverride = $state<VcsConnection[] | null>(null);
  const connections = $derived<VcsConnection[]>(connectionsOverride ?? data.connections ?? []);

  let provider = $state<string>("github");
  let token = $state("");
  let baseUrl = $state("");
  let adding = $state(false);
  let addError = $state<string | null>(null);
  let success = $state<string | null>(null);

  const showBaseUrl = $derived(provider === "gitea");
  const canSubmit = $derived(
    token.trim().length > 0 && (!showBaseUrl || baseUrl.trim().length > 0),
  );

  async function refetchConnections(): Promise<void> {
    connectionsOverride = await api<VcsConnection[]>(
      `/api/teams/${data.teamId}/vcs-connections`,
    );
  }

  async function addConnection(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    addError = null;
    success = null;
    adding = true;
    try {
      const body: { token: string; orgId: string; baseUrl?: string } = {
        token: token.trim(),
        orgId: data.teamId,
      };
      if (showBaseUrl) body.baseUrl = baseUrl.trim();
      await api<{ ok: boolean }>(`/api/vcs/connect/${provider}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      token = "";
      baseUrl = "";
      success = `${providerLabel(provider)} connection added.`;
      await refetchConnections();
    } catch (err) {
      addError = err instanceof ApiError ? err.message : "Could not add connection.";
    } finally {
      adding = false;
    }
  }
</script>

<svelte:head>
  <title>VCS connections — {data.team?.organization?.name ?? "Team"} — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <header>
    <h1 class="text-2xl font-semibold tracking-tight">VCS connections</h1>
    <p class="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
      Connect GitHub, GitLab, or Gitea so CodeCrawler can read pull/merge requests and post
      reviews. Tokens are encrypted at rest and never displayed again after adding.
    </p>
  </header>

  <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Add a connection</h2>
    <form class="mt-4 flex flex-col gap-4" onsubmit={addConnection} novalidate>
      <label class="flex max-w-xs flex-col gap-1 text-sm">
        <span class="font-medium">Provider</span>
        <select
          bind:value={provider}
          class="input px-3 py-2"
        >
          {#each PROVIDERS as p (p.value)}
            <option value={p.value}>{p.label}</option>
          {/each}
        </select>
      </label>

      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Access token</span>
        <input
          type="password"
          required
          autocomplete="off"
          bind:value={token}
          class="input px-3 py-2"
          placeholder="paste token"
        />
      </label>

      {#if showBaseUrl}
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Base URL</span>
          <input
            type="url"
            required
            bind:value={baseUrl}
            class="input px-3 py-2"
            placeholder="https://gitea.example.com"
          />
          <span class="text-xs text-neutral-500">The root URL of your self-hosted Gitea instance.</span>
        </label>
      {/if}

      <p class="max-w-2xl text-xs text-neutral-500">
        GitHub connections normally use the GitHub App; for testing you can paste a personal access
        token. GitLab/Gitea use a personal/team token.
      </p>

      {#if addError}
        <p role="alert" class="text-sm text-red-600 dark:text-red-400">{addError}</p>
      {/if}
      {#if success}
        <p role="status" class="text-sm text-green-600 dark:text-green-400">{success}</p>
      {/if}

      <div class="flex items-center gap-4">
        <button
          type="submit"
          disabled={adding || !canSubmit}
          class="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {adding ? "Connecting…" : "Add connection"}
        </button>
      </div>
    </form>
  </section>

  <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Connected accounts</h2>
    {#if connections.length === 0}
      <p class="mt-4 text-sm text-neutral-500">No VCS connections yet.</p>
    {:else}
      <ul class="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">
        {#each connections as conn (conn.id)}
          <li class="flex flex-wrap items-center justify-between gap-3 py-3">
            <div class="flex items-center gap-3">
              <span
                class={`rounded-full px-2 py-0.5 text-xs font-medium ${providerBadgeClass(conn.provider)}`}
              >
                {providerLabel(conn.provider)}
              </span>
              <span class="text-sm text-neutral-500">{kindLabel(conn.kind)}</span>
            </div>
            <span class="text-xs text-neutral-500">Added {formatDate(conn.createdAt)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>
