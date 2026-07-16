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
