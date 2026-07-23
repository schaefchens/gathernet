export const PROTOCOL_VERSION = 1

/** Client must send `hello` within this window after the socket opens. */
export const HELLO_TIMEOUT_MS = 10_000
/** Server-side WS protocol pings. */
export const WS_PING_INTERVAL_MS = 25_000
/** Client reconnect backoff bounds (jittered exponential). */
export const RECONNECT_MIN_MS = 1_000
export const RECONNECT_MAX_MS = 30_000
/** Per-message ack timeout on the client. */
export const REQUEST_TIMEOUT_MS = 15_000

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const INVITE_CODE_LENGTH = 10

/**
 * Communities v2. Channel display metadata (title/emoji/markdown-description)
 * and community/channel avatars are sealed under a per-community 32-byte
 * K_meta the server never sees; it stores/serves only ciphertext. K_meta rides
 * out-of-band in the invite payload fragment (`gathernet:community:<code>#<k>`).
 */
export const COMMUNITY_QR_PREFIX = 'gathernet:community:'
/** Encrypted avatar ciphertext cap (server rejects larger blobs). */
export const COMMUNITY_MEDIA_MAX_BYTES = 350 * 1024
/** Allowed disappearing-message windows (days); 1 == 24h. */
export const CHANNEL_MESSAGE_TTL_DAYS = [1, 3, 7, 14, 30] as const
export const CHANNEL_MESSAGE_TTL_DEFAULT_DAYS = 30
/** Sealed metadata blob cap (title+emoji+markdown description, base64). */
export const COMMUNITY_META_MAX_B64 = 8192

/**
 * Channel scaling caps. 'mls' channels stay small (one MLS leaf per device,
 * O(N) client state); 'group_key' channels scale via a shared K_channel.
 * Broadcast (moderators-post) tolerates far more readers than discussion
 * (everyone-post), which must rotate K_channel on removal.
 */
export const MLS_CHANNEL_MAX_DEVICES = 128
export const GROUP_KEY_DISCUSSION_MAX_MEMBERS = 10_000
export const GROUP_KEY_BROADCAST_MAX_MEMBERS = 100_000
/** Max K_channel grants per POST; the client loops to cover larger channels. */
export const CHANNEL_KEY_GRANT_BATCH_MAX = 1000
/** Roster page size for paginated community/channel member listings. */
export const COMMUNITY_MEMBER_PAGE_SIZE = 100

/** MLS key package pool per device. */
export const KEY_PACKAGE_TARGET = 50
export const KEY_PACKAGE_REPLENISH_BELOW = 20
export const KEY_PACKAGE_TTL_DAYS = 90

/** Ciphertext mailbox retention when devices never ack. */
export const MAILBOX_RETENTION_DAYS = 30

/** App platform scopes (grants = consent + scoped key material). */
export const APP_SCOPES = ['identity', 'storage', 'rooms', 'friends:invite'] as const
export type AppScope = (typeof APP_SCOPES)[number]

/** Device-flow grant codes. */
export const GRANT_CODE_TTL_MS = 5 * 60 * 1000
export const GRANT_QR_PREFIX = 'gathernet:grant:'

/** App token: `gna.` + base64url(32 bytes); device token: `gn.` + base64url(32 bytes). */
export const APP_SESSION_TTL_DAYS = 14

/** Encrypted app storage quotas (ciphertext). */
export const APP_STORAGE_MAX_KEYS = 100
export const APP_STORAGE_MAX_VALUE_BYTES = 64 * 1024

/** Rooms. */
export const ROOM_CODE_ALPHABET = '23456789ACDEFGHJKMNPQRTVWXYZ'
export const ROOM_MAX_DEVICES = 16
export const ROOM_MAX_MEMBERS = 16
export const ROOM_INACTIVE_EXPIRE_DAYS = 14
export const ROOM_CLOSED_RETENTION_DAYS = 30
export const ROOM_JOIN_REQUEST_TTL_MS = 5 * 60 * 1000
/** Ephemeral room fan-out (relayed live, never persisted). */
export const ROOM_EPHEMERAL_MAX_BYTES = 4096
export const ROOM_EPHEMERAL_RATE_PER_SEC = 20
export const ROOM_EPHEMERAL_BURST = 40
