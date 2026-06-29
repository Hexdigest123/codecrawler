<script lang="ts">
  import { goto } from "$app/navigation";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import { ApiError, api } from "$lib/api";
  import { toastError } from "$lib/toast.svelte";
  import type { PageProps } from "./$types";

  type RepoItem = { id: number; fullName: string; private: boolean };
  type ReposResponse = { items: RepoItem[]; connected: boolean };

  let { params }: PageProps = $props();

  let name = $state("");
  let repoFullName = $state("");
  let provider = $state("github");
  let loading = $state(false);

const PROVIDER_LABEL: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
};

let repos: RepoItem[] = $state([]);
let reposConnected = $state(false);
let reposStatus = $state<"idle" | "loading" | "loaded" | "error">("idle");
let reposError = $state<string | null>(null);
let manualEntry = $state(false);

const showManualInput = $derived(
  reposStatus !== "loaded" ||
    manualEntry ||
    !repos.some((r) => r.fullName === repoFullName),
);

let disabled = $derived(loading || name.trim().length === 0 || repoFullName.trim().length === 0);

async function fetchRepos(p: string): Promise<void> {
  reposStatus = "loading";
  reposError = null;
  manualEntry = false;
  try {
    const res = await api<ReposResponse>(
      `/api/teams/${params.id}/vcs-repos?provider=${encodeURIComponent(p)}`,
    );
    repos = res.items ?? [];
    reposConnected = res.connected;
    reposStatus = "loaded";
  } catch (err) {
    repos = [];
    reposConnected = false;
    reposError = err instanceof ApiError ? err.message : "Could not load repositories.";
    reposStatus = "error";
  }
}

$effect(() => {
  void fetchRepos(provider);
});

function onRepoSelect(event: Event) {
  const select = event.target as HTMLSelectElement;
  const value = select.value;
  if (value === "__manual__") {
    manualEntry = true;
    repoFullName = "";
    return;
  }
  manualEntry = false;
  repoFullName = value;
  const seg = value.split("/").pop() ?? value;
  if (name.trim().length === 0) name = seg;
}

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (disabled) return;
    loading = true;
    try {
      await api(`/api/teams/${params.id}/projects`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          provider,
          repoFullName: repoFullName.trim(),
        }),
      });
      await goto(`/teams/${params.id}`);
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : "Could not connect repository.");
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Connect a repo — CodeCrawler</title>
</svelte:head>

<section class="mx-auto max-w-md py-6">
  <nav aria-label="Breadcrumb" class="mb-4 text-sm">
    <a
      href={`/teams/${params.id}`}
      class="inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
    >
      <ArrowLeft class="size-4" />
      Back to team
    </a>
  </nav>
  <h1 class="text-2xl font-semibold tracking-tight">Connect a repository</h1>
  <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
    Add a project so CodeCrawler can review its pull requests.
  </p>

  <form class="mt-6 flex flex-col gap-4" onsubmit={submit} novalidate>
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Project name</span>
      <input
        type="text"
        name="name"
        required
        bind:value={name}
        class="input px-3 py-2"
        placeholder="Backend API"
      />
    </label>

    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Provider</span>
      <select
        bind:value={provider}
        class="input px-3 py-2"
      >
        <option value="github">GitHub</option>
        <option value="gitlab">GitLab</option>
        <option value="gitea">Gitea</option>
      </select>
    </label>

    {#if reposStatus === "loading"}
      <p class="text-xs text-neutral-500">Loading repositories from {PROVIDER_LABEL[provider] ?? provider}…</p>
    {:else if reposStatus === "loaded" && reposConnected && repos.length > 0}
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Repository</span>
        <select
          class="input px-3 py-2"
          onchange={onRepoSelect}
          value={manualEntry ? "__manual__" : repoFullName}
        >
          <option value="" disabled>Select a repository…</option>
          {#each repos as repo (repo.id)}
            <option value={repo.fullName}>{repo.fullName}{repo.private ? " (private)" : ""}</option>
          {/each}
          <option value="__manual__">Other… (type manually)</option>
        </select>
        <span class="text-xs text-neutral-500">
          {repos.length} {repos.length === 1 ? "repository" : "repositories"} discovered on your
          {PROVIDER_LABEL[provider] ?? provider} connection.
        </span>
      </label>
    {:else if reposStatus === "loaded" && !reposConnected}
      <p class="rounded-md border border-dashed border-neutral-300 p-3 text-xs text-neutral-500 dark:border-neutral-700">
        No {PROVIDER_LABEL[provider] ?? provider} connection for this team yet.
        Add one in <a class="underline" href={`/teams/${params.id}/settings/vcs`}>team settings → VCS</a>,
        or type the repository full name below.
      </p>
    {:else if reposStatus === "error"}
      <p class="rounded-md border border-dashed border-red-300 p-3 text-xs text-red-600 dark:border-red-900 dark:text-red-400">
        {reposError ?? "Could not load repositories."} You can still type the repository full name below.
      </p>
    {/if}

    {#if showManualInput}
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Repository full name</span>
        <input
          type="text"
          name="repoFullName"
          required
          bind:value={repoFullName}
          class="input px-3 py-2"
          placeholder="owner/name"
        />
        <span class="text-xs text-neutral-500">For example, <code>acme/api</code>.</span>
      </label>
    {/if}

    <button
      type="submit"
      {disabled}
      class="mt-2 rounded-md bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? "Connecting…" : "Connect repo"}
    </button>
  </form>
</section>
