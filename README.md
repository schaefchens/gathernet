# Gathernet

Privacy-first Christian web platform: shared identity, friends, presence, and
end-to-end encrypted chat — the social layer for apps, games, churches, and
communities. Web-first; everything is a PWA.

## Repo layout

| Path | What |
|---|---|
| `apps/server` | Fastify + WebSocket API server and MLS delivery service |
| `apps/hub` | The Hub PWA (React + Vite) |
| `packages/shared` | Protocol + API schemas (zod), shared types |
| `packages/mls-client` | TypeScript facade over the MLS WASM module |
| `crates/mls-wasm` | Rust: mls-rs + client crypto, compiled to WASM |
| `docs/adr` | Architecture decision records |
| `e2e` | Playwright end-to-end tests |

## Prerequisites

- Node >= 22, [pnpm](https://pnpm.io) >= 10
- Docker (for Postgres)
- Rust via [rustup](https://rustup.rs) with the `wasm32-unknown-unknown`
  target, plus [`wasm-pack`](https://github.com/drager/wasm-pack)
  (only needed when building `crates/mls-wasm`)

## Development

```sh
pnpm install
docker compose up -d postgres   # dev database (host port 55432)
pnpm wasm:build                 # build the MLS WASM module once
pnpm dev                        # server (:4000) + hub (:5173)
```

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test        # unit + integration (integration spins Postgres via testcontainers)
pnpm --filter @gathernet/e2e e2e   # Playwright journey against the running dev stack
```

## Production-shaped stack

```sh
docker compose -f docker-compose.prod.yml up --build
# Hub + API on http://localhost:8080
E2E_BASE_URL=http://localhost:8080 pnpm --filter @gathernet/e2e e2e
```

## Key decisions

- Accounts are wallet-style: a BIP39 recovery phrase is the only root of
  identity. No email, phone, or password reset. See the product concept doc.
- Chat is end-to-end encrypted with MLS (RFC 9420) via `mls-rs` → WASM.
  See [ADR 0001](docs/adr/0001-mls-rs-for-production-e2ee.md).
- The server never sees plaintext or private keys; it stores public account
  data and relays ciphertext.
