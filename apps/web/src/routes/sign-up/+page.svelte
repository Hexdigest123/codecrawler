<script lang="ts">
import { authClient } from "@codecrawler/auth/client";
import { goto } from "$app/navigation";
import Brand from "$lib/components/Brand.svelte";

let name = $state("");
let email = $state("");
let password = $state("");
let error = $state<string | null>(null);
let loading = $state(false);

let disabled = $derived(loading || name.length === 0 || email.length === 0 || password.length < 8);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (disabled) return;
  error = null;
  loading = true;
  const { error: err } = await authClient.signUp.email({
    email,
    password,
    name,
  });
  loading = false;
  if (err) {
    error = err.message ?? "Sign up failed.";
    return;
  }
  await goto("/dashboard");
}
</script>

<svelte:head>
  <title>Sign up — CodeCrawler</title>
</svelte:head>

<section class="mx-auto max-w-md py-10">
  <Brand imgClass="h-14" class="mb-6" />
  <h1 class="text-2xl font-semibold tracking-tight">Create your account</h1>
  <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
    Start reviewing PRs in minutes. No credit card required.
  </p>

  <form class="mt-6 flex flex-col gap-4" onsubmit={submit} novalidate>
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Name</span>
      <input
        type="text"
        name="name"
        autocomplete="name"
        required
        bind:value={name}
        class="input px-3 py-2"
        placeholder="Ada Lovelace"
      />
    </label>

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

    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Password</span>
      <input
        type="password"
        name="password"
        autocomplete="new-password"
        required
        minlength="8"
        bind:value={password}
        class="input px-3 py-2"
        placeholder="At least 8 characters"
      />
    </label>

    {#if error}
      <p role="alert" class="text-sm text-red-600 dark:text-red-400">{error}</p>
    {/if}

    <button
      type="submit"
      {disabled}
      class="mt-2 rounded-md bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? "Creating account…" : "Sign up"}
    </button>
  </form>

  <p class="mt-6 text-sm text-neutral-600 dark:text-neutral-400">
    Already have an account?
    <a href="/sign-in" class="font-medium text-brand-600 hover:underline dark:text-brand-500">
      Sign in
    </a>
  </p>
</section>
