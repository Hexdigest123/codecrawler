# CodeCrawler

An agentic, multi-provider code-review platform (CodeRabbit-style) that reviews
pull requests and scans whole projects for security issues across GitHub,
GitLab, and Gitea. Every user-relevant event triggers an email.

> **Status: M0 — Scaffold & infra.** Monorepo, dev infrastructure, shared
> primitives, and CI are in place. Feature milestones land next per the roadmap
> in [.opencode/PLAN.md](.opencode/PLAN.md).

## Stack

| Concern | Choice |
| --- | --- |
| Language | TypeScript everywhere |
| Runtime + pkg mgr | Bun (never npm/yarn/pnpm) |
| Repo | Bun workspaces monorepo |
| Frontend | SvelteKit + Tailwind (Svelte 5 runes) |
| Backend | Hono (served by Bun via `fetch` export) |
| Auth | Better Auth (email/password + GitHub + `organization` plugin + org SSO) |
| DB | PostgreSQL 18 alpine |
| ORM | Drizzle |
| Cache/queue | Redis + BullMQ |
| AI gateway | OpenRouter (hosted, metered) + direct BYOK |
| Agent orchestration | LangGraph (`@langchain/langgraph`) |
| Security scanning | Snyk (deps + SAST) in the worker + AI pass |
| Payments | Mollie (team-owned flat monthly subscriptions) |
| Email | Nodemailer + Mailpit (dev) |
| Analytics | Plausible |
| Lint/format | Biome |

## Prerequisites

- [Bun](https://bun.sh) `>= 1.1`
- [Podman](https://podman.io) (with `podman-compose` alias resolving to Compose v2)

## Quickstart

```sh
cp .env.example .env
podman compose up -d
bun install
bun run db:migrate
bun run db:seed
bun run dev
```

## Endpoints (dev)

| Service | URL |
| --- | --- |
| Web (SvelteKit) | http://localhost:5173 |
| API (Hono) | http://localhost:3001 |
| Health | http://localhost:3001/api/health |
| Mailpit UI | http://localhost:8025 |
| PostgreSQL | `localhost:5432` |
| Redis | `localhost:6379` |

## Scripts

| Script | Description |
| --- | --- |
| `bun run dev` | Watch-build every workspace app/package |
| `bun run build` | Build every workspace |
| `bun run typecheck` | `tsc --noEmit` in every workspace |
| `bun run lint` | Biome check |
| `bun run format` | Biome format (write) |
| `bun run db:up` | Start dev infra (postgres/redis/mailpit) |
| `bun run db:down` | Stop dev infra |
| `bun run db:generate` | Generate Drizzle migration |
| `bun run db:migrate` | Apply Drizzle migration |
| `bun run db:seed` | Seed the database |

## Plan

See [.opencode/PLAN.md](.opencode/PLAN.md) for the full product plan, data
model, agent graph design, billing rules, and roadmap.

## Production deployment

CodeCrawler ships as a self-hosted stack on a single VPS: PostgreSQL, Redis, the
`api` / `worker` / `web` apps, and Caddy (auto-HTTPS via Let's Encrypt). The
production topology lives in `docker-compose.prod.yml` + `Caddyfile`.

### Prerequisites

- A Linux x86_64 VPS with root/sudo. ~2 vCPU / 4 GB RAM is a sensible floor for a
  small team; raise it once Snyk + LangGraph load is known.
- A domain (e.g. `codecrawler.merckel.dev`) with **A** (and **AAAA**) DNS records
  pointing at the VPS public IP. Caddy will not issue a certificate until DNS
  resolves.
- [Podman](https://podman.io) with the Compose v2 plugin (`podman compose
  version` works). On Debian/Ubuntu: `apt install podman podman-compose`, or use
  the official static build.
- Ports **80** and **443** open on the VPS firewall (HTTP-01 challenge + TLS).

### Service map

| Service  | Image / build          | In-container port | Host port            | Role |
| -------- | ---------------------- | ----------------- | -------------------- | ---- |
| `db`     | `postgres:18-alpine`   | 5432              | `127.0.0.1:5432` (admin only) | Postgres 18 data store |
| `redis`  | `redis:7-alpine`       | 6379              | — (internal)         | BullMQ queues + cache |
| `api`    | `apps/api/Dockerfile`  | 3001              | — (internal)         | Hono REST + Better Auth + webhooks |
| `worker` | `apps/worker/Dockerfile` | —               | — (internal)         | BullMQ workers, LangGraph, Snyk CLI |
| `web`    | `apps/web/Dockerfile`  | 3000              | — (internal)         | SvelteKit (adapter-node) dashboard |
| `caddy`  | `caddy:2-alpine`       | 80, 443           | `80:80`, `443:443`   | Edge proxy, auto-TLS, routing |

Named volumes: `postgres-data`, `redis-data`, `caddy_data`, `caddy_config`. App
images are built from the **repository root** (Bun-workspace context) so each
Dockerfile can copy the workspace packages + root lockfile.

### Caddy routes

- `https://codecrawler.merckel.dev/api/*` → `api:3001` — REST, Better Auth
  (`/api/auth/*`), GitHub/GitLab/Gitea webhooks (`/api/webhooks/*`), and the
  Mollie webhook (`/api/payments/webhook`).
- `https://codecrawler.merckel.dev/*` (everything else) → `web:3000` — SvelteKit
  SSR + static assets. Relative `/api` calls from the browser resolve on the same
  origin, so no CORS gymnastics in prod.
- Every response carries `Strict-Transport-Security`, `X-Content-Type-Options`,
  and `Referrer-Policy`, and is `gzip`/`zstd`-encoded. Access logs go to stdout
  (`podman logs codecrawler-caddy`).
- A commented `api.codecrawler.merckel.dev` site block in `Caddyfile` is available
  if you prefer a dedicated API/webhook subdomain.

### Configure the environment

```sh
cp .env.prod.example .env
```

Edit `.env` on the VPS and fill **every** secret. The prod-only changes (these
differ from `.env.example` dev defaults):

| Variable | Dev (`.env.example`) | Prod (`.env` on VPS) |
| --- | --- | --- |
| `DATABASE_URL` | `...@localhost:5432/...` | `postgresql://codecrawler:postgres@db:5432/codecrawler` |
| `REDIS_URL` | `redis://localhost:6379` | `redis://redis:6379` |
| `PUBLIC_WEB_URL` / `PUBLIC_API_URL` / `PUBLIC_SITE_URL` | `http://localhost:...` | `https://codecrawler.merckel.dev` |
| `BETTER_AUTH_URL` | `http://localhost:3001` | `https://codecrawler.merckel.dev` |
| `CORS_ORIGIN` | `http://localhost:5173` | `https://codecrawler.merckel.dev` |
| `WEBHOOK_PUBLIC_URL` | `http://localhost:3001` | `https://codecrawler.merckel.dev` |
| `MOLLIE_API_KEY` | `test_REPLACE_ME` | test key pre-go-live; live key (`live_...`) at go-live |
| `MOLLIE_REDIRECT_URL` / `MOLLIE_WEBHOOK_URL` | localhost / placeholder | `https://codecrawler.merckel.dev/...` |
| `SMTP_*` | Mailpit (`127.0.0.1:1025`) | real transactional SMTP |
| `MAIL_FROM` | `...@codecrawler.local` | `...@codecrawler.merckel.dev` |

> **The DB/Redis hosts MUST be the compose service names (`db`, `redis`), not
> `localhost`.** Containers reach each other by service name on the compose
> network; `localhost` inside a container is the container itself. `api` and
> `worker` read `DATABASE_URL` / `REDIS_URL` from `.env` (via `env_file`), so
> getting these right in `.env` is mandatory. (`web` overrides `PORT=3001` from
> `.env` with `PORT=3000` in the compose file — SvelteKit serves on 3000, the API
> keeps 3001.)

Generate strong values for:

- `BETTER_AUTH_SECRET` — `openssl rand -base64 32`
- `TOKEN_ENCRYPTION_KEY` — AES-GCM key for BYOK/VCS tokens
  (`openssl rand -base64 32`). Rotating it invalidates all encrypted tokens.
- `OPENROUTER_API_KEY` — the platform/hosted metering key.
- `SNYK_TOKEN` + `SNYK_ORG_ID` — for the worker's Snyk CLI runs.
- GitHub App: `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `GH_APP_CLIENT_ID`,
  `GH_APP_CLIENT_SECRET`, `GH_WEBHOOK_SECRET` (plus `GITLAB_WEBHOOK_SECRET` /
  `GITEA_WEBHOOK_SECRET` when those providers are in use).
- `MOLLIE_API_KEY` — keep the **test** key until go-live, then switch to the
  **live** (`live_...`) key; no code change required.

### First deploy

```sh
git clone <repo> codecrawler && cd codecrawler      # or: git pull
cp .env.prod.example .env && $EDITOR .env           # fill secrets (see above)

podman compose -f docker-compose.prod.yml up -d --build
```

Caddy obtains its Let's Encrypt certificate on the first request to
`https://codecrawler.merckel.dev` (HTTP-01 challenge — DNS + ports 80/443 must be
ready first). Certs are stored in the `caddy_data` volume and renewed
automatically.

### Migrate & seed

Once `api` is up, apply Drizzle migrations and seed from the `api` container
(app images bundle the whole workspace, so `bun --filter` resolves):

```sh
podman compose -f docker-compose.prod.yml exec api bun --filter @codecrawler/db db:migrate
podman compose -f docker-compose.prod.yml exec api bun --filter @codecrawler/db db:seed
```

Verify health:

```sh
curl -fsS https://codecrawler.merckel.dev/api/health
podman compose -f docker-compose.prod.yml ps
```

### Backups

The only durable state is Postgres (volume `postgres-data`). Take a daily (or
more frequent) logical dump from cron on the VPS:

```sh
podman exec codecrawler-db pg_dump -U codecrawler -Fc codecrawler \
  | gzip > "/var/backups/codecrawler/codecrawler-$(date +%F).dump.gz"
```

Ship dumps off-box (S3, rsync to another host, …) and **test a restore**
(`pg_restore` into a fresh instance) before you need it. BullMQ job state in
Redis (`redis-data`) is ephemeral by design — no back-up needed.

### Updating

```sh
git pull
podman compose -f docker-compose.prod.yml up -d --build
podman compose -f docker-compose.prod.yml exec api bun --filter @codecrawler/db db:migrate
```

Caddy and the data volumes are untouched across rebuilds.

### Troubleshooting

- **Caddy can't get a certificate** → DNS not propagated, or port 80/443
  blocked. Check `podman logs codecrawler-caddy`.
- **`api` / `worker` can't reach the DB** → `DATABASE_URL` / `REDIS_URL` in
  `.env` still point at `localhost`. Re-edit and `podman compose ... up -d`.
- **502 from Caddy** → upstream container not ready/healthy. Run
  `podman compose -f docker-compose.prod.yml ps`, then
  `podman logs codecrawler-api` / `codecrawler-web`.

## Backups

Daily gzipped `pg_dump` of the prod Postgres DB, with last-N retention. The
scripts run `pg_dump` **inside the DB container**, so no password is ever
written to disk — set `BACKUP_MODE=host` only for managed Postgres.

```sh
# Backup (default output dir: /opt/codecrawler/backups, keep last 14)
scripts/backup-db.sh
scripts/backup-db.sh /mnt/backups          # custom output dir
DB_CONTAINER=codecrawler-db scripts/backup-db.sh   # explicit container

# Restore (DESTRUCTIVE — overwrites the DB)
scripts/restore-db.sh /opt/codecrawler/backups/codecrawler-20260101-020000.sql.gz
RESTORE_DROP_SCHEMA=1 scripts/restore-db.sh <file> # clean-slate overwrite
```

Cron (daily at 02:00 UTC, on the VPS):

```cron
0 2 * * * /opt/codecrawler/scripts/backup-db.sh >> /var/log/codecrawler-backup.log 2>&1
```

Recommended restore flow:

1. Stop writers: `podman compose -f docker-compose.prod.yml stop api worker`
2. `scripts/restore-db.sh <backup>` (use `RESTORE_DROP_SCHEMA=1` for a clean slate)
3. `bun run db:migrate` to reconcile migrations
4. `podman compose -f docker-compose.prod.yml up -d api worker`

Offsite copies: sync `/opt/codecrawler/backups` to object storage (e.g. an
S3 bucket or rsync.net) — the cron above can be followed by an `rclone copy`
step.

## Monitoring

- **Health endpoint** — `GET /api/health` returns `{"status":"ok","ts":...}`.
  `scripts/healthcheck.sh` wraps it for cron/UptimeRobot and exits non-zero on
  failure:

  ```cron
  */5 * * * * /opt/codecrawler/scripts/healthcheck.sh || \
    /usr/bin/mail -s "[CodeCrawler] health DOWN" ops@merckel.dev < /dev/null
  ```

  With **UptimeRobot**: add a "keyword" monitor on
  `https://codecrawler.merckel.dev/api/health` watching for `ok`.

- **Analytics** — Plausible is wired via `PUBLIC_PLAUSIBLE_DOMAIN` /
  `PUBLIC_PLAUSIBLE_SRC` in `.env.prod.example`; create a site in Plausible
  matching the domain.

- **Logs** — containers log to stdout/stderr:
  - API:      `podman logs -f codecrawler-api`
  - Worker:   `podman logs -f codecrawler-worker`
  - DB/Redis: `podman logs codecrawler-db`, `podman logs codecrawler-redis`

  For long-term retention, ship these to a log aggregator (Loki + Grafana
  Alloy / Vector / journald). No in-app logging service is bundled.

- **Queues** — BullMQ state lives in Redis; inspect failed/stuck jobs with
  `redis-cli` inside the `redis` container (`podman exec -it codecrawler-redis
  redis-cli`) or a Bull dashboard if you expose one.

## Operations

Common commands on the VPS (run from the deploy dir, e.g. `/opt/codecrawler`):

```sh
# Status / logs
podman compose -f docker-compose.prod.yml ps
podman compose -f docker-compose.prod.yml logs -f api
podman compose -f docker-compose.prod.yml logs -f worker

# Restart a service
podman compose -f docker-compose.prod.yml restart api worker

# Run / re-apply DB migrations
bun run db:migrate
# (or inside the api container)
podman compose -f docker-compose.prod.yml exec api bun --filter @codecrawler/db db:migrate

# Re-seed (destructive — dev/staging only)
bun run db:seed

# Inspect email in prod: SMTP goes to your real provider, not Mailpit.
# To preview mail in staging, point SMTP_* at a Mailpit instance and open :8025.

# Backup / restore — see "Backups" above.
```

**Secret rotation** (zero-downtime where possible):

- `BETTER_AUTH_SECRET` / `TOKEN_ENCRYPTION_KEY` — rotating these invalidates
  existing sessions and **cannot decrypt already-encrypted VCS tokens**; rotate
  only during maintenance and re-connect VCS providers afterward.
- `OPENROUTER_API_KEY` — generate a new key, update `.env`, restart
  `api`+`worker`; old key stays valid until you revoke it in the OpenRouter
  console.
- SAIA / team BYOK keys — rotated by each team in **Settings → API keys**
  (Verify after rotating). No server env change needed — SAIA is team-BYOK.
- `MOLLIE_API_KEY` — swap in the Mollie dashboard, update `.env`, restart;
  `SNYK_TOKEN` similarly via the Snyk dashboard.
- Webhook secrets (`GH_WEBHOOK_SECRET`, `GITLAB_WEBHOOK_SECRET`,
  `GITEA_WEBHOOK_SECRET`) — update the secret at the provider AND in `.env`,
  then restart; mismatches cause webhooks to be rejected (`status: ignored`).
- GitHub App credentials (`GH_APP_*`) — re-install the App and rotate the PEM;
  update `.env` and restart.

Apply any `.env` change with:
`podman compose -f docker-compose.prod.yml up -d --force-recreate api worker`.
