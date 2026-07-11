<script lang="ts">
  import { authClient } from "@codecrawler/auth/client";
  import { goto } from "$app/navigation";
  import Brand from "$lib/components/Brand.svelte";
  import { toastError } from "$lib/toast.svelte";

  let email = $state("");
  let password = $state("");
  let loading = $state(false);
  let passkeyLoading = $state(false);

  let disabled = $derived(loading || email.length === 0 || password.length === 0);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (disabled) return;
    loading = true;
    const res = await authClient.signIn.email({ email, password });
    loading = false;
    if (res.error) {
      toastError(res.error.message ?? "Sign in failed.");
      return;
    }
    // Better Auth defers the session when 2FA is enabled, signalling it via a
    // `twoFactorRedirect` flag on the otherwise-successful response.
    if (isTwoFactorRequired(res)) {
      await goto(`/two-factor?email=${encodeURIComponent(email)}`);
      return;
    }
    await goto("/dashboard");
  }

  // After the email/password step, Better Auth defers the session when the user
  // has 2FA enabled and signals it via a `twoFactorRedirect` flag on the
  // otherwise-successful response. Redirect to the second-factor page.
  function isTwoFactorRequired(res: { data?: unknown; error?: unknown }): boolean {
    const d = res.data;
    if (d && typeof d === "object") {
      const obj = d as Record<string, unknown>;
      return obj.twoFactorRedirect === true || obj.twoFactor === true;
    }
    return false;
  }

  async function signInWithPasskey() {
    passkeyLoading = true;
    const { error: err } = await authClient.signIn.passkey();
    passkeyLoading = false;
    if (err) {
      // Abort/Cancel from the WebAuthn prompt is not a real error.
      const msg = (err.message ?? "").toLowerCase();
      if (!msg.includes("abort") && !msg.includes("cancel")) {
        toastError(err.message ?? "Passkey sign-in failed.");
      }
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

    <div class="flex justify-end">
      <a
        href="/forgot-password"
        class="text-sm font-medium text-brand-600 hover:underline dark:text-brand-500"
      >
        Forgot password?
      </a>
    </div>

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

  <button
    type="button"
    onclick={signInWithPasskey}
    disabled={passkeyLoading}
    class="mt-4 block w-full rounded-md border border-neutral-300 px-4 py-2 text-center text-sm font-medium bg-white hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
  >
    {passkeyLoading ? "Waiting for passkey…" : "Sign in with a passkey"}
  </button>

  <a
    href="/sso"
    class="mt-3 block rounded-md border border-neutral-300 px-4 py-2 text-center text-sm font-medium bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
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
