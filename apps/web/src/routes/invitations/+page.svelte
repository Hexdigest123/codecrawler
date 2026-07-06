<script lang="ts">
  import { goto } from "$app/navigation";
  import { ApiError, api } from "$lib/api";
  import { confirm } from "$lib/confirm.svelte";
  import { toastError } from "$lib/toast.svelte";
  import type { Invitation, MemberRole } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  let invitationsOverride = $state<Invitation[] | null>(null);
  const invitations = $derived<Invitation[]>(
    invitationsOverride ?? data.invitations ?? [],
  );

  let busyId = $state<string | null>(null);

  function roleLabel(role: MemberRole): string {
    return role.charAt(0).toUpperCase() + role.slice(1);
  }

  function formatDate(iso?: string): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  async function accept(inv: Invitation) {
    busyId = inv.id;
    try {
      const { organizationId } = await api<{ organizationId: string }>(
        `/api/invitations/${inv.id}/accept`,
        { method: "POST" },
      );
      await goto(`/teams/${organizationId}`);
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : "Could not accept the invitation.");
      busyId = null;
    }
  }

  async function decline(inv: Invitation) {
    const ok = await confirm({
      title: "Decline invitation",
      message: `Decline the invitation to ${inv.organizationName ?? "this team"}?`,
      confirmLabel: "Decline",
      tone: "default",
    });
    if (!ok) return;
    busyId = inv.id;
    try {
      await api<{ ok: boolean }>(`/api/invitations/${inv.id}/decline`, {
        method: "POST",
      });
      invitationsOverride = await api<Invitation[]>("/api/me/invitations");
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : "Could not decline the invitation.");
    } finally {
      busyId = null;
    }
  }
</script>

<svelte:head>
  <title>Pending invitations — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <header>
    <h1 class="text-2xl font-semibold tracking-tight">Pending invitations</h1>
    <p class="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
      Teams you have been invited to join. Accept to become a member, or decline to dismiss.
    </p>
  </header>

  {#if invitations.length === 0}
    <div
      class="rounded-xl border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700"
    >
      <p class="text-sm text-neutral-500">No pending invitations.</p>
    </div>
  {:else}
    <ul class="flex flex-col gap-3">
      {#each invitations as inv (inv.id)}
        <li
          class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <div class="min-w-0">
            <p class="font-medium">{inv.organizationName ?? "Team"}</p>
            <p class="mt-0.5 text-xs text-neutral-500">
              Role: {roleLabel(inv.role)} · Expires {formatDate(inv.expiresAt)}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              onclick={() => accept(inv)}
              disabled={busyId === inv.id}
              class="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-50"
            >
              {busyId === inv.id ? "…" : "Accept"}
            </button>
            <button
              type="button"
              onclick={() => decline(inv)}
              disabled={busyId === inv.id}
              class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium bg-white hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
            >
              Decline
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
