<script lang="ts">
  import { authClient } from "@codecrawler/auth/client";
  import { ApiError, api } from "$lib/api";
  import { toastError } from "$lib/toast.svelte";
  import { goto } from "$app/navigation";

  interface ResolveResult {
    providerId: string;
    organizationId: string | null;
  }

  let email = $state("");
  let loading = $state(false);
  let redirecting = $state(false);
  let notFound = $state(false);

  const disabled = $derived(loading || email.trim().length === 0);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (disabled) return;
    notFound = false;
    loading = true;
    try {
      // Confirm a provider is registered for this domain before kicking off
      // the handshake, so we can show a clear "no SSO" message instead of a
      // raw 4xx from the IdP redirect.
      const resolved = await api<ResolveResult | null>("/api/sso/resolve", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!resolved) {
        notFound = true;
        return;
      }
      redirecting = true;
      // Better Auth's SSO plugin handles the IdP redirect + callback. After a
      // successful SSO login the browser lands on /dashboard (callbackURL).
      const { error: err } = await authClient.signIn.sso({
        providerId: resolved.providerId,
        callbackURL: "/dashboard",
        errorCallbackURL: "/sso?error=1",
        newUserCallbackURL: "/dashboard",
      });
      if (err) {
        redirecting = false;
        toastError(err.message ?? "Could not start SSO sign-in.");
      }
      // On success the browser is redirected by the plugin — no goto() needed.
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : "Could not resolve SSO.");
    } finally {
      loading = false;
    }
  }

  function reset() {
    notFound = false;
    email = "";
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

  {#if redirecting}
    <div
      class="mt-6 rounded-xl border border-brand-300 bg-brand-50 p-5 dark:border-brand-800 dark:bg-brand-950"
      role="status"
    >
      <h2 class="text-base font-semibold text-brand-800 dark:text-brand-200">
        Redirecting to your identity provider…
      </h2>
      <p class="mt-2 text-sm text-brand-700 dark:text-brand-300">
        If you are not redirected automatically, follow the link shown by your
        identity provider.
      </p>
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
