FROM oven/bun:1-debian AS build
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.base.json biome.json ./
COPY apps/worker ./apps/worker
COPY packages ./packages
COPY . .

RUN bun install --frozen-lockfile


FROM oven/bun:1-debian AS runner
WORKDIR /app/apps/worker

COPY --from=build /app/package.json /app/bunfig.toml /app/tsconfig.base.json /app/biome.json /app/
COPY --from=build /app/node_modules /app/node_modules/
COPY --from=build /app/apps/worker /app/apps/worker/
COPY --from=build /app/packages /app/packages/

CMD ["bun", "src/index.ts"]
