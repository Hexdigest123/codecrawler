<script lang="ts">
import { authClient } from "@codecrawler/auth/client";
import { ApiError, api } from "$lib/api";
import { toastError, toastSuccess } from "$lib/toast.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

let newEmail = $state("");
let emailBusy = $state(false);

let currentPassword = $state("");
let newPassword = $state("");
let passwordBusy = $state(false);

const emailDisabled = $derived(emailBusy || newEmail.trim().length === 0);
const passwordDisabled = $derived(
  passwordBusy || currentPassword.length === 0 || newPassword.length < 8,
);

async function changeEmail(event: SubmitEvent) {
  event.preventDefault();
  if (emailDisabled) return;
  emailBusy = true;
  try {
    await api<{ ok: boolean }>("/api/me/email", {
      method: "POST",
      body: JSON.stringify({ newEmail: newEmail.trim() }),
    });
    toastSuccess(`Verification sent to ${newEmail.trim()}. The change takes effect once confirmed.`);
    newEmail = "";
    await authClient.getSession({ query: { disableCookieCache: true } });
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : "Could not change email.");
  } finally {
    emailBusy = false;
  }
}

async function changePassword(event: SubmitEvent) {
  event.preventDefault();
  if (passwordDisabled) return;
  passwordBusy = true;
  try {
    await api<{ ok: boolean }>("/api/me/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    toastSuccess("Password updated.");
    currentPassword = "";
    newPassword = "";
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : "Could not change password.");
  } finally {
    passwordBusy = false;
  }
}

function inputClass() {
  return "input px-3 py-2";
}
</script>

<svelte:head>
  <title>Account — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-10">
  <header>
    <h1 class="text-2xl font-semibold tracking-tight">Account</h1>
    <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
      Manage your sign-in details.
    </p>
  </header>

  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="Email address"
  >
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Email address</h2>
    <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
      Current: <span class="font-medium">{data.currentEmail}</span>
    </p>
    <form class="mt-4 flex flex-col gap-3 sm:max-w-md" onsubmit={changeEmail} novalidate>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">New email</span>
        <input
          type="email"
          required
          autocomplete="email"
          bind:value={newEmail}
          placeholder="you@example.com"
          class={inputClass()}
        />
      </label>
      <button
        type="submit"
        disabled={emailDisabled}
        class="self-start rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {emailBusy ? "Saving…" : "Change email"}
      </button>
    </form>
  </section>

  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="Password"
  >
    <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Password</h2>
    <form class="mt-4 flex flex-col gap-3 sm:max-w-md" onsubmit={changePassword} novalidate>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Current password</span>
        <input
          type="password"
          required
          autocomplete="current-password"
          bind:value={currentPassword}
          class={inputClass()}
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">New password</span>
        <input
          type="password"
          required
          minlength="8"
          autocomplete="new-password"
          bind:value={newPassword}
          placeholder="At least 8 characters"
          class={inputClass()}
        />
      </label>
      <button
        type="submit"
        disabled={passwordDisabled}
        class="self-start rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {passwordBusy ? "Saving…" : "Change password"}
      </button>
    </form>
  </section>
</section>
