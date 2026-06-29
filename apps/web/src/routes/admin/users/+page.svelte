<script lang="ts">
import { ApiError, api } from "$lib/api";
import { toastError } from "$lib/toast.svelte";
import type { AdminUser } from "$lib/types";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// svelte-ignore state_referenced_locally
let users = $state<AdminUser[]>(data.users);
let query = $state("");
let busyId = $state<string | null>(null);
let denyTarget = $state<AdminUser | null>(null);
let denyReason = $state("");

const filtered = $derived.by(() => {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return users;
  return users.filter(
    (u) => u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q),
  );
});

const STATUS_BADGE: Record<string, string> = {
  active: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
  pending: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  denied: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
};

async function refresh() {
  const res = await api<{ items: AdminUser[] }>("/api/admin/users");
  users = res.items;
}

async function setRole(user: AdminUser, role: "admin" | "user") {
  if (role === user.role || busyId) return;
  busyId = user.id;
  try {
    await api(`/api/admin/users/${user.id}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
    await refresh();
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : "Could not update the role.");
  } finally {
    busyId = null;
  }
}

function openDisable(user: AdminUser) {
  denyTarget = user;
  denyReason = "";
}

function cancelDisable() {
  denyTarget = null;
  denyReason = "";
}

async function confirmDisable() {
  if (!denyTarget) return;
  busyId = denyTarget.id;
  try {
    await api(`/api/admin/users/${denyTarget.id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "denied", reason: denyReason.trim() || undefined }),
    });
    denyTarget = null;
    denyReason = "";
    await refresh();
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : "Could not disable the account.");
  } finally {
    busyId = null;
  }
}

async function enable(user: AdminUser) {
  busyId = user.id;
  try {
    await api(`/api/admin/users/${user.id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });
    await refresh();
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : "Could not re-enable the account.");
  } finally {
    busyId = null;
  }
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
</script>

<svelte:head>
  <title>Users — Admin — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-6">
  <header class="flex flex-wrap items-end justify-between gap-4">
    <div>
      <h2 class="text-xl font-semibold tracking-tight">Users</h2>
      <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Promote administrators and enable or disable accounts. The last administrator
        cannot be removed.
      </p>
    </div>
    <label class="block w-full max-w-xs">
      <span class="sr-only">Search users</span>
      <input
        type="search"
        bind:value={query}
        placeholder="Search by name or email…"
        class="input w-full px-3 py-1.5 text-sm"
      />
    </label>
  </header>

  {#if denyTarget}
    <div
      class="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950"
      role="dialog"
      aria-label="Disable account"
    >
      <p class="text-sm font-medium text-red-700 dark:text-red-300">
        Disable {denyTarget.email}?
      </p>
      <p class="mt-1 text-xs text-red-700/80 dark:text-red-300/80">
        The user will be signed out and cannot sign in again until re-enabled.
      </p>
      <input
        type="text"
        bind:value={denyReason}
        placeholder="Reason (optional, shown to the user)"
        class="input mt-3 w-full px-3 py-1.5 text-sm"
      />
      <div class="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onclick={cancelDisable}
          class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={confirmDisable}
          disabled={busyId === denyTarget.id}
          class="rounded-md border border-red-400 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-100 disabled:opacity-50 dark:border-red-800 dark:bg-neutral-900 dark:hover:bg-red-950"
        >
          {busyId === denyTarget.id ? "Disabling…" : "Disable account"}
        </button>
      </div>
    </div>
  {/if}

  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="All users"
  >
    {#if filtered.length === 0}
      <p class="text-sm text-neutral-500">No users found.</p>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr
              class="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800"
            >
              <th scope="col" class="py-2 pr-4 font-medium">User</th>
              <th scope="col" class="py-2 pr-4 font-medium">Status</th>
              <th scope="col" class="py-2 pr-4 font-medium">Role</th>
              <th scope="col" class="py-2 pr-4 font-medium">Joined</th>
              <th scope="col" class="py-2 pr-4 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-200 dark:divide-neutral-800">
            {#each filtered as user (user.id)}
              <tr>
                <td class="py-3 pr-4">
                  <p class="font-medium">{user.name || "—"}</p>
                  <p class="text-xs text-neutral-500">{user.email}</p>
                </td>
                <td class="py-3 pr-4">
                  <span
                    class={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[user.status] ?? STATUS_BADGE.active}`}
                  >
                    {user.status}
                  </span>
                </td>
                <td class="py-3 pr-4">
                  {#if user.role === "admin"}
                    <span
                      class="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                    >
                      Admin
                    </span>
                  {:else}
                    <button
                      type="button"
                      onclick={() => setRole(user, "admin")}
                      disabled={busyId === user.id}
                      class="rounded-md border border-neutral-300 px-2 py-0.5 text-xs font-medium hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                    >
                      Make admin
                    </button>
                  {/if}
                </td>
                <td class="py-3 pr-4 text-neutral-500">{formatDate(user.createdAt)}</td>
                <td class="py-3 pr-4 text-right">
                  <div class="flex justify-end gap-2">
                    {#if user.role === "admin"}
                      <button
                        type="button"
                        onclick={() => setRole(user, "user")}
                        disabled={busyId === user.id}
                        class="rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                      >
                        {busyId === user.id ? "…" : "Revoke admin"}
                      </button>
                    {/if}
                    {#if user.status === "active"}
                      <button
                        type="button"
                        onclick={() => openDisable(user)}
                        disabled={busyId === user.id}
                        class="rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-600 bg-white hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:bg-neutral-900 dark:hover:bg-red-950"
                      >
                        Disable
                      </button>
                    {:else if user.status === "denied"}
                      <button
                        type="button"
                        onclick={() => enable(user)}
                        disabled={busyId === user.id}
                        class="rounded-md border border-green-300 px-2 py-1 text-xs font-medium text-green-700 bg-white hover:bg-green-50 disabled:opacity-50 dark:border-green-900 dark:bg-neutral-900 dark:hover:bg-green-950"
                      >
                        Re-enable
                      </button>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</section>
