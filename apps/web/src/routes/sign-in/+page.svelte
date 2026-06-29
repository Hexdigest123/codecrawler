<script lang="ts">
import { authClient } from "@codecrawler/auth/client";
import { goto } from "$app/navigation";
import Brand from "$lib/components/Brand.svelte";

let email = $state("");
let password = $state("");
let error = $state<string | null>(null);
let loading = $state(false);

let disabled = $derived(loading || email.length === 0 || password.length === 0);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (disabled) return;
  error = null;
  loading = true;
  const { error: err } = await authClient.signIn.email({ email, password });
  loading = false;
  if (err) {
    error = err.message ?? "Sign in failed.";
    return;
  }
  await goto("/dashboard");
}
</script>

<svelte:head>
  <title>Sign in — CodeCrawler</title>
</svelte:head>

<section class="mx-auto max-w-md py-10">
  <Brand imgClass="h-14" class="mb-6" />
  <h1 class="text-2xl font-semibold tracking-tight">Sign in</h1>
  <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
    Welcome back. Sign in to your CodeCrawler account.
  </p>

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

    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Password</span>
      <input
        type="password"
        name="password"
        autocomplete="current-password"
        required
        bind:value={password}
        class="input px-3 py-2"
        placeholder="••••••••"
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
      {loading ? "Signing in…" : "Sign in"}
    </button>
  </form>

  <div class="mt-6 flex items-center gap-3">
    <span class="h-px flex-1 bg-neutral-200 dark:bg-neutral-800"></span>
    <span class="text-xs uppercase tracking-wide text-neutral-400">or</span>
    <span class="h-px flex-1 bg-neutral-200 dark:bg-neutral-800"></span>
  </div>

  <a
    href="/sso"
    class="mt-4 block rounded-md border border-neutral-300 px-4 py-2 text-center text-sm font-medium bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
  >
    Sign in with SSO
  </a>

  <p class="mt-6 text-sm text-neutral-600 dark:text-neutral-400">
    No account?
    <a href="/sign-up" class="font-medium text-brand-600 hover:underline dark:text-brand-500">
      Sign up
    </a>
  </p>
</section>
