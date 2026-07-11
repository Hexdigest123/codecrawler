<script lang="ts">
import { ApiError, api } from "$lib/api";
import { NOTIFICATION_CATEGORIES, type NotificationSettings } from "$lib/types";
import { toastError, toastSuccess } from "$lib/toast.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// svelte-ignore state_referenced_locally
let settings = $state<NotificationSettings>({ ...data.settings });
let saving = $state(false);
let dirty = $state(false);

function toggle(key: (typeof NOTIFICATION_CATEGORIES)[number]["key"]): void {
  settings = { ...settings, [key]: !settings[key] };
  dirty = true;
}

async function save(event: SubmitEvent) {
  event.preventDefault();
  saving = true;
  try {
    const res = await api<{ settings: NotificationSettings }>("/api/me/notifications", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
    settings = { ...res.settings };
    dirty = false;
    toastSuccess("Notification preferences saved.");
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : "Could not save preferences.");
  } finally {
    saving = false;
  }
}
</script>

<svelte:head>
  <title>Notifications — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-10">
  <header>
    <h1 class="text-2xl font-semibold tracking-tight">Notifications</h1>
    <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
      Choose which CodeCrawler emails you receive at
      <span class="font-medium">{data.currentEmail}</span>.
    </p>
  </header>

  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="Email categories"
  >
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Email categories</h2>
    <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
      Security notices (password changes, 2FA, account changes, approvals) are always sent and
      cannot be disabled.
    </p>

    <form class="mt-4 flex flex-col gap-3" onsubmit={save} novalidate>
      {#each NOTIFICATION_CATEGORIES as cat (cat.key)}
        <label
          class={`flex cursor-pointer items-start justify-between gap-4 rounded-lg border p-4 text-sm transition-colors ${
            settings[cat.key]
              ? "border-brand-500 bg-brand-50/50 dark:bg-brand-950/30"
              : "border-neutral-300 dark:border-neutral-700"
          }`}
        >
          <span>
            <span class="font-medium">{cat.label}</span>
            <span class="mt-0.5 block text-xs text-neutral-500">{cat.description}</span>
          </span>
          <input
            type="checkbox"
            class="mt-0.5 size-4 shrink-0"
            checked={settings[cat.key]}
            onchange={() => toggle(cat.key)}
          />
        </label>
      {/each}

      <div>
        <button
          type="submit"
          disabled={saving || !dirty}
          class="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save preferences"}
        </button>
      </div>
    </form>
  </section>
</section>
