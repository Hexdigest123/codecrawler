FROM oven/bun:1-debian AS build
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.base.json biome.json ./
COPY apps/web ./apps/web
COPY packages ./packages
COPY . .

RUN bun install --frozen-lockfile
RUN bun --filter @codecrawler/web build


FROM oven/bun:1-debian AS runner
WORKDIR /app

COPY --from=build /app/apps/web/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web/package.json ./package.json

ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000
CMD ["bun", "build/index.js"]
