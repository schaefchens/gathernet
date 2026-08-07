# ADR 0006: Transport modes — clearnet, your own Tor, ours

## Status

**DRAFT — not final, not accepted, nothing implemented.**

Records a design conversation (2026-08-07) so the reasoning survives the feature
phase. Decision-level: no schemas, no endpoints, no UI. **Mode B is gated on a
feasibility spike** (see Open questions) — the rest does not depend on it.

Sequencing: **before ADR 0005 (federation).** Federation multiplies the number of
servers that learn a user's IP, so building it first means building the exposure and
retrofitting the privacy. It is also already gated behind ADR 0004 enforcement, while
the problem below is live in shipped code.

## Context

Reaching Gathernet over Tor is a product feature, not an ops nicety (see
`docs/onion.md`, ADR 0005's threat framing). Today it is a **second origin**: the app
answers on both a clearnet host and a `.onion`.

That split has a hard edge we hit on 2026-08-07. WebKit does not implement the
"`.onion` is a potentially trustworthy origin" rule that Chromium and Tor Browser do,
and on iOS every browser is WebKit because Apple requires it. Over plain HTTP an
iPhone therefore has no secure context and no `crypto.subtle` — and device enrollment
mints its receipt keypair with `crypto.subtle.generateKey`, so **creating an account
and restoring a passphrase both failed** on iOS over the onion.

The stopgap shipped that day (onion also answers `:443`, private name-constrained CA,
install the anchor to silence the warning) makes iOS work. It does not fix the shape:
`http://x.onion`, `https://x.onion` and the clearnet host are **three different
origins**, with separate storage and separate device enrollments. A user cannot move
between them; they can only enroll again.

The desired product behaviour is a **choice the user makes and can change later**:
the platform network (plain, or with their own Orbot / Tor Browser / system VPN in
front of it), or a Tor client we embed in the app.

## Decision (proposed)

### 1. Two modes, and we recommend the one we did not write

There are **two** transports. Running Orbot or Tor Browser is not a third: the app
issues ordinary requests and the operating system routes them, exactly as on clearnet.
The app cannot detect the difference and must not pretend to.

| Mode | App behaviour | Who guarantees anonymity |
| --- | --- | --- |
| A · Platform network | ordinary requests | nobody, or the user's own Tor if they run one |
| B · Built-in Tor | our embedded client | us, and we must fail closed |

**Where the user wants anonymity, mode A with their own Tor is the recommendation, and
the app should say so.** Not false modesty — it is better on every axis that matters:

- Tor Browser and Orbot are mature and audited; an embedded WASM client would be young
  code we maintain alone.
- They cover the whole device — DNS, background traffic, every other app — where ours
  covers one page.
- They are not inside a browser sandbox, so they get real guards and real pluggable
  transports instead of whatever a WebSocket bridge can imitate.
- They do not depend on us getting §4 right.

Mode B exists for people who cannot install anything — a locked-down phone, a borrowed
device, a jurisdiction where installing Tor is itself the risk. That is a real
population and worth serving. It is not the better option, and presenting it as the
"more private" choice because it is ours would be a lie the user cannot check.

### 2. One origin, transport swapped underneath

A transport the user can change is only possible if changing it does not change the
origin. Origin decides the storage bucket and, through it, the device enrollment —
so a per-mode origin makes "switch" mean "re-enroll and lose local history".

The app is therefore served from **one origin**, and the mode selects how its traffic
leaves the device.

Consequence worth stating plainly: **the `.onion` front door is a stopgap, not the
long-term shape.** It is a second origin by construction. It stays until mode B is
real, then it should go — or remain only as an entry point for people who must never
touch the clearnet at all (see Open questions).

### 3. The chokepoint is the app, the enforcement is CSP — not the service worker

The obvious idea is to let the service worker intercept everything and route it. It
cannot: **a service worker does not see WebSockets.** `fetch`, XHR, navigations and
subresources fire its `fetch` event; `new WebSocket` bypasses it completely — and that
is the entire realtime path. It also cannot intercept its own update fetches or push,
and it is killed after seconds of idleness, which is a poor home for a client holding
warm circuits.

It does not need to. Measured 2026-08-07, the app's whole network surface is **two
files**: three `fetch` calls in `lib/api.ts` and one `new WebSocket` in
`lib/ws-client.ts`. Nothing else in the hub touches the network, and the hub loads no
third-party origins. Routing those two through the embedded client is the chokepoint,
in ordinary app code, where it can be read and tested.

The service worker's real job here is **enforcement**. `connect-src` covers
WebSocket where a service worker does not, and the worker serves the precached shell,
so it can hand the navigation a mode-specific CSP. In mode B that policy permits the
bridge and **forbids our own origin** — so a missed code path, a future call site, or
a plain bug cannot reach the server directly. The browser refuses it.

That is the difference between fail-closed as an intention and fail-closed as a
property. §4 says what must never happen; this is what makes it unable to happen.

### 4. Fail closed, without exception

If mode B cannot build a circuit — bridge blocked, network hostile, client wedged —
the app **stops**. It does not retry over the platform network, does not degrade, does
not time out into a direct connection.

This is the single worst failure available to this feature: a silent fallback hands
the real IP to precisely the person who set the toggle to prevent that. There is no
acceptable amount of it. Any code path that can reach the network must be behind the
transport, and the failure mode must be a visible stop, not a slow success.

Mode A cannot fail closed — we do not control the routing and cannot observe it. That
asymmetry must be visible to the user rather than smoothed over: mode A says "you are
responsible for this", mode B says "we are".

### 5. Switching applies forward, never backward

Enroll on clearnet, then switch to Tor: the server already holds that account against
an IP, and the same device key keeps proving it is the same person. The toggle
protects the next session. It cannot unsay what was already said.

So the switch is presented as "from now on", with that stated at the moment of
switching. A toggle that implies retroactive protection is worse than no toggle. The
clean case is choosing at **account creation**; switching later is a real feature but
a weaker one, and the UI must not flatten the difference.

### 6. Push lives outside the transport

Web Push is delivered by Apple/Google to the OS, not through our socket. No transport
setting can route it, so it discloses that a device exists regardless of the mode.

In mode B push is therefore **off**, and the user is told why rather than finding a
setting that silently does nothing. This interacts with already-shipped work
(content-free offline-fallback push) and needs settling as part of this, not after.

### 7. The server echoes the source IP it sees

Mode A users have no way to confirm their own setup works. The server already knows
the source address of every request, so reporting it back to the client leaks nothing
new and no third party is involved. It turns "I think Orbot is on" into something
checkable.

Deliberately not a third-party check service: that would hand a new party the very
address the user is trying to protect.

## Consequences

- The clearnet/`.onion` origin split becomes technical debt with a scheduled end,
  rather than the architecture. Anything built on "the onion is a separate origin"
  should expect to be removed.
- Storage and enrollment layout must not acquire per-mode assumptions in the
  meantime — this is the part that is painful to unwind later, and the reason to
  settle the ADR before more of either is built.
- The chokepoint already effectively exists (§3): `lib/api.ts` and `lib/ws-client.ts`
  are the only things in the hub that touch the network. Keeping it that way is a
  standing constraint, not a one-off audit — a fourth call site added later silently
  weakens §4.
- Mode B makes the app responsible for anonymity claims. That is a materially bigger
  promise than "we relay ciphertext", and it should be advertised carefully.

## Open questions / not decided

- **Arti-in-WASM maturity.** Obvious base (the repo already builds Rust→wasm), but its
  browser story was experimental last checked. Needs verifying against current state,
  not assumed. **Gate for mode B.**
- **Entry into the network.** Browsers cannot open raw TCP, so an embedded client needs
  a WebSocket or WebRTC pluggable transport. Those bridges are blockable and their
  operators see the connection. Unresolved, and it decides whether mode B is credible.
- **Cost on the device.** Circuit crypto in WASM on top of MLS, on an iPhone SE.
  Needs measuring before it is load-bearing.
- **WebSocket over the embedded client**, and the service-worker lifecycle around it —
  workers are killed aggressively, which sits badly with a long-lived circuit.
- **Does the `.onion` survive mode B?** It is the only option that never touches the
  clearnet at all; mode B still fetches the app from a clearnet origin once, and that
  host learns an IP. A PWA cached after first load narrows this to the first visit
  rather than removing it. For the population that chose onion precisely so they are
  never seen reaching us, mode B is a downgrade — which argues for keeping it.
- **Granularity.** Global, or per account/persona? Per-account is more useful and much
  harder to enforce against §4.
- Whether mode is remembered per device or travels with the account (it should almost
  certainly stay local — syncing it would tell the server what the user chose).

## Sequencing

1. This ADR.
2. Mode A — preference, honest copy recommending the user's own Tor, the §7 IP echo,
   and the push interaction. Cheap, and it locks the semantics and the chokepoint
   before mode B needs them.
3. Spike the mode B gates above. Only then commit to it.
4. Federation (ADR 0005), designed in a world where transport already exists.
