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

### Deferred hardening (recorded, not yet built)

1. **No K_meta rotation on member removal.** A removed member who cached K_meta
   could still decrypt directory metadata *if* they could fetch the ciphertext —
   but the server denies removed/left members. So directory forward-secrecy
   relies on server access control, not crypto. (Messages keep true MLS forward
   secrecy regardless.)
2. **No cross-device K_meta sync.** A device restored purely from the recovery
   phrase re-obtains K_meta from another active device or a fresh invite; it can
   still read channel messages (MLS external-join) meanwhile.

Both are addressed by the same future primitive: per-device ECIES
`community_key_grants` that seal K_meta to a device receipt key, enabling
rotation-on-removal and multi-device sync. Out of scope for Communities v2.
