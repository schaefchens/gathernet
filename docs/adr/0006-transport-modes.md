# ADR 0006: Transport modes — clearnet, your own Tor, ours

## Status

**DRAFT — not final, not accepted, nothing implemented.**

Records a design conversation (2026-08-07) so the reasoning survives the feature
phase. Decision-level: no schemas, no endpoints, no UI. **Mode 3 is gated on a
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
clearnet, their own Tor (Orbot, Tor Browser, a system VPN), or a Tor client we embed
in the app.

## Decision (proposed)

### 1. Three modes the user sees, two paths the code takes

With Orbot the app issues ordinary requests and the operating system routes them. The
app cannot detect this and must not pretend to. So mode 2 is mode 1 with different
copy and different features enabled — not a third transport.

| Mode | App behaviour | Who guarantees anonymity |
| --- | --- | --- |
| 1 · Clearnet | platform network | nobody |
| 2 · Your own Tor | platform network | the user's setup |
| 3 · Built-in Tor | our embedded client | us, and we must fail closed |

Building mode 2 as a real transport would be inventing work; building it as an honest
label is nearly free and still changes what we show and what we switch off.

### 2. One origin, transport swapped underneath

A transport the user can change is only possible if changing it does not change the
origin. Origin decides the storage bucket and, through it, the device enrollment —
so a per-mode origin makes "switch" mean "re-enroll and lose local history".

The app is therefore served from **one origin**, and the mode selects how its traffic
leaves the device.

Consequence worth stating plainly: **the `.onion` front door is a stopgap, not the
long-term shape.** It is a second origin by construction. It stays until mode 3 is
real, then it should go — or remain only as an entry point for people who must never
touch the clearnet at all (see Open questions).

### 3. Fail closed, without exception

If mode 3 cannot build a circuit — bridge blocked, network hostile, client wedged —
the app **stops**. It does not retry over the platform network, does not degrade, does
not time out into a direct connection.

This is the single worst failure available to this feature: a silent fallback hands
the real IP to precisely the person who set the toggle to prevent that. There is no
acceptable amount of it. Any code path that can reach the network must be behind the
transport, and the failure mode must be a visible stop, not a slow success.

Mode 2 cannot fail closed — we do not control the routing and cannot observe it. That
asymmetry must be visible to the user rather than smoothed over: mode 2 says "you are
responsible for this", mode 3 says "we are".

### 4. Switching applies forward, never backward

Enroll on clearnet, then switch to Tor: the server already holds that account against
an IP, and the same device key keeps proving it is the same person. The toggle
protects the next session. It cannot unsay what was already said.

So the switch is presented as "from now on", with that stated at the moment of
switching. A toggle that implies retroactive protection is worse than no toggle. The
clean case is choosing at **account creation**; switching later is a real feature but
a weaker one, and the UI must not flatten the difference.

### 5. Push lives outside the transport

Web Push is delivered by Apple/Google to the OS, not through our socket. No transport
setting can route it, so it discloses that a device exists regardless of the mode.

In mode 3 push is therefore **off**, and the user is told why rather than finding a
setting that silently does nothing. This interacts with already-shipped work
(content-free offline-fallback push) and needs settling as part of this, not after.

### 6. The server echoes the source IP it sees

Mode 2 users have no way to confirm their own setup works. The server already knows
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
- Every network-touching module has to route through one chokepoint for §3 to be
  enforceable. Worth auditing what currently reaches the network directly.
- Mode 3 makes the app responsible for anonymity claims. That is a materially bigger
  promise than "we relay ciphertext", and it should be advertised carefully.

## Open questions / not decided

- **Arti-in-WASM maturity.** Obvious base (the repo already builds Rust→wasm), but its
  browser story was experimental last checked. Needs verifying against current state,
  not assumed. **Gate for mode 3.**
- **Entry into the network.** Browsers cannot open raw TCP, so an embedded client needs
  a WebSocket or WebRTC pluggable transport. Those bridges are blockable and their
  operators see the connection. Unresolved, and it decides whether mode 3 is credible.
- **Cost on the device.** Circuit crypto in WASM on top of MLS, on an iPhone SE.
  Needs measuring before it is load-bearing.
- **WebSocket over the embedded client**, and the service-worker lifecycle around it —
  workers are killed aggressively, which sits badly with a long-lived circuit.
- **Does the `.onion` survive mode 3?** It is the only option that never touches the
  clearnet at all; mode 3 still fetches the app from a clearnet origin once, and that
  host learns an IP. A PWA cached after first load narrows this to the first visit
  rather than removing it. For the population that chose onion precisely so they are
  never seen reaching us, mode 3 is a downgrade — which argues for keeping it.
- **Granularity.** Global, or per account/persona? Per-account is more useful and much
  harder to enforce against §3.
- Whether mode is remembered per device or travels with the account (it should almost
  certainly stay local — syncing it would tell the server what the user chose).

## Sequencing

1. This ADR.
2. Modes 1 + 2 — preference, honest copy, §6 echo, push interaction. Cheap, and it
   locks the semantics and the chokepoint before mode 3 needs them.
3. Spike the mode 3 gates above. Only then commit to it.
4. Federation (ADR 0005), designed in a world where transport already exists.
