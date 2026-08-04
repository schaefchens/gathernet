# Tor onion service

Gathernet can be reached over a Tor **v3 hidden service** (`.onion`). This is part of the
product: for users who can't safely touch the clearnet, an onion address is
self-authenticating (the address *is* the service's public key), never uses an exit node,
and leaks no DNS or IP. The app already works over it unchanged — API and WebSocket calls
are same-origin and relative, and the hub loads no third-party resources.

## How it works

A small Tor container (`docker/tor`) runs a hidden service that forwards `onion:80` to the
app. It makes only **outbound** connections to the Tor network — no inbound ports are
published, so it adds no externally reachable surface.

- **Dev** (`docker-compose.yml`): forwards to the host-run dev server (`pnpm dev`, `:5173`)
  via `host.docker.internal`.
- **Prod** (`docker-compose.prod.yml`): forwards to the `web` container (`:8080`).

The onion **private key** lives in the `tordata` Docker volume. That key is the address, so
the address is **stable across restarts** (and shareable for testing) — and it must stay
secret. It is never committed; `.tor/` and `apps/hub/.onion-host` are gitignored.

## Dev setup (one time)

```sh
docker compose up -d tor            # build + start the hidden service
docker compose logs tor | grep onion   # prints: http://<addr>.onion
```

Copy the printed address into the file Vite reads (Vite's anti-DNS-rebinding guard 403s
Host headers it doesn't recognise), then start the dev server:

```sh
echo '<addr>.onion' > apps/hub/.onion-host
pnpm dev
```

Now open `http://<addr>.onion` in **Tor Browser**. The address stays the same on every
restart, so this file only needs setting once. (`ONION_HOST=<addr>.onion pnpm dev` also
works, but Turbo's strict env mode drops it unless declared — the file is simpler.)

The dev server now listens on `0.0.0.0` (`server.host: true` in `vite.config.ts`) so the
container can reach it; be aware it's also reachable on your LAN while `pnpm dev` runs.

## Prod

`docker compose -f docker-compose.prod.yml up --build` brings up `tor` alongside `web`.
Grab the address from `docker compose logs tor`. **Back up the `tordata` volume** — losing
it means a new, unshareable address. Optionally advertise the onion from the clearnet site
with an `Onion-Location` response header so Tor Browser offers it automatically.

## What does *not* work over onion (by design)

- **Web Push / PWA offline**: push needs a reachable push service and a service worker
  secure context; neither fits the anonymity model. Push is a clearnet-only fallback.
- Vite **HMR** over the onion may warn in the console — harmless; it's dev tooling only.

## Rotating the address

Stop the container and remove the volume: `docker compose down && docker volume rm
gathernet-dev_tordata`. Next `up` generates a fresh key + address.
