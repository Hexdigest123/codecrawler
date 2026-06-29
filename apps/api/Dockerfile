FROM oven/bun:1-debian AS build
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.base.json biome.json ./
COPY apps/api ./apps/api
COPY packages ./packages
COPY . .

RUN bun install --frozen-lockfile


FROM oven/bun:1-debian AS runner
WORKDIR /app/apps/api

COPY --from=build /app/package.json /app/bunfig.toml /app/tsconfig.base.json /app/biome.json /app/
COPY --from=build /app/node_modules /app/node_modules/
COPY --from=build /app/apps/api /app/apps/api/
COPY --from=build /app/packages /app/packages/

ENV PORT=3001
ENV HOST=0.0.0.0

EXPOSE 3001
CMD ["bun", "src/index.ts"]
