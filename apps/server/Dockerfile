# Gathernet API server — Node only; the server never touches MLS/WASM.
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod --filter @gathernet/server...

FROM node:22-slim
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=deps /app ./
COPY packages/shared packages/shared
COPY apps/server apps/server
USER node
EXPOSE 4000
CMD ["pnpm", "--filter", "@gathernet/server", "start"]
