# Gathernet Hub PWA — Rust builds the MLS wasm, Node builds the bundle,
# Caddy serves static files and reverse-proxies the API.
FROM rust:1-slim AS wasm
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown && cargo install wasm-pack --locked
WORKDIR /build
COPY crates crates
RUN cd crates/mls-wasm && wasm-pack build --target web --release \
  --out-dir /build/wasm-out --out-name mls_wasm

FROM node:22-slim AS web
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/mls-client/package.json packages/mls-client/
COPY apps/hub/package.json apps/hub/
RUN pnpm install --frozen-lockfile --filter @gathernet/hub...
COPY packages/shared packages/shared
COPY packages/mls-client packages/mls-client
COPY apps/hub apps/hub
COPY --from=wasm /build/wasm-out packages/mls-client/wasm
RUN pnpm --filter @gathernet/hub build

FROM caddy:2-alpine
COPY apps/hub/Caddyfile /etc/caddy/Caddyfile
COPY apps/hub/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh && mkdir -p /etc/caddy/conf.d
COPY --from=web /app/apps/hub/dist /srv
# 8080 plain (clearnet, behind a fronting proxy); 8443 the onion's TLS, added at start
# only when the tor container has minted a cert. See docs/onion.md.
EXPOSE 8080 8443
ENTRYPOINT ["/docker-entrypoint.sh"]
