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

Now open `http://<addr>.onion` in **Tor Browser** (or `https://<addr>.onion` from an
iPhone — see "HTTPS on the onion" below). The address stays the same on every
restart, so this file only needs setting once. (`ONION_HOST=<addr>.onion pnpm dev` also
works, but Turbo's strict env mode drops it unless declared — the file is simpler.)

The dev server now listens on `0.0.0.0` (`server.host: true` in `vite.config.ts`) so the
container can reach it; be aware it's also reachable on your LAN while `pnpm dev` runs.

## Prod

`docker compose -f docker-compose.prod.yml up --build` brings up `tor` alongside `web`.
Grab the address from `docker compose logs tor`. **Back up the `tordata` volume** — losing
it means a new, unshareable address.

**Advertise the onion (`Onion-Location`).** Set `ONION_HOST` to the printed address and the
`web` (Caddy) container adds an `Onion-Location` header to app responses, so Tor Browser
shows the ".onion available" button on the clearnet site:

```sh
ONION_HOST=<addr>.onion docker compose -f docker-compose.prod.yml up -d web
```

The header is only emitted when `ONION_HOST` is set (clearnet-only deploys send nothing),
and Tor Browser only honours it over **HTTPS** — so the clearnet site must be behind a
TLS-terminating proxy (the Caddyfile itself runs with `auto_https off` on :8080).

## HTTPS on the onion (required for iOS)

The hidden service answers on **both** `:80` and `:443`.

`:443` exists because of WebKit. Chromium and Tor Browser implement the "`.onion` is a
potentially trustworthy origin" rule, so `http://<addr>.onion` is a **secure context**
there and `crypto.subtle` works. WebKit never implemented it — and on iOS *every* browser
is WebKit, Brave and Firefox included, because Apple requires it. Over plain HTTP an
iPhone therefore gets `isSecureContext === false` and no `crypto.subtle`, and the app
cannot enroll a device at all: `buildEnrollment` generates the receipt keypair with
`crypto.subtle.generateKey`, so creating an account and restoring a passphrase both fail
right after the unlock-password step, with a generic error.

`:80` stays because the default cert is **self-signed**. Browsers refuse to register a
service worker on an origin with a certificate error, so moving everyone to `:443` would
take Web Push away from the Chromium users who work today. Two ports, no regression.
Note the two are separate origins (`http://x.onion` and `https://x.onion` do not share
storage), so a device enrolled on one is not enrolled on the other.

The cert is minted by the **tor** container — the only one that knows the address before
it exists — into the `onioncerts` volume, and read by whatever terminates TLS (`web` in
prod, the `onion-tls` sidecar in dev, which keeps `pnpm dev` on plain HTTP so the normal
dev loop is untouched). It is issued for 10 years on purpose: iOS pins an accepted
exception to the certificate, and a cert that rotated would re-prompt every time.

### Getting rid of the certificate warning

Out of the box the chain is private, so the first visit warns. Tapping through works, but
teaching at-risk users to click past TLS warnings is a bad habit — and a bypassed cert
error also costs the origin its service worker. Two ways to make the warning go away.

**Install the CA on the device (free, works today).** Copy the anchor out and get it onto
the phone — AirDrop is easiest:

```sh
docker compose cp tor:/certs/onion-ca.crt ./onion-ca.crt   # public cert, not a secret
```

On iOS: open it → **Settings → General → VPN & Device Management** → install the profile →
then **Settings → General → About → Certificate Trust Settings** and switch on full trust
for "Gathernet onion CA". That second step is the one everyone forgets; without it the
profile is installed but not trusted. Brave and every other iOS browser use the system
trust store, so this covers all of them.

The CA is **name-constrained** (`permitted;DNS:<addr>.onion`), so it can only ever vouch
for this one address. That matters: installing a root normally hands the device a key that
can impersonate any site, and this key lives on a server. Constrained, a leak still only
buys an attacker this onion. Keep `onion-ca.key` as private as the onion key itself — both
live in volumes you should not expose.

**Or buy a CA-issued cert.** Set `ONION_TLS_MANAGED=0` on the `tor` service and drop your
own `onion.crt` (leaf + chain) and `onion.key` into the `onioncerts` volume; nothing here
will touch them. No install step for anyone, and `:443` then becomes good enough for every
client, so `:80` and the `Onion-Location` header could both move to HTTPS.

**Let's Encrypt cannot do this.** `.onion` is a reserved special-use name (RFC 7686), not
in public DNS — so neither HTTP-01 nor DNS-01 validation can reach it, and Let's Encrypt
issues only for publicly resolvable names. Under the CA/Browser Forum rules `.onion` needs
its own validation method (proving control of the onion key), which historically was
permitted only for EV certificates. HARICA is the CA that issues them; check their current
terms and pricing.

### Reissuing

The leaf lasts 397 days (Apple rejects TLS server certificates valid for more than 398,
and refuses any leaf without `extendedKeyUsage=serverAuth` or with `CA:TRUE` — a plain
`openssl req -x509` cert has none of that right). The `tor` entrypoint reissues
automatically once it is within 30 days of expiry, reusing the CA, so **installed devices
keep working without reinstalling anything**.

Caddy reads the cert once at startup and does not watch the file, so restart the
terminator after a reissue — `docker compose restart onion-tls` in dev, `web` in prod.

## What does *not* work over onion (by design)

- **Web Push / PWA offline**: push needs a reachable push service and a service worker
  secure context; neither fits the anonymity model. Push is a clearnet-only fallback.
- Vite **HMR** over the onion may warn in the console — harmless; it's dev tooling only.

## Rotating the address

Stop the container and remove the volume: `docker compose down && docker volume rm
gathernet-dev_tordata`. Next `up` generates a fresh key + address.
