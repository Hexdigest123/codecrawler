<script lang="ts">
  import { fly } from "svelte/transition";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import Info from "@lucide/svelte/icons/info";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import X from "@lucide/svelte/icons/x";
  import { dismissToast, getToasts, type ToastType } from "$lib/toast.svelte";

  const ICONS: Record<ToastType, typeof Info> = {
    success: CircleCheck,
    error: CircleAlert,
    info: Info,
    warning: TriangleAlert,
  };

  const STYLES: Record<ToastType, string> = {
    success:
      "border-green-300 bg-white text-green-700 dark:border-green-800 dark:bg-neutral-900 dark:text-green-300",
    error:
      "border-red-300 bg-white text-red-700 dark:border-red-900 dark:bg-neutral-900 dark:text-red-300",
    info: "border-neutral-300 bg-white text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200",
    warning:
      "border-amber-300 bg-white text-amber-700 dark:border-amber-800 dark:bg-neutral-900 dark:text-amber-300",
  };
</script>

<div
  class="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2"
  role="region"
  aria-label="Notifications"
  aria-live="polite"
>
  {#each getToasts() as t (t.id)}
    {@const Icon = ICONS[t.type]}
    <div
      transition:fly={{ x: 320, duration: 200 }}
      class={`pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm shadow-lg ${STYLES[t.type]}`}
      role={t.type === "error" ? "alert" : "status"}
    >
      <Icon class="mt-0.5 size-4 shrink-0" />
      <span class="flex-1 break-words">{t.message}</span>
      <button
        type="button"
        onclick={() => dismissToast(t.id)}
        class="-mr-1 shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
        aria-label="Dismiss notification"
      >
        <X class="size-4" />
      </button>
    </div>
  {/each}
</div>
