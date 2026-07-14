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
