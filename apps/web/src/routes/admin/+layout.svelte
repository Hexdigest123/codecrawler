<script lang="ts">
import { page } from "$app/state";
import Shield from "@lucide/svelte/icons/shield";
import Users from "@lucide/svelte/icons/users";
import UserCheck from "@lucide/svelte/icons/user-check";
import Building from "@lucide/svelte/icons/building-2";
import type { LayoutProps } from "./$types";

let { children }: LayoutProps = $props();

const tabs = $derived([
  { href: "/admin", label: "Overview", icon: Shield, exact: true },
  { href: "/admin/signups", label: "Sign-ups", icon: UserCheck },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/teams", label: "Teams", icon: Building },
]);

function isActive(href: string, exact?: boolean): boolean {
  const path = page.url.pathname.replace(/\/$/, "");
  if (exact) return path === href;
  return path === href || path.startsWith(`${href}/`);
}
</script>

<section class="flex flex-col gap-6">
  <header class="flex items-center gap-3">
    <span
      class="inline-flex size-10 items-center justify-center rounded-lg bg-brand-600 text-white"
    >
      <Shield class="size-5" />
    </span>
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Admin</h1>
      <p class="text-sm text-neutral-600 dark:text-neutral-400">
        Manage sign-ups, payments, users and teams across this instance.
      </p>
    </div>
  </header>

  <nav aria-label="Admin sections" class="flex flex-wrap gap-2 text-sm">
    {#each tabs as tab (tab.href)}
      <a
        href={tab.href}
        aria-current={isActive(tab.href, tab.exact) ? "page" : undefined}
        class={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-medium transition-colors ${
          isActive(tab.href, tab.exact)
            ? "border-brand-600 bg-brand-600 text-white hover:bg-brand-500"
            : "border-neutral-300 bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        }`}
      >
        <tab.icon class="size-4" />
        {tab.label}
      </a>
    {/each}
  </nav>

  {@render children()}
</section>
