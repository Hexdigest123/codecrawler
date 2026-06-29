<script lang="ts">
interface Props {
  withWordmark?: boolean;
  class?: string;
  imgClass?: string;
}

let { withWordmark = true, class: className = "", imgClass = "" }: Props = $props();
</script>

<a
  href="/"
  class={`inline-flex items-center gap-2 ${className}`}
  aria-label="CodeCrawler — home"
>
  <img
    src="/logo.webp"
    alt=""
    aria-hidden="true"
    class={`h-9 w-auto object-contain dark:brightness-0 dark:invert ${imgClass}`}
  />
  {#if withWordmark}
    <span class="text-lg font-semibold tracking-tight">CodeCrawler</span>
  {/if}
</a>
