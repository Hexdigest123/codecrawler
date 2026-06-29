<script lang="ts">
import { ApiError, api } from "$lib/api";
import { toastError, toastSuccess } from "$lib/toast.svelte";
import { API_KEY_PROVIDERS, type ApiKeyRow, type ApiKeyStatus } from "$lib/types";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

let keysOverride = $state<ApiKeyRow[] | null>(null);
const keys = $derived<ApiKeyRow[]>(keysOverride ?? data.keys ?? []);
let provider = $state<string>(API_KEY_PROVIDERS[0]);
let label = $state("");
let key = $state("");
let adding = $state(false);
let busyProvider = $state<string | null>(null);

const statusStyles: Record<ApiKeyStatus, string> = {
  valid: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
  invalid: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  unverified: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
};

function statusLabel(status: ApiKeyStatus): string {
  if (status === "valid") return "Valid";
  if (status === "invalid") return "Invalid";
  return "Unverified";
}

async function addKey(event: SubmitEvent) {
  event.preventDefault();
  if (key.trim().length === 0) return;
  adding = true;
  try {
    await api(`/api/teams/${data.teamId}/api-keys`, {
      method: "POST",
      body: JSON.stringify({
        provider,
        label: label.trim(),
        key: key.trim(),
      }),
    });
    key = "";
    label = "";
    keysOverride = await api<ApiKeyRow[]>(`/api/teams/${data.teamId}/api-keys`);
    toastSuccess(`${provider} key added.`);
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : "Could not add key.");
  } finally {
    adding = false;
  }
}

async function verify(targetProvider: string) {
  busyProvider = targetProvider;
  try {
    const res = await api<{ status: ApiKeyStatus }>(
      `/api/teams/${data.teamId}/api-keys/${targetProvider}/verify`,
      { method: "POST" },
    );
    keysOverride = await api<ApiKeyRow[]>(`/api/teams/${data.teamId}/api-keys`);
    toastSuccess(`${targetProvider} key ${res.status === "valid" ? "verified" : "checked"}.`);
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : "Verification failed.");
  } finally {
    busyProvider = null;
  }
}

async function removeKey(targetProvider: string) {
  if (!confirm(`Remove the ${targetProvider} key?`)) return;
  busyProvider = targetProvider;
  try {
    await api(`/api/teams/${data.teamId}/api-keys/${targetProvider}`, { method: "DELETE" });
    keysOverride = await api<ApiKeyRow[]>(`/api/teams/${data.teamId}/api-keys`);
    toastSuccess(`${targetProvider} key removed.`);
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : "Could not remove key.");
  } finally {
    busyProvider = null;
  }
}
</script>

<svelte:head>
  <title>API keys — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <header>
    <h1 class="text-2xl font-semibold tracking-tight">API keys (BYOK)</h1>
    <p class="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
      Register your own provider keys to run reviews on your own spend (unlimited, plan budget
      bypassed). Keys are encrypted at rest and never shown again after adding — only their
      verification status is displayed.
    </p>
  </header>

  <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Add a key</h2>
    <form class="mt-4 grid gap-4 sm:grid-cols-4" onsubmit={addKey} novalidate>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Provider</span>
        <select
          bind:value={provider}
          class="input px-3 py-2"
        >
          {#each API_KEY_PROVIDERS as p (p)}
            <option value={p}>{p}</option>
          {/each}
        </select>
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Label</span>
        <input
          type="text"
          bind:value={label}
          class="input px-3 py-2"
          placeholder="Production"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm sm:col-span-2">
        <span class="font-medium">Secret key</span>
        <input
          type="password"
          required
          autocomplete="off"
          bind:value={key}
          class="input px-3 py-2"
          placeholder="sk-…"
        />
      </label>
      <div class="flex items-end sm:col-span-4">
        <button
          type="submit"
          disabled={adding || key.trim().length === 0}
          class="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {adding ? "Adding…" : "Add key"}
        </button>
      </div>
    </form>
  </section>

  <section class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Registered keys</h2>
    {#if keys.length === 0}
      <p class="mt-4 text-sm text-neutral-500">No keys registered yet.</p>
    {:else}
      <ul class="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">
        {#each keys as row (row.id)}
          <li class="flex flex-wrap items-center justify-between gap-3 py-3">
            <div class="flex items-center gap-3">
              <span class="font-medium">{row.provider}</span>
              {#if row.label}<span class="text-sm text-neutral-500">{row.label}</span>{/if}
              <span
                class={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[row.status]}`}
              >
                {statusLabel(row.status)}
              </span>
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                onclick={() => verify(row.provider)}
                disabled={busyProvider === row.provider}
                class="rounded-md border border-neutral-300 px-3 py-1 text-sm font-medium bg-white hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
              >
                {busyProvider === row.provider ? "…" : "Verify"}
              </button>
              <button
                type="button"
                onclick={() => removeKey(row.provider)}
                disabled={busyProvider === row.provider}
                class="rounded-md border border-red-300 px-3 py-1 text-sm font-medium text-red-600 bg-white hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:bg-neutral-900 dark:hover:bg-red-950"
              >
                Remove
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>
