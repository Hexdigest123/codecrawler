<script lang="ts">
import { page } from "$app/state";
import type { LayoutProps } from "./$types";

let { children, data }: LayoutProps = $props();

const teamId = $derived(data.teamId);

const tabs = $derived([
  { href: "members", label: "Members" },
  { href: "graph", label: "Graph" },
  { href: "keys", label: "API keys" },
  { href: "vcs", label: "VCS" },
  { href: "billing", label: "Billing" },
  { href: "sso", label: "SSO" },
  { href: "audit", label: "Audit" },
]);

function tabPath(suffix: string): string {
  return `/teams/${teamId}/settings/${suffix}`;
}

function isActive(suffix: string): boolean {
  const path = page.url.pathname.replace(/\/$/, "");
  return path === tabPath(suffix);
}
</script>

<section class="flex flex-col gap-6">
  <nav aria-label="Breadcrumb" class="text-xs font-medium uppercase tracking-wide text-neutral-500">
    <a href={`/teams/${teamId}`} class="hover:underline">
      {page.data.team?.organization?.name ?? "Team"}
    </a>
    <span class="px-1">/</span>
    Settings
  </nav>

  <nav aria-label="Settings sections" class="flex flex-wrap gap-2 text-sm">
    {#each tabs as tab (tab.href)}
      <a
        href={tabPath(tab.href)}
        aria-current={isActive(tab.href) ? "page" : undefined}
        class={`rounded-md border px-3 py-1.5 font-medium transition-colors ${
          isActive(tab.href)
            ? "border-brand-600 bg-brand-600 text-white hover:bg-brand-500"
            : "border-neutral-300 bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        }`}
      >
        {tab.label}
      </a>
    {/each}
  </nav>

  {@render children()}
</section>
