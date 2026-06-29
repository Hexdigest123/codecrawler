<script lang="ts">
import { goto } from "$app/navigation";
import { ApiError, api } from "$lib/api";
import { PLAN_LABEL, type Member, type MemberRole, type PlanId } from "$lib/types";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const MEMBER_CAP: Record<PlanId, number | null> = {
  free: 5,
  plus: 5,
  pro: null,
};

let membersOverride = $state<Member[] | null>(null);
const members = $derived<Member[]>(membersOverride ?? data.members ?? []);

const plan = $derived<PlanId>((data.team?.plan as PlanId) ?? "free");
const myRole = $derived(data.team?.role ?? "member");
const canManage = $derived(myRole === "owner" || myRole === "admin");
const cap = $derived<number | null>(MEMBER_CAP[plan] ?? null);
const currentUserId = $derived(data.currentUserId);

let inviteEmail = $state("");
let inviteRole = $state<"member" | "admin">("member");
let inviting = $state(false);
let inviteError = $state<string | null>(null);
let inviteInfo = $state<string | null>(null);

let busyUserId = $state<string | null>(null);
let actionError = $state<string | null>(null);

const ROLE_BADGE_STYLES: Record<MemberRole, string> = {
  owner: "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
  admin: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  member: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
};

function roleLabel(role: MemberRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function isSelf(member: Member): boolean {
  return member.userId === currentUserId;
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

async function refreshMembers() {
  membersOverride = await api<Member[]>(`/api/teams/${data.teamId}/members`);
}

async function sendInvite(event: SubmitEvent) {
  event.preventDefault();
  const email = inviteEmail.trim();
  if (email.length === 0) return;
  inviting = true;
  inviteError = null;
  inviteInfo = null;
  try {
    await api<{ invitationId: string }>(`/api/teams/${data.teamId}/invite`, {
      method: "POST",
      body: JSON.stringify({ email, role: inviteRole }),
    });
    inviteInfo = `Invitation sent to ${email}. It is pending until they accept.`;
    inviteEmail = "";
    inviteRole = "member";
  } catch (err) {
    if (err instanceof ApiError && err.code === "cap_reached") {
      inviteError =
        "Your team has reached its member cap. Upgrade the plan to add more members.";
    } else {
      inviteError = err instanceof ApiError ? err.message : "Could not send the invitation.";
    }
  } finally {
    inviting = false;
  }
}

async function changeRole(member: Member, newRole: MemberRole) {
  if (newRole === member.role || busyUserId) return;
  busyUserId = member.userId;
  actionError = null;
  try {
    await api(`/api/teams/${data.teamId}/members/${member.userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: newRole }),
    });
    await refreshMembers();
  } catch (err) {
    actionError = err instanceof ApiError ? err.message : "Could not update the role.";
  } finally {
    busyUserId = null;
  }
}

async function removeMember(member: Member) {
  if (!confirm(`Remove ${member.name || member.email} from the team?`)) return;
  busyUserId = member.userId;
  actionError = null;
  try {
    await api(`/api/teams/${data.teamId}/members/${member.userId}`, { method: "DELETE" });
    await refreshMembers();
  } catch (err) {
    actionError = err instanceof ApiError ? err.message : "Could not remove the member.";
  } finally {
    busyUserId = null;
  }
}

async function leaveTeam() {
  if (
    !confirm(
      "Leave this team? You will lose access to its projects and settings.",
    )
  )
    return;
  busyUserId = currentUserId;
  actionError = null;
  try {
    await api(`/api/teams/${data.teamId}/members/${currentUserId}/leave`, {
      method: "POST",
    });
    await goto("/dashboard");
  } catch (err) {
    actionError = err instanceof ApiError ? err.message : "Could not leave the team.";
    busyUserId = null;
  }
}

let deletingTeam = $state(false);

const isOwner = $derived(myRole === "owner");

async function deleteTeam() {
  const name = data.team?.organization?.name ?? "this team";
  const typed = prompt(
    `Delete "${name}" permanently?\n\nThis removes all projects, reviews, API keys, members and billing data for this team. This cannot be undone.\n\nType the team name to confirm:`,
  );
  if (typed === null) return;
  if (typed.trim().toLowerCase() !== name.trim().toLowerCase()) {
    actionError = "Team name did not match. Deletion cancelled.";
    return;
  }
  deletingTeam = true;
  actionError = null;
  try {
    await api(`/api/teams/${data.teamId}`, { method: "DELETE" });
    await goto("/dashboard");
  } catch (err) {
    actionError = err instanceof ApiError ? err.message : "Could not delete the team.";
    deletingTeam = false;
  }
}
</script>

<svelte:head>
  <title>Members — {data.team?.organization?.name ?? "Team"} — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <header class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <div class="flex items-center gap-3">
        <h1 class="text-2xl font-semibold tracking-tight">Members</h1>
        <span
          class="rounded-full border border-neutral-300 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-700"
        >
          {data.team ? PLAN_LABEL[data.team.plan] : "—"}
        </span>
      </div>
      <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Your role: <span class="font-medium">{myRole}</span> ·
        {#if cap === null}
          {PLAN_LABEL[plan]}: unlimited members.
        {:else}
          {PLAN_LABEL[plan]}: up to {cap} members ({members.length}/{cap}).
        {/if}
      </p>
    </div>
  </header>

  {#if canManage}
    <section
      class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
      aria-label="Invite a member"
    >
      <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Invite a member
      </h2>
      <form
        class="mt-4 grid gap-4 sm:grid-cols-[1fr_auto_auto]"
        onsubmit={sendInvite}
        novalidate
      >
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Email</span>
          <input
            type="email"
            required
            autocomplete="email"
            bind:value={inviteEmail}
            placeholder="teammate@example.com"
            class="input px-3 py-2"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Role</span>
          <select
            bind:value={inviteRole}
            class="input px-3 py-2"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <div class="flex items-end">
          <button
            type="submit"
            disabled={inviting || inviteEmail.trim().length === 0}
            class="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {inviting ? "Sending…" : "Send invite"}
          </button>
        </div>
      </form>
      {#if inviteInfo}
        <p
          role="status"
          class="mt-3 text-sm text-green-700 dark:text-green-300"
        >
          {inviteInfo}
        </p>
      {/if}
      {#if inviteError}
        <p role="alert" class="mt-3 text-sm text-red-600 dark:text-red-400">
          {inviteError}
        </p>
      {/if}
    </section>
  {/if}

  {#if actionError}
    <p
      role="alert"
      class="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
    >
      {actionError}
    </p>
  {/if}

  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="Team members"
  >
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
      Members
    </h2>
    {#if members.length === 0}
      <p class="mt-4 text-sm text-neutral-500">No members found.</p>
    {:else}
      <div class="mt-4 overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr
              class="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800"
            >
              <th scope="col" class="py-2 pr-4 font-medium">Member</th>
              <th scope="col" class="py-2 pr-4 font-medium">Role</th>
              <th scope="col" class="py-2 pr-4 font-medium">Joined</th>
              <th scope="col" class="py-2 pr-4 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-200 dark:divide-neutral-800">
            {#each members as member (member.userId)}
              <tr>
                <td class="py-3 pr-4">
                  <p class="font-medium">{member.name || "—"}</p>
                  <p class="text-xs text-neutral-500">{member.email}</p>
                </td>
                <td class="py-3 pr-4">
                  {#if member.role === "owner"}
                    <span
                      class={`rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_BADGE_STYLES.owner}`}
                    >
                      Owner
                    </span>
                  {:else if canManage && !isSelf(member)}
                    <select
                      value={member.role}
                      disabled={busyUserId === member.userId}
                      onchange={(e) =>
                        changeRole(member, e.currentTarget.value as MemberRole)}
                      aria-label={`Role for ${member.name || member.email}`}
                      class="input px-2 py-1 text-xs disabled:opacity-50"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                  {:else}
                    <span
                      class={`rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_BADGE_STYLES[member.role]}`}
                    >
                      {roleLabel(member.role)}
                    </span>
                  {/if}
                </td>
                <td class="py-3 pr-4 text-neutral-500">{formatDate(member.createdAt)}</td>
                <td class="py-3 pr-4 text-right">
                  <div class="flex justify-end gap-2">
                    {#if isSelf(member)}
                      <button
                        type="button"
                        onclick={leaveTeam}
                        disabled={busyUserId === member.userId}
                        class="rounded-md border border-red-300 px-3 py-1 text-sm font-medium text-red-600 bg-white hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:bg-neutral-900 dark:hover:bg-red-950"
                      >
                        {busyUserId === member.userId ? "…" : "Leave team"}
                      </button>
                    {:else if canManage && member.role !== "owner"}
                      <button
                        type="button"
                        onclick={() => removeMember(member)}
                        disabled={busyUserId === member.userId}
                        class="rounded-md border border-red-300 px-3 py-1 text-sm font-medium text-red-600 bg-white hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:bg-neutral-900 dark:hover:bg-red-950"
                      >
                        {busyUserId === member.userId ? "…" : "Remove"}
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

  {#if isOwner}
    <section
      class="rounded-xl border border-red-300 p-5 dark:border-red-900"
      aria-label="Danger zone"
    >
      <h2 class="text-sm font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
        Danger zone
      </h2>
      <div class="mt-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p class="font-medium">Delete this team</p>
          <p class="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
            Permanently removes the team along with its projects, reviews, API keys,
            VCS connections and billing subscription. This cannot be undone.
          </p>
        </div>
        <button
          type="button"
          onclick={deleteTeam}
          disabled={deletingTeam}
          class="btn btn-danger px-4 py-2 text-sm"
        >
          {deletingTeam ? "Deleting…" : "Delete team"}
        </button>
      </div>
    </section>
  {/if}
</section>
