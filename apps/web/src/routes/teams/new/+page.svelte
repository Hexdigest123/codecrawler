<script lang="ts">
import { goto } from "$app/navigation";
import { ApiError, api } from "$lib/api";

let name = $state("");
let slug = $state("");
let error = $state<string | null>(null);
let loading = $state(false);

let disabled = $derived(loading || name.trim().length === 0);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (disabled) return;
  error = null;
  loading = true;
  const payload: { name: string; slug?: string } = { name: name.trim() };
  if (slug.trim().length > 0) {
    payload.slug = slug.trim();
  }
  try {
    const team = await api<{ id: string }>("/api/teams", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await goto(`/teams/${team.id}`);
  } catch (err) {
    error = err instanceof ApiError ? err.message : "Could not create team.";
  } finally {
    loading = false;
  }
}
</script>

<svelte:head>
  <title>New team — CodeCrawler</title>
</svelte:head>

<section class="mx-auto max-w-md py-6">
  <h1 class="text-2xl font-semibold tracking-tight">Create a team</h1>
  <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
    Teams own your projects, agent profiles, and API keys.
  </p>

  <form class="mt-6 flex flex-col gap-4" onsubmit={submit} novalidate>
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Team name</span>
      <input
        type="text"
        name="name"
        required
        bind:value={name}
        class="input px-3 py-2"
        placeholder="Acme Engineering"
      />
    </label>

    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Slug (optional)</span>
      <input
        type="text"
        name="slug"
        bind:value={slug}
        class="input px-3 py-2"
        placeholder="acme-eng"
      />
      <span class="text-xs text-neutral-500">Left blank, we'll derive one from the name.</span>
    </label>

    {#if error}
      <p role="alert" class="text-sm text-red-600 dark:text-red-400">{error}</p>
    {/if}

    <button
      type="submit"
      {disabled}
      class="mt-2 rounded-md bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? "Creating…" : "Create team"}
    </button>
  </form>
</section>
