# CodeCrawler — Architecture Guide

> **The 10-minute tour.** Read this instead of spelunking through 20k lines of
> TypeScript. By the end you'll know what every folder does, how a pull-request
> review flows through the system, and where to look when something breaks.

---

## 1. What is CodeCrawler?

CodeCrawler is an **agentic, multi-provider code-review platform** — think
[CodeRabbit](https://coderabbit.ai), but self-hosted. You connect a Git
repository (GitHub, GitLab, or Gitea), and every time a pull request is opened
or updated, an AI agent reads the diff, explores the surrounding code, and posts
a structured review back to the PR with inline comments, a severity-rated
finding list, and a plain-English walkthrough.

Three things make it more than a thin ChatGPT wrapper:

1. **Agentic review loop.** Instead of one big prompt, a [LangGraph](https://langchain-ai.github.io/langgraph/)
   state machine fans out multiple tool-calling reviewer agents (each can
   `read_file`, `search_code`, `list_dir` inside a live checkout), then
   synthesises their findings. This catches cross-file issues a single-shot
   review would miss.
2. **Multi-provider + BYOK.** The AI gateway routes to OpenRouter (hosted /
   metered) or directly to a team's own API keys (Anthropic, OpenAI, Google,
   xAI, etc.). Free-plan teams bring their own keys; paid plans get hosted
   credits.
3. **Multi-tenant with billing.** Better Auth organisations, Mollie
   subscriptions (Plus / Pro), per-team quota enforcement, SSO (SAML + OIDC),
   2FA, passkeys — the full SaaS plumbing, self-hosted.

---

## 2. Monorepo layout

```
codecrawler/
├── apps/
│   ├── api/       Hono REST API (auth, teams, billing, projects, reviews, admin)
│   ├── web/       SvelteKit dashboard (Svelte 5 runes, Tailwind)
│   └── worker/    BullMQ worker (review jobs, payments, scheduled tasks)
│
├── packages/
│   ├── shared/    Env schema, AES-GCM crypto, plan limits, types, constants
│   ├── db/        Drizzle ORM schema, Postgres client, migrations, seed
│   ├── auth/      Better Auth (email/pass, GitHub OAuth, org SSO, 2FA, passkeys)
│   ├── vcs/       GitHub / GitLab / Gitea provider adapters + webhook verify
│   ├── ai/        Multi-provider LLM gateway (OpenRouter + BYOK + catalog)
│   ├── agents/    LangGraph review engine (ingest → index → plan → review → synth → post)
│   ├── billing/   Mollie payments (checkout, subscriptions, reconciliation)
│   ├── email/     Nodemailer transactional templates (40+ events)
│   ├── queue/     BullMQ queue factory + shared queue names
│   └── quotas/    Usage tracking, quota checks, credit-cost projection
│
├── docker-compose.yml          Dev infra (Postgres, Redis, Mailpit)
├── docker-compose.prod.yml     Production stack (+ Caddy, api, worker, web)
├── Caddyfile                   Edge proxy / auto-TLS / routing
└── scripts/                    DB backup, healthcheck, etc.
```

**Rule of thumb:** `packages/` are libraries imported by `apps/`. Apps are
processes you run (`bun run dev`); packages are code you import.

---

## 3. The three running processes

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                    │
│    SvelteKit SPA                                            │
└────────┬──────────────────────────────────┬────────────────┘
         │ HTTPS (same origin via Caddy)    │
         ▼                                  ▼
┌─────────────────┐               ┌──────────────────┐
│  web (SvelteKit)│               │  api (Hono)      │
│  SSR + assets   │  /api/* ────► │  REST + Auth     │
│  port 3000      │               │  port 3001       │
└─────────────────┘               └────┬─────────────┘
                                       │ enqueues jobs
                                       ▼
                               ┌──────────────────┐
                               │  Redis (BullMQ)  │
                               └────┬─────────────┘
                                    │ dequeues
                                    ▼
                               ┌──────────────────┐
                               │  worker (BullMQ) │
                               │  LangGraph runs  │
                               └────┬─────────────┘
                                    │ reads/writes
                                    ▼
                               ┌──────────────────┐
                               │  PostgreSQL 18   │
                               └──────────────────┘
```

| Process | What it does | Entry point |
| --- | --- | --- |
| **api** | REST API: auth, team/project CRUD, billing, review triggers, admin dashboard. Enqueues review jobs onto BullMQ. | `apps/api/src/` |
| **worker** | Consumes BullMQ queues: runs the LangGraph review engine, processes payment webhooks, runs scheduled cron jobs (PR polling, payment reconciliation). | `apps/worker/src/index.ts` |
| **web** | SvelteKit SPA dashboard. Talks to the API over `/api/*` (same-origin in prod via Caddy). | `apps/web/src/` |

The API never calls the LLM directly — it validates, persists a `reviews` row
with `status: "running"`, and pushes a job onto Redis. The worker picks it up,
runs the full agent graph, and updates the row when done. This keeps the API
fast and isolates long-running AI calls.

---

## 4. How a pull-request review works (end-to-end)

This is the core flow. Follow along in the code:

```
PR opened / manual trigger / poll discovery
    │
    ▼  apps/api  ──  upsertPullAndEnqueueReview()
    │   • resolve depth tier (static / quick / deep)
    │   • resolve VCS auth (stored PAT or GH_TEST_PAT)
    │   • prefetch PR metadata (title, SHAs, author)
    │   • INSERT reviews row (status = "running")
    │   • queue.add(review job)  ──►  Redis (BullMQ)
    │
    ▼  apps/worker  ──  reviews queue consumer
    │   calls runReview() from @codecrawler/agents
    │
    ▼  packages/agents  ──  LangGraph StateGraph
    │
    │  ┌──────────────────────────────────────────────┐
    │  │  INGEST   fetch PR + diff via VCS provider    │
    │  │            (or use synthetic test data)        │
    │  │            • git checkout into tmpdir          │
    │  ├──────────────────────────────────────────────┤
    │  │  INDEX    build compact repo map (cached)     │
    │  │            • Redis-cached by commit SHA        │
    │  ├──────────────────────────────────────────────┤
    │  │  PLAN     decide review units                 │
    │  │            • static: one unit per file        │
    │  │            • agentic: orchestrator picks      │
    │  │              logical file groups + focus      │
    │  ├──────────────────────────────────────────────┤
    │  │  REVIEW   fan-out: one agent per unit         │
    │  │            • agentic: ReAct loop with tools   │
    │  │              (read_file, search_code, list_dir)│
    │  │            • static: single-shot LLM call     │
    │  │            • output: structured findings (JSON)│
    │  ├──────────────────────────────────────────────┤
    │  │  SYNTH    de-duplicate findings               │
    │  │            • summarizer writes walkthrough     │
    │  │              (risk level + highlights)         │
    │  ├──────────────────────────────────────────────┤
    │  │  POST     persist review + findings to DB     │
    │  │            • compute credit cost               │
    │  │            • post review to VCS (inline + body)│
    │  └──────────────────────────────────────────────┘
    │
    ▼  apps/worker  ──  post-job
        • record usage (credits)
        • send "review-completed" / "review-failed" email
        • check quota threshold → "quota-warning" email
```

**Depth tiers** control how much the agent does:

| Tier | Behaviour | Budget |
| --- | --- | --- |
| `static` | Legacy single-shot — no tools, one LLM call per file group | ~free |
| `quick` | ReAct agent loop, up to 6 steps, $0.50 spend ceiling | cheap |
| `deep` | ReAct agent loop, up to 12 steps, $2.00 spend ceiling | thorough |

Deep reviews land on a **separate queue** (`reviews-deep`, concurrency 1) so
long agent loops can't starve quick reviews.

---

## 5. Package cheat-sheet

Don't know which package to look at? Start here.

| Package | One-liner | Key file(s) |
| --- | --- | --- |
| `shared` | Env validation, AES-GCM token encryption, plan limits, shared types/constants | `env.ts`, `crypto.ts`, `plans.ts` |
| `db` | Drizzle ORM schema (20+ tables), Postgres client, migrations | `src/schema/`, `src/client.ts` |
| `auth` | Better Auth wrapper — signup gates, SSO, 2FA, passkeys, OIDC secret encryption | `src/index.ts` |
| `vcs` | GitHub / GitLab / Gitea adapters + webhook signature verification | `src/index.ts` |
| `ai` | LLM gateway: provider routing, model catalog, BYOK key CRUD + verify | `catalog.ts`, `client.ts`, `byok.ts` |
| `agents` | LangGraph review engine — the actual AI brain | `src/index.ts`, `tools.ts`, `repo-map.ts` |
| `billing` | Mollie payments — checkout, subscriptions, reconciliation | `src/index.ts` |
| `email` | 40+ transactional email templates + notification preferences | `src/index.ts` |
| `queue` | BullMQ queue factory + shared queue names | `src/index.ts` (19 lines) |
| `quotas` | Usage tracking, quota enforcement, credit-cost math | `src/index.ts` |

---

## 6. Database schema overview

PostgreSQL 18. All tables are defined with Drizzle ORM in
`packages/db/src/schema/`. Each table has its own file.

```
                    ┌──────────┐
                    │  user    │  Better Auth users (role: admin|user, status: active|pending|denied)
                    └────┬─────┘
            ┌───────────┼──────────────┐
            ▼           ▼              ▼
     ┌──────────┐ ┌──────────┐  ┌─────────────┐
     │ session  │ │ account  │  │ passkey /   │
     │          │ │ (oauth)  │  │ twoFactor   │
     └──────────┘ └──────────┘  └─────────────┘
            │
            ▼
     ┌──────────────┐        ┌──────────────────┐
     │ organization │───────►│  team_subscriptions │  plan: free|plus|pro, Mollie IDs
     │  (team)      │        └──────────────────┘
     └──────┬───────┘
            │
   ┌────────┼──────────────────────────┐
   ▼        ▼                          ▼
┌──────┐ ┌────────────┐        ┌───────────────┐
│member│ │  projects  │        │ vcs_connections│  encrypted PATs (per provider)
└──────┘ │  repo+provider     └───────────────┘
         └─────┬──────┘
               │
      ┌────────┼─────────┐
      ▼                   ▼
┌──────────┐       ┌──────────────────┐
│pull_reqs │──────►│     reviews      │  status, depth, cost, diff snapshot
└──────────┘       └────┬─────────────┘
                        ▼
                 ┌──────────────────┐
                 │ review_findings   │  file, line, severity, category, message
                 └──────────────────┘

  Other tables: api_keys (encrypted BYOK), usage (quota tracking),
  audit_log, notification_settings, app_settings (singleton),
  signup_requests, model_weights, sso_provider, agent_profiles
```

**Secrets at rest:** VCS tokens, BYOK API keys, and SSO OIDC client secrets
are all encrypted with AES-256-GCM (`packages/shared/src/crypto.ts`). The
keyring supports rotation via `TOKEN_ENCRYPTION_KEYS`. Each ciphertext is
bound to an AAD category string so a leaked blob can't be replayed across
tables.

---

## 7. Authentication & multi-tenancy

- **Better Auth** (`packages/auth`) handles email/password, optional GitHub
  OAuth, organisation (team) management, SSO (SAML + OIDC), TOTP 2FA, and
  WebAuthn passkeys.
- Every user belongs to one or more **organisations** (teams) as a
  `member` with role `owner`, `admin`, or `member`.
- The API enforces org membership on every `/api/teams/:id/*` route via
  `requireOrgAccess` / `requireOrgAdmin`.
- **Signup gates** (controlled by admin dashboard): `open`,
  `domain_restricted`, `approval` (creates user as `pending`, admin approves
  in the dashboard), or `closed`.
- The first user ever created is auto-promoted to `admin`.

---

## 8. Billing & quotas

```
Free          BYOK only, no hosted reviews, 3 teams, 5 members/team
Plus  €29/mo  50 hosted reviews/day, BYOK + hosted, unlimited teams
Pro   €99/mo  Unlimited hosted reviews, custom SSO, any model weight
```

- **Mollie** (`packages/billing`) handles checkout and recurring subscriptions.
  The first payment seeds a Mollie subscription; the worker reconciles daily.
- **Quotas** (`packages/quotas`) track per-org usage keyed on
  `(orgId, kind, periodKey)`. Each review records its credit cost, which is
  projected *before* the run (`projectReviewCost`) to reject over-limit
  requests early.
- **BYOK reviews cost 0 credits** — the team pays the LLM provider directly.
  Hosted reviews cost credits derived from actual token spend.

---

## 9. AI gateway (`packages/ai`)

The gateway abstracts away *which* LLM provider to call:

```
resolveProvider(modelId, orgId)
    │
    ├── Team has a BYOK key for this provider?
    │     YES → call provider directly (ChatAnthropic / ChatGoogleGenerativeAI /
    │            ChatOpenAI with provider's base URL)
    │     NO  → route through OpenRouter (hosted, metered)
    │
    └── Returns: { provider, vendor, gateway, weight, billingMode, minPlan }
```

- **Model catalog** is fetched live from OpenRouter (5-min cache) and merged
  with the team's BYOK providers. Each model is tagged with a **weight**
  (1–10, log-blended from blend pricing) that determines plan eligibility.
- **SAIA** (academic cloud) is a special BYOK gateway with its own model list.

---

## 10. Key design decisions

| Decision | Why |
| --- | --- |
| **API never calls the LLM** | Keeps HTTP responses fast; long AI runs live in the worker via BullMQ. |
| **Polling instead of webhooks** | Works behind firewalls / self-hosted VCS without inbound connectivity. The worker polls open PRs every 5 min (configurable). |
| **Separate `reviews-deep` queue** | Long agent loops (12 steps, $2 budget) would starve quick reviews if they shared a queue. |
| **LangGraph over raw prompts** | Tool-calling ReAct agents can explore the repo (read_file, search_code) and catch cross-file issues. Single-shot reviews miss these. |
| **BYOK = 0 credits** | Teams with their own keys pay the provider directly; CodeCrawler doesn't double-charge. |
| **AAD-bound encryption** | Each encrypted secret (VCS token, API key, SSO secret) is tagged with a category string so a ciphertext leaked from one table can't decrypt in another. |
| **Svelte 5 runes + SPA** | Client-only rendering (`ssr = false`) simplifies auth cookie handling; the dashboard is behind login anyway. |

---

## 11. Development quickstart

```sh
cp .env.example .env          # fill in required secrets
podman compose up -d           # Postgres + Redis + Mailpit
bun install
bun run db:migrate
bun run db:seed
bun run dev                    # starts api + web + worker in parallel
```

| Service | URL |
| --- | --- |
| Web dashboard | http://localhost:5173 |
| API | http://localhost:3001 |
| Health check | http://localhost:3001/api/health |
| Mailpit (email preview) | http://localhost:8025 |

Useful scripts: `bun run typecheck`, `bun run lint`, `bun run db:seed`.

---

## 12. Where to look when...

| You want to... | Look at |
| --- | --- |
| Understand the AI review pipeline | `packages/agents/src/index.ts` (LangGraph graph) |
| Add a new API route | `apps/api/src/routes/` (split by domain) |
| Add a new email template | `packages/email/src/templates/` |
| Change the DB schema | `packages/db/src/schema/` + `bun run db:generate` |
| Add a new VCS provider | `packages/vcs/src/providers/` |
| Understand billing | `packages/billing/src/index.ts` |
| Debug a stuck review | Check `reviews` table status, then `podman logs codecrawler-worker` |
| See all env vars | `packages/shared/src/env.ts` |
