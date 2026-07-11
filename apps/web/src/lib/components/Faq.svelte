<script lang="ts">
  import { onMount } from "svelte";
  import { gsap } from "gsap";
  import { ScrollTrigger } from "gsap/ScrollTrigger";
  import Plus from "@lucide/svelte/icons/plus";

  interface Faq {
    question: string;
    answer: string;
  }

  interface Props {
    faqs: Faq[];
  }

  let { faqs }: Props = $props();
  let openIndex = $state<number | null>(null);
  let sectionEl: HTMLDivElement;

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function animate(item: HTMLElement, open: boolean) {
    const content = item.querySelector<HTMLElement>("[data-faq-content]");
    const icon = item.querySelector<HTMLElement>("[data-faq-icon]");
    if (!content || !icon) return;
    if (reduceMotion) {
      gsap.set(content, { height: open ? "auto" : 0, autoAlpha: open ? 1 : 0 });
      gsap.set(icon, { rotate: open ? 45 : 0 });
      return;
    }
    gsap.to(content, {
      height: open ? "auto" : 0,
      autoAlpha: open ? 1 : 0,
      duration: open ? 0.42 : 0.3,
      ease: open ? "power3.out" : "power2.in",
    });
    gsap.to(icon, { rotate: open ? 45 : 0, duration: 0.3, ease: "power2.out" });
  }

  function toggle(index: number) {
    if (!sectionEl) return;
    const items = sectionEl.querySelectorAll<HTMLElement>("[data-faq-item]");
    const target = items[index];
    if (!target) return;

    if (openIndex === index) {
      animate(target, false);
      openIndex = null;
      return;
    }
    if (openIndex !== null && items[openIndex]) {
      animate(items[openIndex], false);
    }
    animate(target, true);
    openIndex = index;
  }

  onMount(() => {
    if (!sectionEl) return;
    gsap.registerPlugin(ScrollTrigger);
    const ctx = gsap.context(() => {
      gsap.set("[data-faq-content]", {
        height: 0,
        autoAlpha: 0,
        overflow: "hidden",
      });
      if (reduceMotion) return;
      gsap.from("[data-faq-item]", {
        y: 28,
        autoAlpha: 0,
        duration: 0.6,
        ease: "power3.out",
        stagger: 0.12,
        scrollTrigger: {
          trigger: sectionEl,
          start: "top 80%",
          once: true,
        },
      });
    }, sectionEl);
    return () => ctx.revert();
  });
</script>

<div bind:this={sectionEl} class="space-y-3">
  {#each faqs as faq, i (faq.question)}
    <div
      data-faq-item
      class="group rounded-3xl border bg-white shadow-sm shadow-neutral-950/5 transition-colors duration-300 hover:border-brand-300 dark:bg-neutral-950 dark:hover:border-brand-700 {openIndex ===
      i
        ? "border-brand-400 ring-1 ring-brand-200 dark:border-brand-600 dark:ring-brand-900"
        : "border-neutral-200 dark:border-neutral-800"}"
    >
      <h3>
        <button
          type="button"
          class="flex w-full items-center justify-between gap-4 p-5 text-left"
          aria-expanded={openIndex === i}
          onclick={() => toggle(i)}
        >
          <span class="text-lg font-bold text-neutral-950 dark:text-white">{faq.question}</span>
          <span
            data-faq-icon
            class="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-100 dark:bg-brand-950 dark:text-brand-400 dark:group-hover:bg-brand-900"
          >
            <Plus class="size-4" />
          </span>
        </button>
      </h3>
      <div data-faq-content>
        <p class="px-5 pb-5 leading-7 text-neutral-600 dark:text-neutral-400">
          {faq.answer}
        </p>
      </div>
    </div>
  {/each}
</div>
