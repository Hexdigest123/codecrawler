<script lang="ts">
  import { authClient } from "@codecrawler/auth/client";
  import Brand from "$lib/components/Brand.svelte";
  import { toastError, toastSuccess } from "$lib/toast.svelte";

  let email = $state("");
  let loading = $state(false);
  let submitted = $state(false);

  let disabled = $derived(loading || email.trim().length === 0);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (disabled) return;
    loading = true;
    // Absolute redirect so Better Auth builds a fully-qualified reset link in
    // the email (the API origin differs from the web origin in dev/prod).
    const redirectTo = `${window.location.origin}/reset-password`;
    const { error: err } = await authClient.requestPasswordReset({
      email: email.trim(),
      redirectTo,
    });
    loading = false;
    if (err) {
      toastError(err.message ?? "Could not send reset email.");
      return;
    }
    // Better Auth always responds 200 (even for unknown emails) to prevent
    // user enumeration, so treat every success identically.
    submitted = true;
    toastSuccess("If an account exists, a reset link is on its way.");
  }
</script>

<svelte:head>
  <title>Forgot password — CodeCrawler</title>
</svelte:head>

<section class="mx-auto max-w-md py-10">
  <Brand imgClass="h-14" class="mb-6" />
  <h1 class="text-2xl font-semibold tracking-tight">Reset your password</h1>
  <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
    Enter your email and we'll send you a link to set a new password.
  </p>

  {#if submitted}
    <div
      class="mt-6 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      role="status"
    >
      Check your inbox. If an account exists for <span class="font-medium">{email}</span>,
      you'll receive a reset link shortly. The link expires in one hour.
    </div>
  {:else}
    <form class="mt-6 flex flex-col gap-4" onsubmit={submit} novalidate>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Email</span>
        <input
          type="email"
          name="email"
          autocomplete="email"
          required
          bind:value={email}
          class="input px-3 py-2"
          placeholder="you@example.com"
        />
      </label>

      <button
        type="submit"
        {disabled}
        class="mt-2 rounded-md bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Sending…" : "Send reset link"}
      </button>
    </form>
  {/if}

  <p class="mt-6 text-sm text-neutral-600 dark:text-neutral-400">
    Remembered it?
    <a href="/sign-in" class="font-medium text-brand-600 hover:underline dark:text-brand-500">
      Back to sign in
    </a>
  </p>
</section>
