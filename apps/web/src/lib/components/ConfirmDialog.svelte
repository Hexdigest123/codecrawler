<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import {
    dismissConfirm,
    getCurrentConfirm,
    resolveConfirm,
    type ConfirmRequest,
    type ConfirmTone,
  } from "$lib/confirm.svelte";

  const CONFIRM_BUTTON: Record<ConfirmTone, string> = {
    default: "bg-brand-600 text-white hover:bg-brand-500",
    danger: "bg-red-600 text-white hover:bg-red-500",
  };

  let confirmBtn = $state<HTMLButtonElement | null>(null);

  function onKeydown(event: KeyboardEvent) {
    if (!getCurrentConfirm()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      dismissConfirm();
    } else if (event.key === "Enter") {
      event.preventDefault();
      confirmBtn?.click();
    }
  }

  function autofocus(node: HTMLButtonElement) {
    node.focus();
  }

  $effect(() => {
    const req: ConfirmRequest | null = getCurrentConfirm();
    if (!req) confirmBtn = null;
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if getCurrentConfirm()}
  {@const req = getCurrentConfirm()!}
  <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
    <div
      transition:fade={{ duration: 150 }}
      class="absolute inset-0 bg-neutral-900/50 backdrop-blur-sm"
      onclick={dismissConfirm}
      aria-hidden="true"
    ></div>
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      transition:scale={{ duration: 150, start: 0.96 }}
      class="relative w-full max-w-md rounded-xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
    >
      <h2 id="confirm-dialog-title" class="text-lg font-semibold tracking-tight">
        {req.title}
      </h2>
      <p
        id="confirm-dialog-message"
        class="mt-2 whitespace-pre-line text-sm text-neutral-600 dark:text-neutral-400"
      >
        {req.message}
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onclick={dismissConfirm}
          class="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
        >
          {req.cancelLabel}
        </button>
        <button
          bind:this={confirmBtn}
          use:autofocus
          type="button"
          onclick={resolveConfirm}
          class={`rounded-md px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${CONFIRM_BUTTON[req.tone]}`}
        >
          {req.confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}
