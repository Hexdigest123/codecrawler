<script lang="ts">
  import { authClient } from "@codecrawler/auth/client";
  import { goto } from "$app/navigation";
  import Brand from "$lib/components/Brand.svelte";
  import { toastError } from "$lib/toast.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  let code = $state("");
  let loading = $state(false);
  let trustDevice = $state(true);

  let disabled = $derived(loading || code.trim().length < 4);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (disabled) return;
    loading = true;
    const { error: err } = await authClient.twoFactor.verifyTotp({
      code: code.trim(),
      trustDevice,
    });
    loading = false;
    if (err) {
      toastError(err.message ?? "Invalid code. Try again.");
      return;
    }
    await goto("/dashboard");
  }
</script>

<svelte:head>
  <title>Two-factor verification — CodeCrawler</title>
</svelte:head>

<section class="mx-auto max-w-md py-10">
  <Brand imgClass="h-14" class="mb-6" />
  <h1 class="text-2xl font-semibold tracking-tight">Enter your verification code</h1>
  <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
    Open your authenticator app
    {#if data.email}<span>for </span><span class="font-medium">{data.email}</span>{/if}
    and enter the 6-digit code.
  </p>

  <form class="mt-6 flex flex-col gap-4" onsubmit={submit} novalidate>
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Authentication code</span>
      <input
        type="text"
        inputmode="numeric"
        autocomplete="one-time-code"
        required
        bind:value={code}
        class="input px-3 py-2 font-mono tracking-[0.3em]"
        placeholder="123456"
        maxlength="10"
      />
    </label>

    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" bind:checked={trustDevice} class="size-4" />
      <span>Trust this device for 30 days</span>
    </label>

    <button
      type="submit"
      {disabled}
      class="mt-2 rounded-md bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? "Verifying…" : "Verify and sign in"}
    </button>
  </form>

  <p class="mt-6 text-sm text-neutral-600 dark:text-neutral-400">
    Lost access to your authenticator? Use a saved backup code, or contact your
    workspace admin.
    <a href="/sign-in" class="ml-1 font-medium text-brand-600 hover:underline dark:text-brand-500">
      Back to sign in
    </a>
  </p>
</section>
