# ADR 0002: Community metadata encryption (K_meta)

## Status

Accepted (Communities v2).

## Context

Communities are invite-only groups that contain multiple joinable E2EE
channels. Beyond the message ciphertext (already MLS-encrypted per channel),
communities carry *display metadata*: community name/description/avatar, and
per-channel title, emoji, markdown description, and avatar. They also carry
directory structure (which channels exist, their visibility, join policy,
access level, and disappearing-message TTL).

Gathernet's threat model treats the server as an honest-but-curious relay that
must "know as little as possible" — users may be persecuted Christians in
hostile environments. Channel *messages* already have true MLS forward secrecy.
But if the server stored channel titles and community names in plaintext, it
would learn the social graph and topic structure of every community — exactly
the metadata an adversary who seizes the server wants.

There is a tension: members browsing a community must *discover* its channels
and read their titles, yet non-members and the server must learn nothing. The
resolution is that **the community itself is the trust boundary** — there are
no "public" channels; everyone who can see channel metadata is already an
invited member.

## Decision

All community + channel **display metadata** is encrypted client-side under a
per-community 32-byte key, **K_meta**, which the server never sees.

- **Storage**: the server stores opaque `metaCiphertext` blobs
  (`seal(K_meta, json)` with XChaCha20-Poly1305 via the existing WASM crypto)
  and encrypted avatar images in a `community_media` table. It serves ciphertext
  to eligible members and decrypts nothing.
- **Distribution — out-of-band via the invite**, reusing the M2 app-grant
  QR/link pattern. The invite payload is
  `gathernet:community:<code>#<K_meta_b64url>`. Only `<code>` is sent to the
  server (it validates the invite row); `<K_meta>` rides in the URL **fragment**,
  which never leaves the client. On accept, the joiner persists K_meta locally,
  sealed under the Device Master Key via `secureStore`, keyed by communityId.
- **What stays plaintext server-side** (operational necessity, not display
  data): role/status rows, channel `access`/`visibility`/`joinPolicy`,
  `messageTtlDays` (the server prunes ciphertext on this schedule), invite codes,
  and membership/moderator state used for authorization.

Channel *messages* remain independently MLS-encrypted; K_meta covers only
directory metadata and avatars.

## Consequences

- The server cannot read community/channel names, descriptions, or avatars.
  Directory confidentiality against the server holds as long as K_meta stays
  off the server, which the fragment-based distribution guarantees.
- A member who joins by **manually typing the 10-char code** (no fragment)
  receives no K_meta: they can still join and read/write channel *messages*,
  but metadata renders as placeholders until they obtain K_meta from a fresh
  invite link or another device. This is an accepted UX degradation, mirroring
  the app-grant manual-vs-QR split.

### Hardening

**Cross-device K_meta sync — IMPLEMENTED (Phase A).** Each device holds a
persistent ECIES **receipt keypair** (`packages/shared/src/ecies.ts`,
extractable P-256; private key sealed under the DMK in `DeviceRecord`). K_meta
is sealed to a device's receipt key and stored server-side as an opaque
`community_key_grants` row; the server only relays ciphertext. A device that
lacks K_meta (restored from the phrase, or joined by a bare code) fetches and
opens its grant. **No crypto-library change:** the receipt key is authenticated
by the device's existing Ed25519 key — `receiptPkSig = Ed25519(deviceKey,
domain‖receiptPk)` — reusing the shipped identity→DeviceCert→devicePk chain, so
an honest-but-curious server cannot substitute a receipt key. Verification
reuses the already-exposed `ed25519Verify` + `decodeDeviceCert`; the DeviceCert
format is untouched. Grants are demand-driven and rate-friendly (WS events and
list views only *fetch*; sealing to others happens on an explicit community
open, guarded by an in-memory `grantedTo` cache).

**Rotation on member removal — IMPLEMENTED (Phase B).** Removing a member (or a
member leaving) flags the community `rotationPending` and nudges remaining
leaders (`community.rotation_needed`). A leader processes it three ways: on the
live WS nudge, on opening the community, and on **WS (re)connect** — a
connect-time sweep (`GET /communities` → rotate any pending community where the
account is a leader). So a *removal* rotates immediately (the acting leader is
online), and a *voluntary leave* rotates as soon as any leader device is simply
connected to Gathernet — no need to open the community. A leader's client then
mints a new K_meta,
re-encrypts every community/channel `metaCiphertext` and re-seals avatar media
under it, and posts all of it in one `POST /communities/:id/rotate` request. The
server applies it atomically with a **compare-and-set on `keyEpoch`** (concurrent
rotations lose → 409 and pick up the winner's key), swaps in the ciphertext,
deletes stale-epoch grants, and installs new-epoch grants for the still-active
member devices only (never the removed member). The server still sees only
ciphertext — never the old or new K_meta.

After rotation, a removed member's cached K_meta is cryptographically useless: it
cannot decrypt new-epoch metadata, and they receive no new grant (and remain
denied by access control). Remaining members re-key by fetching their new-epoch
grant (K_meta is stored per-epoch client-side; the invite fragment now carries
`<epoch>.<key>` so a joiner detects staleness). Messages keep MLS forward secrecy
independently. Migration 0010 (`communities.rotationPending`).

**Grant context-binding (authenticated epoch commitment) — IMPLEMENTED (migration
0012).** An ECIES seal to a device's *public* receipt key carries no authenticity
over *which* key was sealed, so a grant blob alone let a compromised relay feed
one community's K_meta grant as another's (a partition/DoS, since the metadata
stays sealed under the real key). Each epoch now has an authenticated commitment
in `community_key_epochs` — `SHA256(communityId ‖ epoch ‖ K_meta)`, signed by the
minting leader device (`minterSig` over the domain-separated commitment). A
fetcher recomputes the commitment from its opened K_meta and verifies the
`minterSig` (bound to this community + epoch) against the minter's DeviceCert,
resolved from the member-device list — REQUIRED for the key to be trusted. This
mirrors the K_channel epoch commitment (ADR 0003); grants are published with the
commitment (cross-device sync + rotation), and stale-epoch commitments are dropped
on rotation alongside stale grants. The invite-fragment distribution path is
unchanged (K_meta is trusted out-of-band there, not via a grant).

**Deferred:** rotation currently re-seals avatar image bytes; an optimization
(wrap a per-media key inside the K_meta-sealed metadata so only small blobs are
re-sealed) is noted but unbuilt. Large-community grant fan-out (>~300 devices)
also remains future work.
