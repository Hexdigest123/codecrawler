<script lang="ts">
import ArrowRight from "@lucide/svelte/icons/arrow-right";
import Bot from "@lucide/svelte/icons/bot";
import BrainCircuit from "@lucide/svelte/icons/brain-circuit";
import Check from "@lucide/svelte/icons/check";
import GitPullRequest from "@lucide/svelte/icons/git-pull-request";
import KeyRound from "@lucide/svelte/icons/key-round";
import LockKeyhole from "@lucide/svelte/icons/lock-keyhole";
import ShieldCheck from "@lucide/svelte/icons/shield-check";
import Sparkles from "@lucide/svelte/icons/sparkles";
import Workflow from "@lucide/svelte/icons/workflow";
import Brand from "$lib/components/Brand.svelte";

const metrics = [
  { value: "92%", label: "less manual review drag" },
  { value: "8m", label: "median PR turnaround" },
  { value: "3", label: "VCS providers supported" },
];

const signals = ["Agentic PR reasoning", "Whole-repo context", "BYOK provider routing"];

const reviewFindings = [
  { type: "Logic", title: "Race condition in billing sync", severity: "Medium" },
  { type: "Quality", title: "Dead path after feature flag", severity: "Low" },
];

const workflow = [
  {
    step: "01",
    title: "Connect your repositories",
    text: "Add GitHub projects, select the teams that own them, and let CodeCrawler map the architecture before the first review.",
  },
  {
    step: "02",
    title: "Route every review to the right model",
    text: "Use hosted models or bring your own keys. CodeCrawler weighs cost, speed, and confidence per task.",
  },
  {
    step: "03",
    title: "Ship with a second brain in CI",
    text: "Every pull request gets contextual findings and a clean audit trail for the team.",
  },
];

const plans = [
  {
    id: "free" as const,
    name: "Free",
    price: "€0",
    tagline: "BYOK exclusively — bring your own API keys.",
    byokOnly: true,
    features: [
      "Unlimited reviews via BYOK",
      "3 teams",
      "5 members / team",
      "Whole-repo context & audit trail",
    ],
  },
  {
    id: "plus" as const,
    name: "Plus",
    price: "€29",
    tagline: "Hosted review budget for busy teams.",
    featured: true,
    features: [
      "50 hosted reviews / day",
      "Hosted + BYOK",
      "Unlimited teams",
      "5 members / team",
    ],
  },
  {
    id: "pro" as const,
    name: "Pro",
    price: "€99",
    tagline: "Unlimited hosted reviews & custom SSO.",
    features: [
      "Unlimited hosted reviews",
      "Custom SSO",
      "Any model weight",
      "Unlimited teams & members",
    ],
  },
];

const faqs = [
  {
    question: "Does CodeCrawler replace human code review?",
    answer:
      "No. It removes repetitive checks, highlights risky changes, and gives reviewers better context before they approve.",
  },
  {
    question: "Can we use our own AI provider keys?",
    answer:
      "Yes. BYOK is a core workflow, so teams can control model spend, provider selection, and review volume.",
  },
  {
    question: "Is the Free plan really free? How many reviews do I get?",
    answer:
      "Yes. The Free plan is exclusively usable via BYOK — you bring your own API keys and pay your provider directly. Because CodeCrawler doesn't meter BYOK reviews, you can run an unlimited number of code reviews on Free, up to 3 teams at a time. Hosted (metered) credits are only included on Plus and Pro.",
  },
];
</script>

<svelte:head>
  <title>CodeCrawler | Agentic AI code reviews</title>
  <meta
    name="description"
    content="CodeCrawler reviews pull requests with whole-project context, BYOK model routing, and team-ready audit trails."
  />
</svelte:head>

<div class="relative isolate overflow-hidden pb-16">
  <div
    class="pointer-events-none absolute left-1/2 top-0 -z-10 h-[38rem] w-[38rem] -translate-x-1/2 rounded-full bg-brand-500/15 blur-3xl dark:bg-brand-400/10"
  ></div>
  <div
    class="pointer-events-none absolute right-0 top-36 -z-10 h-72 w-72 rounded-full bg-cyan-400/20 blur-3xl dark:bg-cyan-300/10"
  ></div>

  <section class="grid items-center gap-12 py-12 lg:grid-cols-[1fr_0.9fr] lg:py-20">
    <div class="space-y-8">
      <div class="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-white/80 px-3 py-1 text-sm font-medium text-brand-700 shadow-sm shadow-brand-950/5 backdrop-blur dark:border-brand-800 dark:bg-neutral-950/70 dark:text-brand-200">
        <Sparkles class="size-4" />
        Agentic code review for teams that ship under pressure
      </div>

      <div class="space-y-5">
        <Brand imgClass="h-16" class="hidden sm:inline-flex" />
        <h1 class="max-w-4xl text-balance text-5xl font-black tracking-[-0.055em] text-neutral-950 sm:text-6xl lg:text-7xl dark:text-white">
          The AI reviewer that understands the whole codebase, not just the diff.
        </h1>
        <p class="max-w-2xl text-lg leading-8 text-neutral-600 sm:text-xl dark:text-neutral-300">
          CodeCrawler gives every pull request an expert second pass: agentic reasoning,
          model routing, and audit-ready evidence for engineering teams.
        </p>
      </div>

      <div class="flex flex-col gap-3 sm:flex-row">
        <a
          href="/sign-up"
          class="group inline-flex items-center justify-center gap-2 rounded-full bg-neutral-950 px-6 py-3 text-base font-semibold text-white shadow-xl shadow-neutral-950/15 transition hover:-translate-y-0.5 hover:bg-brand-600 dark:bg-white dark:text-neutral-950 dark:hover:bg-brand-100"
        >
          Start reviewing free
          <ArrowRight class="size-4 transition group-hover:translate-x-1" />
        </a>
        <a
          href="#workflow"
          class="inline-flex items-center justify-center rounded-full border border-neutral-300 bg-white/80 px-6 py-3 text-base font-semibold text-neutral-900 shadow-sm backdrop-blur transition hover:-translate-y-0.5 hover:bg-white dark:border-neutral-700 dark:bg-neutral-950/70 dark:text-white dark:hover:bg-neutral-900"
        >
          See how it works
        </a>
      </div>

      <div class="grid max-w-2xl grid-cols-3 gap-3 pt-4">
        {#each metrics as metric}
          <div class="rounded-3xl border border-neutral-200 bg-white/70 p-4 shadow-sm shadow-neutral-950/5 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/60">
            <div class="text-2xl font-black tracking-tight text-neutral-950 dark:text-white">{metric.value}</div>
            <div class="mt-1 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{metric.label}</div>
          </div>
        {/each}
      </div>
    </div>

    <div class="relative">
      <div class="absolute -inset-4 rounded-[2.5rem] bg-gradient-to-tr from-brand-500/30 via-cyan-300/20 to-fuchsia-300/25 blur-2xl"></div>
      <div class="relative overflow-hidden rounded-[2rem] border border-neutral-200 bg-neutral-950 p-4 shadow-2xl shadow-brand-950/20 dark:border-neutral-800">
        <div class="mb-4 flex items-center justify-between border-b border-white/10 pb-4">
          <div class="flex items-center gap-2">
            <span class="size-3 rounded-full bg-red-400"></span>
            <span class="size-3 rounded-full bg-yellow-300"></span>
            <span class="size-3 rounded-full bg-green-400"></span>
          </div>
          <span class="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white/70">Review #4281</span>
        </div>

        <div class="grid gap-4 sm:grid-cols-[0.9fr_1.1fr]">
          <div class="space-y-3">
            <div class="rounded-2xl bg-white/[0.06] p-4 ring-1 ring-white/10">
              <div class="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
                <GitPullRequest class="size-4 text-cyan-300" />
                PR risk map
              </div>
              <div class="space-y-2">
                <div class="h-2 rounded-full bg-brand-300/80"></div>
                <div class="h-2 w-4/5 rounded-full bg-cyan-300/70"></div>
                <div class="h-2 w-2/3 rounded-full bg-fuchsia-300/60"></div>
              </div>
            </div>

            {#each signals as signal}
              <div class="flex items-center gap-2 rounded-2xl bg-white/[0.04] px-4 py-3 text-sm text-white/80 ring-1 ring-white/10">
                <Check class="size-4 text-emerald-300" />
                {signal}
              </div>
            {/each}
          </div>

          <div class="rounded-2xl bg-white p-4 text-neutral-950 dark:bg-neutral-100">
            <div class="mb-4 flex items-center justify-between">
              <div>
                <p class="text-xs font-bold uppercase tracking-[0.2em] text-brand-600">Live findings</p>
                <h2 class="text-lg font-black tracking-tight">Checkout service review</h2>
              </div>
              <div class="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-700">Ready</div>
            </div>

            <div class="space-y-3">
              {#each reviewFindings as finding}
                <div class="rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm">
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-xs font-bold uppercase tracking-wide text-neutral-500">{finding.type}</span>
                    <span class="rounded-full bg-neutral-100 px-2 py-1 text-[0.65rem] font-bold text-neutral-700">{finding.severity}</span>
                  </div>
                  <p class="mt-2 font-semibold">{finding.title}</p>
                </div>
              {/each}
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="grid gap-4 border-y border-neutral-200 py-8 sm:grid-cols-3 dark:border-neutral-800" aria-label="Trusted capabilities">
    <div class="flex items-start gap-3">
      <BrainCircuit class="mt-1 size-6 text-brand-600" />
      <div>
        <h2 class="font-bold">Context-first analysis</h2>
        <p class="mt-1 text-sm leading-6 text-neutral-600 dark:text-neutral-400">Understands services, ownership, dependencies, and prior decisions.</p>
      </div>
    </div>
    <div class="flex items-start gap-3">
      <ShieldCheck class="mt-1 size-6 text-brand-600" />
      <div>
        <h2 class="font-bold">Security by default</h2>
        <p class="mt-1 text-sm leading-6 text-neutral-600 dark:text-neutral-400">Surfaces auth, data exposure, and unsafe workflow risks before merge.</p>
      </div>
    </div>
    <div class="flex items-start gap-3">
      <KeyRound class="mt-1 size-6 text-brand-600" />
      <div>
        <h2 class="font-bold">Bring your own keys</h2>
        <p class="mt-1 text-sm leading-6 text-neutral-600 dark:text-neutral-400">Route reviews through your preferred providers and control spend.</p>
      </div>
    </div>
  </section>

  <section id="features" class="py-20">
    <div class="mb-10 max-w-2xl">
      <p class="text-sm font-bold uppercase tracking-[0.24em] text-brand-600">Built for real repositories</p>
      <h2 class="mt-3 text-4xl font-black tracking-tight text-neutral-950 sm:text-5xl dark:text-white">A review system, not a chatbot in your CI.</h2>
    </div>

    <div class="grid gap-4 lg:grid-cols-3">
      <article class="rounded-[2rem] border border-neutral-200 bg-white p-6 shadow-sm shadow-neutral-950/5 dark:border-neutral-800 dark:bg-neutral-950">
        <Bot class="size-8 text-brand-600" />
        <h3 class="mt-6 text-xl font-black tracking-tight">Agentic review plans</h3>
        <p class="mt-3 leading-7 text-neutral-600 dark:text-neutral-400">Specialized agents inspect intent, security, tests, ownership, and maintainability before returning focused findings.</p>
      </article>
      <article class="rounded-[2rem] border border-neutral-200 bg-neutral-950 p-6 text-white shadow-xl shadow-neutral-950/20 dark:border-neutral-800">
        <Workflow class="size-8 text-cyan-300" />
        <h3 class="mt-6 text-xl font-black tracking-tight">Team workflows included</h3>
        <p class="mt-3 leading-7 text-neutral-300">Teams, projects, SSO, API keys, audit logs, and billing live in one product surface.</p>
      </article>
      <article class="rounded-[2rem] border border-neutral-200 bg-white p-6 shadow-sm shadow-neutral-950/5 dark:border-neutral-800 dark:bg-neutral-950">
        <LockKeyhole class="size-8 text-brand-600" />
        <h3 class="mt-6 text-xl font-black tracking-tight">Governance without drag</h3>
        <p class="mt-3 leading-7 text-neutral-600 dark:text-neutral-400">Keep a durable trail of review decisions, model usage, and repository events.</p>
      </article>
    </div>
  </section>

  <section id="workflow" class="rounded-[2.5rem] bg-neutral-950 p-6 text-white shadow-2xl shadow-neutral-950/15 sm:p-10">
    <div class="grid gap-10 lg:grid-cols-[0.8fr_1.2fr]">
      <div>
        <p class="text-sm font-bold uppercase tracking-[0.24em] text-cyan-300">How it works</p>
        <h2 class="mt-3 text-4xl font-black tracking-tight sm:text-5xl">From connected repo to confident merge.</h2>
        <p class="mt-5 leading-7 text-neutral-300">CodeCrawler is designed for teams that need fast review cycles without accepting invisible risk.</p>
      </div>
      <div class="space-y-4">
        {#each workflow as item}
          <article class="grid gap-4 rounded-3xl bg-white/[0.06] p-5 ring-1 ring-white/10 sm:grid-cols-[5rem_1fr]">
            <div class="text-4xl font-black tracking-tight text-white/25">{item.step}</div>
            <div>
              <h3 class="text-xl font-bold">{item.title}</h3>
              <p class="mt-2 leading-7 text-neutral-300">{item.text}</p>
            </div>
          </article>
        {/each}
      </div>
    </div>
  </section>

  <section class="grid gap-4 py-20 lg:grid-cols-[1fr_0.85fr]">
    <div class="rounded-[2rem] border border-neutral-200 bg-white p-8 shadow-sm shadow-neutral-950/5 dark:border-neutral-800 dark:bg-neutral-950">
      <p class="text-sm font-bold uppercase tracking-[0.24em] text-brand-600">Customer voice</p>
      <blockquote class="mt-6 text-3xl font-black tracking-tight text-neutral-950 dark:text-white">
        "It caught the bug our senior reviewer would have found, but before the reviewer even opened the PR."
      </blockquote>
      <p class="mt-6 text-neutral-600 dark:text-neutral-400">Maya Chen, VP Engineering at a payments platform</p>
    </div>
    <div class="rounded-[2rem] bg-gradient-to-br from-brand-600 to-neutral-950 p-8 text-white shadow-xl shadow-brand-950/20">
      <p class="text-sm font-bold uppercase tracking-[0.24em] text-brand-100">Launch offer</p>
      <h2 class="mt-4 text-4xl font-black tracking-tight">Unlimited reviews with BYOK.</h2>
      <p class="mt-4 leading-7 text-brand-100">Start with hosted review credits, then connect your preferred provider keys when volume grows.</p>
      <a href="/sign-up" class="mt-8 inline-flex items-center justify-center gap-2 rounded-full bg-white px-5 py-3 font-bold text-neutral-950 transition hover:-translate-y-0.5 hover:bg-brand-50">
        Create account
        <ArrowRight class="size-4" />
      </a>
    </div>
  </section>

  <section id="pricing" class="py-20">
    <div class="mb-12 max-w-2xl">
      <p class="text-sm font-bold uppercase tracking-[0.24em] text-brand-600">Plans</p>
      <h2 class="mt-3 text-4xl font-black tracking-tight text-neutral-950 sm:text-5xl dark:text-white">
        Start free with BYOK. Scale up when you need hosted credits.
      </h2>
      <p class="mt-5 leading-7 text-neutral-600 dark:text-neutral-400">
        The Free plan runs exclusively on your own API keys — connect a provider and review as many
        pull requests as you want, across up to 3 teams. Upgrade to Plus or Pro when you want hosted
        (metered) credits, more teams, and enterprise controls.
      </p>
    </div>

    <div class="grid gap-5 lg:grid-cols-3">
      {#each plans as plan (plan.id)}
        <article
          class="relative flex flex-col rounded-[2rem] border p-7 shadow-sm shadow-neutral-950/5 {plan.featured
            ? "border-brand-500 bg-white ring-1 ring-brand-500 dark:border-brand-400 dark:bg-neutral-950 dark:ring-brand-400"
            : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"}"
        >
          {#if plan.featured}
            <span class="absolute right-6 top-6 rounded-full bg-brand-600 px-2.5 py-0.5 text-xs font-semibold text-white">
              Most popular
            </span>
          {/if}

          <h3 class="text-xl font-black tracking-tight">{plan.name}</h3>
          <p class="mt-3 text-4xl font-black tracking-tight">
            {plan.price}
            <span class="ml-1 text-sm font-normal text-neutral-500">/mo</span>
          </p>
          <p class="mt-3 text-sm leading-6 text-neutral-600 dark:text-neutral-400">{plan.tagline}</p>

          {#if plan.byokOnly}
            <p class="mt-4 rounded-xl bg-brand-50 px-3 py-2 text-xs font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300">
              BYOK exclusively — no hosted credits. Reviews are unlimited and not metered by CodeCrawler.
            </p>
          {/if}

          <ul class="mt-6 flex flex-1 flex-col gap-3 text-sm text-neutral-600 dark:text-neutral-400">
            {#each plan.features as feature (feature)}
              <li class="flex items-start gap-2">
                <Check class="mt-0.5 size-4 shrink-0 text-brand-600" />
                <span>{feature}</span>
              </li>
            {/each}
          </ul>

          <a
            href="/sign-up"
            class="mt-8 inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-bold transition hover:-translate-y-0.5 {plan.featured
              ? "bg-brand-600 text-white hover:bg-brand-500"
              : "border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white dark:hover:bg-neutral-800"}"
          >
            {plan.id === "free" ? "Start free" : `Choose ${plan.name}`}
            <ArrowRight class="size-4" />
          </a>
        </article>
      {/each}
    </div>

    <p class="mt-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
      All plans include whole-repo context, audit trails, and team workflows. Prices exclude VAT.
    </p>
  </section>

  <section class="grid gap-8 border-t border-neutral-200 pt-16 lg:grid-cols-[0.8fr_1.2fr] dark:border-neutral-800">
    <div>
      <p class="text-sm font-bold uppercase tracking-[0.24em] text-brand-600">FAQ</p>
      <h2 class="mt-3 text-4xl font-black tracking-tight text-neutral-950 dark:text-white">Questions engineering leaders ask first.</h2>
    </div>
    <div class="space-y-3">
      {#each faqs as faq}
        <details class="group rounded-3xl border border-neutral-200 bg-white p-5 shadow-sm shadow-neutral-950/5 dark:border-neutral-800 dark:bg-neutral-950">
          <summary class="cursor-pointer list-none text-lg font-bold text-neutral-950 marker:hidden dark:text-white">{faq.question}</summary>
          <p class="mt-3 leading-7 text-neutral-600 dark:text-neutral-400">{faq.answer}</p>
        </details>
      {/each}
    </div>
  </section>
</div>
