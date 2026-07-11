<script lang="ts">
import { ApiError, api } from "$lib/api";
import { toastError, toastSuccess } from "$lib/toast.svelte";
import {
  SIGNUP_MODE_LABEL,
  type SignupConfig,
  type SignupMode,
  type SignupRequestRow,
} from "$lib/types";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const MODES: SignupMode[] = ["open", "domain_restricted", "approval", "closed"];

// svelte-ignore state_referenced_locally
let config = $state<SignupConfig>({
  signupMode: data.config.signupMode,
  allowedDomains: data.config.allowedDomains,
  paymentsEnabled: data.config.paymentsEnabled,
});
// svelte-ignore state_referenced_locally
let domainsText = $state(data.config.allowedDomains.join("\n"));
let saving = $state(false);

// svelte-ignore state_referenced_locally
let requests = $state<SignupRequestRow[]>(data.requests);
let busyId = $state<string | null>(null);
let denyId = $state<string | null>(null);
let denyReason = $state("");

function parseDomains(): string[] {
  return domainsText
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter((d) => d.length > 0);
}

async function saveSettings(event: SubmitEvent) {
  event.preventDefault();
  saving = true;
  const payload: Record<string, unknown> = { signupMode: config.signupMode };
  if (config.signupMode === "domain_restricted") {
    payload.allowedDomains = parseDomains();
  }
  try {
    const updated = await api<SignupConfig>("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    config = { ...updated };
    domainsText = updated.allowedDomains.join("\n");
    toastSuccess("Sign-up settings saved.");
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : "Could not save settings.");
  } finally {
    saving = false;
  }
}

async function savePayments() {
  saving = true;
  try {
    const updated = await api<SignupConfig>("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({ paymentsEnabled: config.paymentsEnabled }),
    });
    config = { ...updated };
    toastSuccess(`Payments ${updated.paymentsEnabled ? "enabled" : "disabled"}.`);
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : "Could not update payments.");
  } finally {
    saving = false;
  }
}

async function refreshRequests() {
  const res = await api<{ items: SignupRequestRow[] }>(
    "/api/admin/signup-requests?status=pending",
  );
  requests = res.items;
}

async function approve(req: SignupRequestRow) {
  busyId = req.id;
  try {
    await api(`/api/admin/signup-requests/${req.id}/approve`, { method: "POST" });
    await refreshRequests();
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : "Could not approve the request.");
  } finally {
    busyId = null;
  }
}

async function confirmDeny(req: SignupRequestRow) {
  busyId = req.id;
  try {
    await api(`/api/admin/signup-requests/${req.id}/deny`, {
      method: "POST",
      body: JSON.stringify({ reason: denyReason.trim() || undefined }),
    });
    denyId = null;
    denyReason = "";
    await refreshRequests();
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : "Could not deny the request.");
  } finally {
    busyId = null;
  }
}

function openDeny(req: SignupRequestRow) {
  denyId = req.id;
  denyReason = "";
}

function cancelDeny() {
  denyId = null;
  denyReason = "";
}

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
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
</script>

<svelte:head>
  <title>Sign-ups — Admin — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="Sign-up policy"
  >
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Sign-up policy</h2>
    <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
      Control who can create an account on this instance.
    </p>

    <form class="mt-4 flex flex-col gap-5" onsubmit={saveSettings} novalidate>
      <fieldset class="flex flex-col gap-2">
        <legend class="text-sm font-medium">Mode</legend>
        <div class="grid gap-2 sm:grid-cols-2">
          {#each MODES as mode (mode)}
            <label
              class={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors ${
                config.signupMode === mode
                  ? "border-brand-500 bg-brand-50/50 dark:bg-brand-950/30"
                  : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              }`}
            >
              <input
                type="radio"
                name="mode"
                value={mode}
                bind:group={config.signupMode}
                class="mt-0.5"
              />
              <span>
                <span class="font-medium">{SIGNUP_MODE_LABEL[mode]}</span>
                <span class="mt-0.5 block text-xs text-neutral-500">
                  {#if mode === "open"}
                    Anyone can sign up freely.
                  {:else if mode === "domain_restricted"}
                    Only emails from approved domains.
                  {:else if mode === "approval"}
                    Requests queue for admin review; denied accounts are notified.
                  {:else}
                    New sign-ups blocked entirely.
                  {/if}
                </span>
              </span>
            </label>
          {/each}
        </div>
      </fieldset>

      {#if config.signupMode === "domain_restricted"}
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Allowed domains</span>
          <span class="text-xs text-neutral-500">
            One per line (or comma-separated). Example: <code>acme.com</code>
          </span>
          <textarea
            bind:value={domainsText}
            rows="4"
            placeholder="acme.com&#10;partners.acme.com"
            class="input px-3 py-2 font-mono text-xs"
          ></textarea>
        </label>
      {/if}

      <div>
        <button
          type="submit"
          disabled={saving}
          class="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save sign-up policy"}
        </button>
      </div>
    </form>
  </section>

  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="Payment availability"
  >
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Payments</h2>
    {#if !config.mollieConfigured}
      <p
        role="status"
        class="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      >
        Billing is auto-disabled because Mollie is not configured. Set
        <code>MOLLIE_API_KEY</code>, <code>MOLLIE_REDIRECT_URL</code>, and
        <code>MOLLIE_WEBHOOK_URL</code> in the server environment to enable paid plans.
      </p>
    {/if}
    <div class="mt-4 flex flex-wrap items-center justify-between gap-4">
      <div>
        <p class="font-medium">
          Paid plan checkout is currently
          <span class="font-semibold">
            {config.paymentsEnabled && config.mollieConfigured !== false
              ? "enabled"
              : "disabled"}
          </span>.
        </p>
        <p class="mt-1 max-w-xl text-sm text-neutral-600 dark:text-neutral-400">
          Disabling payments hides the upgrade/checkout flow. Existing subscriptions are
          unaffected; teams stay on their current plan.
        </p>
      </div>
      <label class="inline-flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" bind:checked={config.paymentsEnabled} onchange={savePayments} />
        Enable payments
      </label>
    </div>
  </section>

  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="Pending sign-up requests"
  >
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Pending sign-up requests
      </h2>
      <span class="text-xs text-neutral-500">{requests.length} waiting</span>
    </div>

    {#if requests.length === 0}
      <p class="mt-4 text-sm text-neutral-500">No pending requests. New requests will appear here.</p>
    {:else}
      <div class="mt-4 overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr
              class="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800"
            >
              <th scope="col" class="py-2 pr-4 font-medium">Applicant</th>
              <th scope="col" class="py-2 pr-4 font-medium">Requested</th>
              <th scope="col" class="py-2 pr-4 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-200 dark:divide-neutral-800">
            {#each requests as req (req.id)}
              <tr>
                <td class="py-3 pr-4">
                  <p class="font-medium">{req.name || "—"}</p>
                  <p class="text-xs text-neutral-500">{req.email}</p>
                </td>
                <td class="py-3 pr-4 text-neutral-500">{formatDate(req.createdAt)}</td>
                <td class="py-3 pr-4 text-right">
                  {#if denyId === req.id}
                    <div class="flex flex-col items-end gap-2">
                      <input
                        type="text"
                        bind:value={denyReason}
                        placeholder="Reason (optional, shown to the user)"
                        class="input w-72 px-2 py-1 text-xs"
                      />
                      <div class="flex gap-2">
                        <button
                          type="button"
                          onclick={cancelDeny}
                          class="rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onclick={() => confirmDeny(req)}
                          disabled={busyId === req.id}
                          class="rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:hover:bg-red-950"
                        >
                          Confirm deny
                        </button>
                      </div>
                    </div>
                  {:else}
                    <div class="flex justify-end gap-2">
                      <button
                        type="button"
                        onclick={() => approve(req)}
                        disabled={busyId === req.id}
                        class="rounded-md bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-50"
                      >
                        {busyId === req.id ? "…" : "Approve"}
                      </button>
                      <button
                        type="button"
                        onclick={() => openDeny(req)}
                        disabled={busyId === req.id}
                        class="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-600 bg-white hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:bg-neutral-900 dark:hover:bg-red-950"
                      >
                        Deny
                      </button>
                    </div>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</section>
