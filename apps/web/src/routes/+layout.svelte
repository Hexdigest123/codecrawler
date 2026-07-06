<script lang="ts">
import "../app.css";
import { authClient } from "@codecrawler/auth/client";
import { goto } from "$app/navigation";
import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
import LogIn from "@lucide/svelte/icons/log-in";
import LogOut from "@lucide/svelte/icons/log-out";
import Moon from "@lucide/svelte/icons/moon";
import Shield from "@lucide/svelte/icons/shield";
import Sun from "@lucide/svelte/icons/sun";
import UserCircle from "@lucide/svelte/icons/user-circle";
import UserPlus from "@lucide/svelte/icons/user-plus";
import Brand from "$lib/components/Brand.svelte";
import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
import Toasts from "$lib/components/Toasts.svelte";
import { toggleTheme } from "$lib/theme";

let { children } = $props();

const session = authClient.useSession();
let signingOut = $state(false);

const isAdmin = $derived(
  ($session.data?.user as { role?: string } | undefined)?.role === "admin",
);

async function signOut() {
  signingOut = true;
  await authClient.signOut();
  signingOut = false;
  await goto("/");
}
</script>

<a
  href="#main"
  class="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-black"
>
  Skip to content
</a>

<header
  class="sticky top-0 z-40 border-b border-neutral-200 bg-white/80 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80"
>
  <nav
    class="mx-auto flex h-14 max-w-6xl items-center justify-between px-4"
    aria-label="Main navigation"
  >
    <Brand />
    <div class="flex items-center gap-1 text-sm sm:gap-4">
      <button
        type="button"
        onclick={toggleTheme}
        class="inline-flex items-center justify-center rounded-md px-2 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-900"
        aria-label="Toggle color theme"
        title="Toggle color theme"
      >
        <Moon class="size-4 dark:hidden" />
        <Sun class="hidden size-4 dark:block" />
      </button>
      {#if $session.data}
        {#if isAdmin}
          <a
            href="/admin"
            class="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-neutral-100 sm:px-3 dark:hover:bg-neutral-900"
            aria-label="Admin"
            title="Admin dashboard"
          >
            <Shield class="size-4" />
            <span class="hidden sm:inline">Admin</span>
          </a>
        {/if}
        <a
          href="/dashboard"
          class="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-neutral-100 sm:px-3 dark:hover:bg-neutral-900"
          aria-label="Dashboard"
        >
          <LayoutDashboard class="size-4" />
          <span class="hidden sm:inline">Dashboard</span>
        </a>
        <a
          href="/account"
          class="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-neutral-100 sm:px-3 dark:hover:bg-neutral-900"
          aria-label="Account"
          title={$session.data.user?.email}
        >
          <UserCircle class="size-4" />
          <span class="hidden sm:inline">Account</span>
        </a>
        <button
          type="button"
          onclick={signOut}
          disabled={signingOut}
          class="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-2 py-1.5 font-medium bg-white hover:bg-neutral-100 disabled:opacity-50 sm:px-3 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          aria-label="Sign out"
        >
          <LogOut class="size-4" />
          <span class="hidden sm:inline">{signingOut ? "Signing out…" : "Sign out"}</span>
        </button>
      {:else}
        <a
          href="/sign-in"
          class="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-neutral-100 sm:px-3 dark:hover:bg-neutral-900"
          aria-label="Sign in"
        >
          <LogIn class="size-4" />
          <span class="hidden sm:inline">Sign in</span>
        </a>
        <a
          href="/sign-up"
          class="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-2 py-1.5 font-medium text-white hover:bg-brand-500 sm:px-3"
          aria-label="Sign up"
        >
          <UserPlus class="size-4" />
          <span class="hidden sm:inline">Sign up</span>
        </a>
      {/if}
    </div>
  </nav>
</header>

<main id="main" class="mx-auto max-w-6xl px-4 py-10">
  {@render children()}
</main>

<Toasts />
<ConfirmDialog />
