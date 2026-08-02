# ADR 0003: Group-key channels (mega-community scale)

## Status

Accepted (Mega-communities).

## Context

Communities must scale to 100k+ members. Until now a channel *was* an MLS group
(`groups.kind='channel'`, one leaf per device): strong per-message forward
secrecy, but external-commit joins are O(N²) and client group state is O(N), so
a channel tops out at low thousands of devices. Real mega-communities are not one
big group — they have one broadcast/announcement channel (a few writers, up to
~100k read-only members) plus discussion channels (hundreds up to ~10k active).

Channel messages already retain ≤30 days (`CHANNEL_MESSAGE_TTL_DAYS`, capped at
30). The threat model is unchanged (ADR 0002): the server is an honest-but-curious
relay that may be compromised/coerced — it must never see plaintext or keys —
and users may be persecuted Christians for whom an authz/crypto bug is
catastrophic.

## Decision

Channels gain an `encryptionMode`: **`mls`** (default) or **`group_key`**. DMs and
rooms are always MLS.

- **`mls`** — unchanged. Full per-message forward secrecy, self-healing PCS,
  intrinsic sender authenticity, *immediate* cryptographic removal. Capped at
  `MLS_CHANNEL_MAX_DEVICES` (128). The recommended default for small/sensitive
  channels; it is never auto-downgraded.
- **`group_key`** — no MLS group. A per-channel content key **`K_channel`**
  (epoch'd) encrypts messages with XChaCha20-Poly1305. Distributed exactly like
  K_meta — sealed per-device to the authenticated ECIES **receipt key** — but
  minted only by a bounded **granter set** (channel moderators / community
  leaders), lazily as members join, and never seen by the server. Two shapes by
  `postPolicy`: broadcast (moderators-post, ≤100k) and discussion (everyone-post,
  ≤10k).

### Signed message envelope

A shared content key alone only proves "written by *some* key-holder" — so every
message carries a mandatory **Ed25519 sender signature**, restoring the sender
authenticity MLS gives for free. The opaque payload (base64 JSON) is
`{ epoch, senderDeviceId, senderSeq, prevSenderHash, ts, ct, sig }`. `communityId`
and `channelId` are NOT transmitted — the receiver supplies them from context when
reconstructing the AAD/signature, so a cross-channel replay fails verification.

- `ct = seal(K_channel[epoch], plaintext, AAD)`, `AAD = domain ‖ communityId ‖
  channelId ‖ epoch ‖ senderDeviceId ‖ senderSeq`.
- `sig = Ed25519(senderDeviceKey, domain ‖ communityId ‖ channelId ‖ epoch ‖
  senderDeviceId ‖ senderSeq ‖ prevSenderHash ‖ ts ‖ SHA256(ct))`.
- **Receive:** resolve the sender's DeviceCert (from the community member-device
  list) and verify it under its account identity; check `senderDeviceId ==
  SHA256(devicePk)[:16]`; verify `sig` under `devicePk`; open `ct` under
  `K_channel[epoch]`; dedup by monotonic `senderSeq`. The server's `senderDevice`
  field is never trusted. The `senderSeq`/`prevSenderHash` chain gives per-sender
  replay/reorder detection (cross-sender total order stays unauthenticated —
  inherent to a group key).

### Key distribution + epoch commitment

Grants live in `channel_key_grants` (mirror of `community_key_grants`), sealed to
member receipt keys and stored ciphertext-only. Each epoch also has an
authenticated commitment in `channel_key_epochs`: `SHA256(channelId ‖ epoch ‖
K_channel)` signed by the minter device. A grantee recomputes the commitment from
its opened key and verifies the minter signature (bound to this channel+epoch) —
detecting a server substituting another channel's key, or a malicious member
handing divergent keys (partition). One commitment row per epoch (server-enforced).

Join is a plain `channel_members` activation + a grant fetch — no external commit,
no GroupInfo, no leaves, no welcomes. Delivery reuses the existing `mls_messages`
mailbox + cursors; `postMessage` authorises the sender via `channel_members`
(not MLS leaves), skips the MLS epoch ratchet, and enumerates recipients outside
the write lock. Member caps are enforced at activation.

### Rotation

Rotation mints a new `K_channel` epoch; **messages are NOT re-encrypted** — old
messages stay under their old epoch and expire by TTL, so old-epoch grants are
kept (a restoring member reads un-expired history; a removed member is denied by
access control). A compare-and-set on the channel `keyEpoch` serialises rotations.

- **Discussion** channels rotate on member removal/leave (the writer set = reader
  set): a durable `rotationPending` flag + a manager-client rotation (eager on the
  WS nudge, backstopped by a connect-time sweep) — mirroring K_meta Phase B.
- **Broadcast** channels rotate on writer-set change + a periodic schedule; reader
  removal takes effect at the next scheduled rotation (a full 100k reseal per
  removal is infeasible — ~200k ECIES seals). An on-demand rotation ejects a
  hostile actor immediately.

## Consequences

**Preserved:** message confidentiality vs an honest-but-curious,
key-substitution-resistant server. **Added (no regression vs MLS):** per-message
sender authenticity via the signature; grant context-binding via the signed epoch
commitment.

**Accepted trade-offs (group_key channels only):**
- No per-message forward secrecy *within* an epoch — a compromised device exposes
  that epoch's messages (bounded by the ≤30-day TTL and periodic rotation).
- Removed-reader window (broadcast, vs a *compromised* server): a removed reader
  keeps the epoch key until the next scheduled rotation. Server access control
  denies them immediately regardless. Guidance: **truly sensitive content does not
  belong in a 100k broadcast** — keep it in a small MLS channel.

**Pre-existing boundary (NOT introduced or fixed here):** membership/role
authorization trusts server-asserted rows (`channel_members`, roles) — a
compromised server could designate an attacker as a member/mod and have an honest
granter seal `K_channel` to them. This is already true of today's MLS channels
(external-commit join is gated only by server GroupInfo release) and of K_meta
grants. Closing it needs identity-signed membership/role capabilities — a
cross-cutting hardening milestone. Small/sensitive coordination stays on MLS,
where the trust surface is smallest and removal is cryptographically immediate.

### Scalable fan-out (implemented)

group_key channels do **not** push ciphertext to every member. A socket that has
a channel open sends `channel.subscribe {channelId}` (WS); the server verifies
active membership and tracks the subscription in the connection registry. On a
post, the WS handler sends a tiny `channel.updated {channelId, seq}` nudge to the
channel's subscribers only — O(open viewers), never O(members) — and each client
pulls the ciphertext from the existing mailbox. So a broadcast to 100k readers is
one small nudge per *currently-viewing* socket, not 100k ciphertext copies, and
`postMessage` does no per-member enumeration under the write lock. Subscriptions
are cleaned up on disconnect and re-established on reconnect; the mls path keeps
its per-leaf push unchanged. The registry's subscription set is the seam a
multi-node bus later replaces with topic subscriptions.

**Deferred:** a multi-node fan-out bus (this node-local subscription registry is
the single-node form). Also deferred: the K_meta grant context-binding retrofit
(K_meta grants still lack the epoch commitment K_channel has); large-community
K_meta grant fan-out (>500 devices, per ADR 0002). No crypto library was changed
— the scheme composes the existing `seal`/`open`, `ed25519Sign`/`ed25519Verify`,
`decodeDeviceCert`, and ECIES primitives (see the never-modify-crypto-libraries
constraint).
