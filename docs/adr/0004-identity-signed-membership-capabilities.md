# ADR 0004: Identity-signed membership capabilities

## Status

Accepted (partial — see Enforcement scope + Deferred).

## Context

Membership and roles were the last unsigned trust boundary in the community
model. `community_members` / `channel_members` rows (and every role/status) were
plain server-asserted DB state — not one identity or device signature over any
membership claim. A compromised/coerced server could insert a row marking an
attacker as an active member (or a leader/moderator); an honest client would then
seal **K_meta** (all community + channel display metadata + avatars) or **K_channel**
(all group_key channel content) straight to the attacker's authenticated device —
because the "who is a member" device list came from the server, and the key-grant
paths authenticated a device's DeviceCert but never the *membership claim itself*.

The threat model is unchanged (ADR 0002/0003): the server is an honest-but-curious
relay that may be compromised/coerced — it must never see plaintext or keys — and
users may be persecuted Christians for whom an authz/crypto bug is catastrophic.

Constraint carried from ADR 0001: **mls-rs is read-only** — its
`GathernetIdentityProvider::validate_member` checks only cert internal consistency,
and the DeviceCert has no community/role field. So MLS *external-join* cannot be
refused at the protocol layer without a crate change (deferred M3 sub-credential
work). group_key channels have no MLS join (access = the K_channel grant), so they
are fully coverable at the app layer.

## Decision

Make membership + role **identity-anchored** so honest clients stop trusting the
server's word about who belongs.

### Capability artifact — device-signed, cert-chained, epoch-scoped

`cap = { communityId, scope: 'community' | <channelId>, subjectAccountId,
role: owner|leader|member|moderator, epoch, issuerDeviceId, issuerSig }`, where
`issuerSig = Ed25519(issuerDeviceKey, domain.membershipCap ‖ communityId ‖ scope ‖
subjectAccountId ‖ role ‖ u64(epoch))`. The account identity key is zeroized after
enrollment, so caps are signed by the always-live **device key** and cert-chained
to the account via `verifyDeviceCert` (the same pattern receipt keys + epoch-key
commitments already use). `role` and `scope` are bound into the signed tuple, so a
cap can't be replayed at another role/scope.

### Root of trust — invite-delivered, pinned (TOFU)

At `createCommunity` the owner's device signs a **community root** binding
`ownerAccountId ↔ communityId`. The invite fragment carries `ownerAccountId`
(same out-of-band channel K_meta uses); on first join a client **pins it under the
DMK** and rejects any later mismatch — defeating a server owner-swap/fork. A device
with no out-of-band owner (bare-code join, or a community predating this feature)
TOFU-pins the server-served root after verifying the owner's own device signed it.

### Delegation — depth-bounded

Owner → leader caps (**owner-signed only**) + member caps; a leader → member caps.
A member cap's issuer must be the owner or hold a valid owner-signed leader cap.
Leaders **cannot** mint leader caps → no privilege escalation. Verified by
recursively checking the issuer's own same-epoch cap, depth-bounded.

### Revocation — epoch-scoped, piggybacks rotation

Caps are re-issued each epoch by an authorized issuer (owner/leader) as the roster
is swept on community open. On removal, the existing K_meta rotation bumps the
epoch; the removed member gets no cap and no key at the new epoch. Revocation is
exactly as strong as the key rotation it reuses. (A signed Merkle roster — one sig
per epoch + inclusion proofs — is the more-scalable future alternative if cap
issuance ever outgrows the grant fan-out it rides on.)

All caps — community AND channel scope — live in the **single `community.keyEpoch`
namespace**. An adversarial review showed that anchoring channel caps to a separate
per-channel epoch both breaks the same-epoch delegation chain and makes them
unstorable/unfetchable through the epoch-pinned relay endpoints. One namespace keeps
the chain coherent and one freshness pin (below) covers it.

### Freshness — pin to the locally-held epoch (NOT the relay)

Signature-checking a cap is not enough: a compromised server can replay a
self-consistent **stale** chain (a removed member's cap + their issuer's cap, both
validly signed at an old epoch) to make an honest client seal the *current* key to
a reinjected device. So `verifyCapability` takes an `expectedEpoch` sourced from
**held key material** — the K_meta epoch this device actually holds, which is
monotonic + commitment-verified — never from the relay, and every link in the chain
must equal it. A grant sweep gates on the held current epoch (steady state) or the
outgoing epoch (during a rotation, whose caps still exist and whose removed member
is already out of the device list); a device's own other devices are exempt (sealing
my key to my device leaks nothing and must not block on a not-yet-issued cap).

### Enforcement scope (what is LANDED)

All three gates verify a recipient's/leaf's **community-scope** membership cap
chained to the pinned owner at the locally-held epoch — blocking a server-injected
*outsider*. Each is active only when an owner is pinned + a trusted epoch is held;
otherwise it degrades to legacy sealing (the same degradation bare-code K_meta
already accepts).

- **K_meta grant path (`buildGrants`):** a server-injected device (no owner-signed
  cap) is skipped and never receives the metadata key. The K_meta device list is
  fetched whole → the resolver is complete.
- **K_channel grant path (`buildChannelGrants`):** the same gate on the group_key
  channel-content key. The channel device list is *paged* (up to 100k), so the gate
  is built once per sweep (memoised resolver/fetcher) and a cap's issuer — which may
  fall on any page — is resolved via a single-device endpoint with a **bounded**
  fetch-on-miss (a compromised server can't amplify caps-with-bogus-issuers into
  unbounded round-trips).
- **MLS-channel overlay (detection + containment):** after a channel's engine
  catches up, every current MLS leaf's account must hold a valid cap; if any lacks
  one the channel is marked **untrusted** — composer disabled, `send` refuses — so
  no further plaintext reaches a server-injected leaf. App-layer *containment*, not
  protocol *prevention* (mls-rs is read-only); the check lives in the community-chat
  store, never in the shared `mls-sync` core (rooms unaffected).

The server relays caps + the root opaquely (POST `.../capabilities`, GET
`.../capabilities/mine`, GET `.../capabilities?scope=&account=`, GET
`.../devices/:deviceId`, POST `.../root`); it never mints or validates the Ed25519
chain, and pins stored caps to the community's current epoch.

## Consequences

- A compromised server can no longer make an honest client leak **K_meta** to an
  injected device, nor can it silently inject a reader into an MLS channel without
  the channel going untrusted + the composer locking.
- Liveness is unchanged from the existing "a manager must be online to grant the
  key" assumption: membership ⟺ holding the key, and caps ride the same grant sweep.
- Degradation is bounded + matches K_meta: a device with no pinned owner can't
  enforce (legacy trust), and a not-yet-issued member is topped up on the next
  authorized open.

## Deferred (explicit follow-ups)

- **Channel-scope caps (per-channel authorization) + the fetch-path
  minter-authority check.** All three landed gates verify *community* membership
  (block an outsider), not *which* member is authorized in *which* channel, and no
  gate verifies the epoch-commitment minter. A review confirmed the minter check has
  a sharp, non-self-healing hazard: a channel-moderator-minted rotation would be
  rejected by every fetcher until an owner/leader re-issues the moderator's cap, and
  because `rotationPending` self-clears on the successful CAS, `sendGroupKey` would
  silently fall back to the *old* epoch — readable by the removed member — defeating
  the rotation's forward secrecy and partitioning the channel. Landing it safely
  needs channel-scope caps anchored to the community epoch (so a mod holds stable
  authority) **and** a rotation re-mint that never falls back to a stale epoch. Until
  then, community-scope enforcement is the shipped protection.
- **Full MLS-join prevention** — the M3 mls-rs sub-credential work (a crate change);
  the overlay here is detection + containment only.
- **A signed Merkle roster** for very-large-community capability issuance.
- **Issuance authenticity.** Issuance sweeps the *server's* roster, so an
  owner/leader client re-attests whatever membership the server reports; capabilities
  raise the bar (an attacker needs the server to inject AND an honest issuer to
  sweep, or the issuer's device key) but do not by themselves bind issuance to an
  owner-witnessed join event. The freshness pin still fully blocks *stale/removed*
  cap replay.
- **Automated e2e capability + MLS-overlay journeys.** This milestone was validated
  by the server capability + single-device-lookup tests (relay, epoch + community
  pinning, membership gating) + full-workspace typecheck + the mls-sync suite; the
  multi-client Playwright journeys are follow-up (kept out for now given their
  flakiness).
