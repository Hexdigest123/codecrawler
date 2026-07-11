<script lang="ts">
  import { goto } from "$app/navigation";
  import { ApiError, api } from "$lib/api";
  import { toastError } from "$lib/toast.svelte";

  let name = $state("");
  let loading = $state(false);

  let disabled = $derived(loading || name.trim().length === 0);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (disabled) return;
    loading = true;
    try {
      const team = await api<{ id: string }>("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      await goto(`/teams/${team.id}`);
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : "Could not create team.");
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

    <button
      type="submit"
      {disabled}
      class="mt-2 rounded-md bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? "Creating…" : "Create team"}
    </button>
  </form>
</section>
