<script lang="ts">
  import { authClient } from "@codecrawler/auth/client";
  import { goto } from "$app/navigation";
  import Brand from "$lib/components/Brand.svelte";
  import { toastError, toastSuccess } from "$lib/toast.svelte";
  import type { SignupConfig, SignupMode } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const config = $derived<SignupConfig | null>(data.config);
  const mode = $derived<SignupMode>((config?.signupMode as SignupMode) ?? "open");
  const closed = $derived(mode === "closed" || !config);

  let name = $state("");
  let email = $state("");
  let password = $state("");
  let loading = $state(false);

const domain = $derived(email.trim().toLowerCase().split("@")[1] ?? "");
const allowedDomains = $derived((config?.allowedDomains ?? []).map((d) => d.toLowerCase()));
const domainBlocked = $derived(
  mode === "domain_restricted" && domain.length > 0 && !allowedDomains.includes(domain),
);

let disabled = $derived(
  loading ||
    closed ||
    name.length === 0 ||
    email.length === 0 ||
    password.length < 8 ||
    domainBlocked,
);

function describeMode(): string {
  switch (mode) {
    case "approval":
      return "New accounts require administrator approval. You'll receive an email once your request is reviewed.";
    case "domain_restricted":
      return `Sign-ups are restricted to: ${allowedDomains.join(", ") || "(no domains configured)"}.`;
    case "closed":
      return "New sign-ups are currently disabled for this instance.";
    default:
      return "Start reviewing PRs in minutes. No credit card required.";
  }
}

function isPendingApprovalError(err: { message?: string; status?: number | string }): boolean {
  const msg = (err.message ?? "").toLowerCase();
  return (
    err.status === 403 ||
    String(err.status) === "403" ||
    msg.includes("pending administrator approval") ||
    msg.includes("pending") && msg.includes("approval")
  );
}

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (disabled) return;
    loading = true;
    const { error: err } = await authClient.signUp.email({ email, password, name });
    loading = false;
    if (err) {
      // In approval mode the account is created pending, then the session hook
      // blocks sign-in — surface that as a confirmation, not an error.
      if (mode === "approval" && isPendingApprovalError(err as never)) {
        toastSuccess(
          "Your request was submitted and is pending administrator approval. We'll email you once it's reviewed.",
        );
        return;
      }
      toastError(err.message ?? "Sign up failed.");
      return;
    }
    if (mode === "approval") {
      toastSuccess(
        "Your request was submitted and is pending administrator approval. We'll email you once it's reviewed.",
      );
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
    {describeMode()}
  </p>

  {#if closed}
    <div
      class="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      role="status"
    >
      Sign-ups are closed right now. Please contact the instance administrator if you
      need access.
    </div>
  {:else}
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
        {#if domainBlocked}
          <span class="text-xs text-red-600 dark:text-red-400">
            Domain “{domain}” is not allowed. Use one of: {allowedDomains.join(", ")}.
          </span>
        {/if}
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

      <button
        type="submit"
        {disabled}
        class="mt-2 rounded-md bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading
          ? "Creating account…"
          : mode === "approval"
            ? "Request access"
            : "Sign up"}
      </button>
    </form>
  {/if}

  <p class="mt-6 text-sm text-neutral-600 dark:text-neutral-400">
    Already have an account?
    <a href="/sign-in" class="font-medium text-brand-600 hover:underline dark:text-brand-500">
      Sign in
    </a>
  </p>
</section>
