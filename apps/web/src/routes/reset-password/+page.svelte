<script lang="ts">
  import { authClient } from "@codecrawler/auth/client";
  import { goto } from "$app/navigation";
  import Brand from "$lib/components/Brand.svelte";
  import { toastError, toastSuccess } from "$lib/toast.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  let newPassword = $state("");
  let confirmPassword = $state("");
  let loading = $state(false);

  const tokenInvalid = $derived(data.error === "INVALID_TOKEN" || data.token.length === 0);
  const mismatch = $derived(
    confirmPassword.length > 0 && newPassword !== confirmPassword,
  );
  let disabled = $derived(
    loading || tokenInvalid || newPassword.length < 8 || mismatch,
  );

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (disabled) return;
    loading = true;
    const { error: err } = await authClient.resetPassword({
      newPassword,
      token: data.token,
    });
    loading = false;
    if (err) {
      toastError(err.message ?? "Could not reset password. The link may have expired.");
      return;
    }
    toastSuccess("Password updated. You can sign in now.");
    await goto("/sign-in");
  }
</script>

<svelte:head>
  <title>Set a new password — CodeCrawler</title>
</svelte:head>

<section class="mx-auto max-w-md py-10">
  <Brand imgClass="h-14" class="mb-6" />
  <h1 class="text-2xl font-semibold tracking-tight">Set a new password</h1>

  {#if tokenInvalid}
    <div
      class="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      role="status"
    >
      This password reset link is invalid or has expired. Request a new link to
      continue.
    </div>
    <a
      href="/forgot-password"
      class="mt-6 inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500"
    >
      Request a new link
    </a>
  {:else}
    <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
      Choose a new password for your account.
    </p>
    <form class="mt-6 flex flex-col gap-4" onsubmit={submit} novalidate>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">New password</span>
        <input
          type="password"
          name="password"
          autocomplete="new-password"
          required
          minlength="8"
          bind:value={newPassword}
          class="input px-3 py-2"
          placeholder="At least 8 characters"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Confirm new password</span>
        <input
          type="password"
          name="confirm"
          autocomplete="new-password"
          required
          minlength="8"
          bind:value={confirmPassword}
          class="input px-3 py-2"
          placeholder="Repeat the new password"
        />
        {#if mismatch}
          <span class="text-xs text-red-600 dark:text-red-400">Passwords do not match.</span>
        {/if}
      </label>

      <button
        type="submit"
        {disabled}
        class="mt-2 rounded-md bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Saving…" : "Reset password"}
      </button>
    </form>
  {/if}
</section>
