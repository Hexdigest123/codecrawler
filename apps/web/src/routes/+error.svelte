<script lang="ts">
  import { authClient } from "@codecrawler/auth/client";
  import { page } from "$app/state";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
  import LogIn from "@lucide/svelte/icons/log-in";

  const session = authClient.useSession();

  const status = $derived(page.status || 500);
  const heading = $derived.by(() => {
    switch (status) {
      case 404:
        return "Page not found";
      case 401:
      case 403:
        return "Access restricted";
      case 500:
        return "Something went wrong";
      default:
        return "Unexpected error";
    }
  });
  const description = $derived.by(() => {
    switch (status) {
      case 404:
        return "The page you're looking for doesn't exist or may have been moved.";
      case 401:
      case 403:
        return "You don't have permission to view this page. Try signing in with a different account.";
      case 500:
        return "An unexpected error occurred on our end. Please try again in a moment.";
      default:
        return page.error?.message ?? "An unexpected error occurred.";
    }
  });
  const isSignedIn = $derived(Boolean($session.data?.user));
</script>

<svelte:head>
  <title>{status} — {heading} · CodeCrawler</title>
</svelte:head>

<section class="relative mx-auto flex max-w-md flex-col items-center py-20 text-center">
  <div class="pointer-events-none absolute left-1/2 top-12 -z-10 size-72 -translate-x-1/2 rounded-full bg-brand-500/10 blur-3xl"></div>

  <p class="bg-gradient-to-br from-brand-600 to-brand-400 bg-clip-text text-7xl font-black tracking-tight text-transparent sm:text-8xl">
    {status}
  </p>
  <h1 class="mt-4 text-2xl font-semibold tracking-tight">{heading}</h1>
  <p class="mt-3 text-sm leading-6 text-neutral-600 dark:text-neutral-400">{description}</p>

  <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
    {#if isSignedIn}
      <a href="/dashboard" class="btn btn-primary px-4 py-2">
        <LayoutDashboard class="size-4" />
        Return to dashboard
      </a>
    {:else}
      <a href="/sign-in" class="btn btn-primary px-4 py-2">
        <LogIn class="size-4" />
        Go to sign in
      </a>
    {/if}
    <a href="/" class="btn btn-outline px-4 py-2">
      <ArrowLeft class="size-4" />
      Go home
    </a>
  </div>
</section>
