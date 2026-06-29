<script lang="ts">
  import { ApiError, api } from "$lib/api";
  import { toastError } from "$lib/toast.svelte";
  import type { SsoProvider } from "$lib/types";
  import { goto } from "$app/navigation";

  interface ResolveResult {
    providerId: SsoProvider;
    organizationId: string;
  }

  let email = $state("");
  let loading = $state(false);
  let result = $state<ResolveResult | null>(null);
  let notFound = $state(false);

  const disabled = $derived(loading || email.trim().length === 0);

  function providerLabel(p: SsoProvider): string {
    return p === "saml" ? "SAML 2.0" : "OIDC";
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (disabled) return;
    result = null;
    notFound = false;
    loading = true;
    try {
      const resolved = await api<ResolveResult | null>("/api/sso/resolve", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      if (resolved) {
        result = resolved;
      } else {
        notFound = true;
      }
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : "Could not resolve SSO.");
    } finally {
      loading = false;
    }
  }

  function reset() {
    result = null;
    notFound = false;
  }
</script>

<svelte:head>
  <title>Sign in with SSO — CodeCrawler</title>
</svelte:head>

<section class="mx-auto max-w-md py-10">
  <h1 class="text-2xl font-semibold tracking-tight">Sign in with SSO</h1>
  <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
    Enter your work email and we'll route you to your team's identity provider.
  </p>

  {#if result}
    <div
      class="mt-6 rounded-xl border border-brand-300 bg-brand-50 p-5 dark:border-brand-800 dark:bg-brand-950"
      role="status"
    >
      <h2 class="text-base font-semibold text-brand-800 dark:text-brand-200">
        Redirecting to your team's SSO ({providerLabel(result.providerId)})…
      </h2>
      <p class="mt-2 text-sm text-brand-700 dark:text-brand-300">
        Organization <span class="font-mono">{result.organizationId}</span> is
        configured for {providerLabel(result.providerId)} single sign-on.
      </p>
      <p class="mt-3 text-xs text-brand-600 dark:text-brand-400">
        SSO is validated structurally; a live IdP login is tested separately.
      </p>
      <div class="mt-4 flex gap-3">
        <button
          type="button"
          onclick={() => goto("/sign-in")}
          class="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500"
        >
          Back to sign in
        </button>
        <button
          type="button"
          onclick={reset}
          class="rounded-md border border-brand-300 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100 dark:border-brand-800 dark:text-brand-300 dark:hover:bg-brand-900"
        >
          Use a different email
        </button>
      </div>
    </div>
  {:else}
    <form class="mt-6 flex flex-col gap-4" onsubmit={submit} novalidate>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Work email</span>
        <input
          type="email"
          name="email"
          autocomplete="email"
          required
          bind:value={email}
          class="input px-3 py-2"
          placeholder="you@yourcompany.com"
        />
      </label>

      {#if notFound}
        <p
          role="status"
          class="rounded-lg border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
        >
          No SSO configured for your domain. Use email and password instead.
        </p>
      {/if}

      <button
        type="submit"
        {disabled}
        class="mt-2 rounded-md bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Resolving…" : "Continue"}
      </button>
    </form>

    <p class="mt-6 text-sm text-neutral-600 dark:text-neutral-400">
      <a
        href="/sign-in"
        class="font-medium text-brand-600 hover:underline dark:text-brand-500"
      >
        Back to sign in
      </a>
    </p>
  {/if}
</section>
