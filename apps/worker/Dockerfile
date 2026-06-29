FROM oven/bun:1-debian AS build
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.base.json biome.json ./
COPY apps/worker ./apps/worker
COPY packages ./packages
COPY . .

RUN bun install --frozen-lockfile


FROM oven/bun:1-debian AS runner
WORKDIR /app/apps/worker

# git: materializePrCheckout does a shallow fetch of the PR ref into a tmpdir
# so the agentic reviewers get a real checkout. ripgrep: the read-only
# search_code tool and the repo-map builder shell out to `rg`. Both are
# runtime-only deps of the worker.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/bunfig.toml /app/tsconfig.base.json /app/biome.json /app/
COPY --from=build /app/node_modules /app/node_modules/
COPY --from=build /app/apps/worker /app/apps/worker/
COPY --from=build /app/packages /app/packages/

CMD ["bun", "src/index.ts"]
