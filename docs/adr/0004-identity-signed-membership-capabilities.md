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

### Enforcement scope (what is LANDED)

- **K_meta grant path (`buildGrants`):** before sealing K_meta to a device, the
  recipient's account must hold a valid membership cap chained to the pinned owner
  at the current epoch — so a server-injected device (no owner-signed cap) is
  skipped and never receives the metadata key. Active only when an owner is pinned;
  with no pin it falls back to legacy sealing (the same degradation bare-code K_meta
  already accepts). The K_meta device list is fetched whole → the resolver is
  complete → the chain verifies correctly.
- **MLS-channel overlay (detection + containment):** after a channel's engine
  catches up, every current MLS leaf's account must hold a valid membership cap
  chained to the pinned owner. If any leaf lacks one the channel is marked
  **untrusted** — the composer is disabled and `send` refuses — so no further
  plaintext reaches a server-injected leaf. This is app-layer *containment*, not
  protocol *prevention* (mls-rs is read-only). The check lives in the community-chat
  store, never in the shared `mls-sync` core (rooms unaffected).

The server relays caps + the root opaquely (POST `.../capabilities`, GET
`.../capabilities/mine`, GET `.../capabilities?scope=&account=`, POST `.../root`);
it never mints or validates the Ed25519 chain, and pins stored caps to the
community's current epoch.

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

- **K_channel (group_key content) recipient enforcement + channel-scope caps +
  fetch-path minter-authority checks.** The channel grant path pages the device
  list for 100k-member scale, so correct issuer-chain resolution across pages — and
  channel-moderator minter authority — need the roster/fan-out design noted above;
  landing them naively risks a liveness regression (a leader cap must be re-issued
  each epoch by the owner). The MLS overlay therefore currently verifies COMMUNITY
  membership (blocks an outsider), not per-channel authorization.
- **Full MLS-join prevention** — the M3 mls-rs sub-credential work (a crate change);
  the overlay here is detection + containment only.
- **A signed Merkle roster** for very-large-community capability issuance.
- **Automated e2e capability + MLS-overlay journeys.** This milestone was validated
  by the server capability-endpoint tests (relay, epoch + community pinning,
  membership gating) + full-workspace typecheck + the mls-sync suite; the multi-
  client Playwright journeys are follow-up (kept out for now given their flakiness).
