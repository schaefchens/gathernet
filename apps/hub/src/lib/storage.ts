/**
 * IndexedDB layer. Everything except `meta` is encrypted at rest with
 * XChaCha20-Poly1305 under the Device Master Key (DMK); the seal/open
 * functions come from the WASM module and are installed at unlock.
 *
 * Crash-consistency rule (MLS): group snapshots are persisted BEFORE
 * ciphertext is released to the network and BEFORE acking received
 * messages — see persistSnapshot call sites in the chat store.
 */

import type { MediaRef } from './message-body.ts'

const DB_NAME = 'gathernet'
const DB_VERSION = 2
const STORES = ['meta', 'secure', 'groups', 'kps', 'messages', 'channels'] as const
type StoreName = (typeof STORES)[number]

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          if (name === 'messages') {
            db.createObjectStore(name, { keyPath: ['groupId', 'seq'] })
          } else {
            db.createObjectStore(name)
          }
        }
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexeddb open failed'))
  })
  return dbPromise
}

function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode)
        const request = run(transaction.objectStore(store))
        transaction.oncomplete = () => resolve(request.result)
        transaction.onerror = () => reject(transaction.error ?? new Error('tx failed'))
        transaction.onabort = () => reject(transaction.error ?? new Error('tx aborted'))
      }),
  )
}

/* ---------- plaintext meta (pre-unlock bootstrap data) ---------- */

export interface MetaRecord {
  /** argon2id inputs + the DMK wrapped under the password-derived KEK */
  kdf: { salt: Uint8Array; profile: 'default' | 'light' }
  wrappedDmk: Uint8Array
  accountId: string
  deviceId: string
  displayName: string
}

export const metaStore = {
  get: () => tx<MetaRecord | undefined>('meta', 'readonly', (s) => s.get('v1')),
  put: (record: MetaRecord) => tx('meta', 'readwrite', (s) => s.put(record, 'v1')),
}

/**
 * Push notification DISPLAY prefs — how a notification is shown. Stored PLAINTEXT in
 * the `meta` store (key 'push') so the service worker can read them while the app is
 * locked (the DMK is unavailable in a background worker). These aren't secrets; the
 * server-side prefs (which categories to push, muted communities) live server-side.
 */
export interface PushDisplayPrefs {
  /** coarse = show the category; generic = "new activity" only */
  contentLevel: 'coarse' | 'generic'
  /** override the notification title (lock-screen anonymization); default 'Gathernet' */
  title?: string
  /** override the notification icon URL */
  icon?: string
  /** locale for the SW-composed text */
  locale: string
}

export const pushPrefsStore = {
  get: () => tx<PushDisplayPrefs | undefined>('meta', 'readonly', (s) => s.get('push')),
  put: (prefs: PushDisplayPrefs) => tx('meta', 'readwrite', (s) => s.put(prefs, 'push')),
}

/* ---------- encrypted stores ---------- */

export interface CryptoBox {
  seal(plaintext: Uint8Array, aad: string): Uint8Array
  open(sealed: Uint8Array, aad: string): Uint8Array
}

let box: CryptoBox | null = null

export function installCryptoBox(cryptoBox: CryptoBox | null): void {
  box = cryptoBox
}

function requireBox(): CryptoBox {
  if (!box) throw new Error('storage is locked')
  return box
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function sealJson(value: unknown, aad: string): Uint8Array {
  return requireBox().seal(encoder.encode(JSON.stringify(value, jsonReplacer)), aad)
}

function openJson<T>(sealed: Uint8Array, aad: string): T {
  return JSON.parse(decoder.decode(requireBox().open(sealed, aad)), jsonReviver) as T
}

// Uint8Array-aware JSON round-tripping for stored records.
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __u8: btoa(String.fromCharCode(...value)) }
  }
  return value
}

function jsonReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'object' && value !== null && '__u8' in value) {
    const b64 = (value as { __u8: string }).__u8
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  }
  return value
}

/** Device secrets — one record, key 'device'. */
export interface DeviceRecord {
  deviceSecret: Uint8Array
  credential: Uint8Array
  accountId: string
  deviceId: string
  /** persistent ECIES receipt public key (raw SPKI, base64) — community K_meta
   *  grants are sealed to it. Optional: devices enrolled before this feature. */
  receiptPk?: string
  /** the matching PKCS#8 private key (sealed under the DMK like the rest) */
  receiptPrivPkcs8?: Uint8Array
}

export const secureStore = {
  async getDevice(): Promise<DeviceRecord | null> {
    const sealed = await tx<Uint8Array | undefined>('secure', 'readonly', (s) => s.get('device'))
    return sealed ? openJson<DeviceRecord>(sealed, 'secure:device') : null
  },
  putDevice(record: DeviceRecord): Promise<unknown> {
    return tx('secure', 'readwrite', (s) => s.put(sealJson(record, 'secure:device'), 'device'))
  },
  /** Mnemonic-derived storage root for per-app key derivation (app grants). */
  async getStorageRoot(): Promise<Uint8Array | null> {
    const sealed = await tx<Uint8Array | undefined>('secure', 'readonly', (s) =>
      s.get('storage-root'),
    )
    return sealed ? requireBox().open(sealed, 'secure:storage-root') : null
  },
  putStorageRoot(root: Uint8Array): Promise<unknown> {
    return tx('secure', 'readwrite', (s) =>
      s.put(requireBox().seal(root, 'secure:storage-root'), 'storage-root'),
    )
  },
  /**
   * Per-community metadata key (K_meta), keyed by communityId. It decrypts the
   * community's and channels' display metadata + avatars; the server never sees
   * it — it arrives out-of-band in the invite payload fragment and is kept here
   * sealed under the DMK. Stored in the `secure` store under a `kmeta:<id>` key
   * (no DB-version bump needed — the store has no fixed keyPath).
   */
  async getCommunityKey(communityId: string): Promise<{ key: Uint8Array; epoch: number } | null> {
    const sealed = await tx<Uint8Array | undefined>('secure', 'readonly', (s) =>
      s.get(`kmeta:${communityId}`),
    )
    if (!sealed) return null
    const plain = requireBox().open(sealed, `secure:kmeta:${communityId}`)
    // New format: 4-byte LE epoch prefix + key. Legacy (Phase A): bare key ⇒ epoch 0.
    if (plain.length <= 32) return { key: plain, epoch: 0 }
    const epoch = new DataView(plain.buffer, plain.byteOffset, 4).getUint32(0, true)
    return { key: plain.subarray(4), epoch }
  },
  putCommunityKey(communityId: string, key: Uint8Array, epoch: number): Promise<unknown> {
    const buf = new Uint8Array(4 + key.length)
    new DataView(buf.buffer).setUint32(0, epoch, true)
    buf.set(key, 4)
    return tx('secure', 'readwrite', (s) =>
      s.put(requireBox().seal(buf, `secure:kmeta:${communityId}`), `kmeta:${communityId}`),
    )
  },
  /**
   * Pinned community owner accountId (the capability-chain anchor), learned
   * out-of-band from the invite on first join and pinned so a compromised server
   * can't later swap the owner. Sealed under the DMK, keyed `owner:<communityId>`.
   */
  async getCommunityOwner(communityId: string): Promise<string | null> {
    const sealed = await tx<Uint8Array | undefined>('secure', 'readonly', (s) =>
      s.get(`owner:${communityId}`),
    )
    return sealed ? decoder.decode(requireBox().open(sealed, `secure:owner:${communityId}`)) : null
  },
  putCommunityOwner(communityId: string, ownerAccountId: string): Promise<unknown> {
    return tx('secure', 'readwrite', (s) =>
      s.put(
        requireBox().seal(encoder.encode(ownerAccountId), `secure:owner:${communityId}`),
        `owner:${communityId}`,
      ),
    )
  },
}

/**
 * Per-(channel, epoch) content keys (K_channel) for group_key channels. A device
 * holds a small window of recent epochs (old messages stay under their old key
 * until the channel TTL expires them), so keys are stored one-per-epoch under a
 * `kchan:<channelId>:<epoch>` key in the `secure` store — letting stale epochs be
 * pruned individually. Sealed under the DMK like everything else here.
 */
export const channelKeyStore = {
  async get(channelId: string, epoch: number): Promise<Uint8Array | null> {
    const sealed = await tx<Uint8Array | undefined>('secure', 'readonly', (s) =>
      s.get(`kchan:${channelId}:${epoch}`),
    )
    return sealed ? requireBox().open(sealed, `secure:kchan:${channelId}:${epoch}`) : null
  },
  put(channelId: string, epoch: number, key: Uint8Array): Promise<unknown> {
    return tx('secure', 'readwrite', (s) =>
      s.put(
        requireBox().seal(key, `secure:kchan:${channelId}:${epoch}`),
        `kchan:${channelId}:${epoch}`,
      ),
    )
  },
  delete(channelId: string, epoch: number): Promise<unknown> {
    return tx('secure', 'readwrite', (s) => s.delete(`kchan:${channelId}:${epoch}`))
  },
  /** Epochs of this channel's keys currently held on disk (ascending). */
  async epochs(channelId: string): Promise<number[]> {
    const keys = await tx<IDBValidKey[]>('secure', 'readonly', (s) => s.getAllKeys())
    const prefix = `kchan:${channelId}:`
    return keys
      .filter((k): k is string => typeof k === 'string' && k.startsWith(prefix))
      .map((k) => Number(k.slice(prefix.length)))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
  },
}

/** Per-group MLS snapshots. */
export const groupStore = {
  async get(groupId: string): Promise<Uint8Array | null> {
    const sealed = await tx<Uint8Array | undefined>('groups', 'readonly', (s) => s.get(groupId))
    if (!sealed) return null
    return requireBox().open(sealed, `group:${groupId}`)
  },
  put(groupId: string, snapshot: Uint8Array): Promise<unknown> {
    return tx('groups', 'readwrite', (s) =>
      s.put(requireBox().seal(snapshot, `group:${groupId}`), groupId),
    )
  },
  delete(groupId: string): Promise<unknown> {
    return tx('groups', 'readwrite', (s) => s.delete(groupId))
  },
  keys(): Promise<IDBValidKey[]> {
    return tx('groups', 'readonly', (s) => s.getAllKeys())
  },
}

/**
 * Per-channel MLS snapshots (community channels). A store DISTINCT from
 * `groups` so the DM sync engine and the community sync engine never see each
 * other's groups when enumerating keys — each engine owns exactly one of the
 * two IndexedDB stores. Channel groupIds are globally unique hex all the same.
 */
export const channelStore = {
  async get(channelId: string): Promise<Uint8Array | null> {
    const sealed = await tx<Uint8Array | undefined>('channels', 'readonly', (s) => s.get(channelId))
    if (!sealed) return null
    return requireBox().open(sealed, `channel:${channelId}`)
  },
  put(channelId: string, snapshot: Uint8Array): Promise<unknown> {
    return tx('channels', 'readwrite', (s) =>
      s.put(requireBox().seal(snapshot, `channel:${channelId}`), channelId),
    )
  },
  delete(channelId: string): Promise<unknown> {
    return tx('channels', 'readwrite', (s) => s.delete(channelId))
  },
  keys(): Promise<IDBValidKey[]> {
    return tx('channels', 'readonly', (s) => s.getAllKeys())
  },
}

/** Key-package private state awaiting Welcomes, keyed by hex ref. */
export const kpStore = {
  async get(ref: string): Promise<Uint8Array | null> {
    const sealed = await tx<Uint8Array | undefined>('kps', 'readonly', (s) => s.get(ref))
    return sealed ? requireBox().open(sealed, `kp:${ref}`) : null
  },
  put(ref: string, privateState: Uint8Array): Promise<unknown> {
    return tx('kps', 'readwrite', (s) => s.put(requireBox().seal(privateState, `kp:${ref}`), ref))
  },
  delete(ref: string): Promise<unknown> {
    return tx('kps', 'readwrite', (s) => s.delete(ref))
  },
  keys(): Promise<IDBValidKey[]> {
    return tx('kps', 'readonly', (s) => s.getAllKeys())
  },
}

/** Decrypted chat history (MLS senders can't decrypt their own ciphertext). */
export interface StoredMessage {
  groupId: string
  seq: number
  /** v2 client message id — stable across devices; target of reactions/edits/deletes.
   *  Absent on legacy (pre-v2) messages, which therefore can't be reacted to/edited. */
  id?: string
  senderAccountId: string
  /** sender's self-asserted display name (channels only) — for labelling incoming bubbles */
  senderName?: string
  /** default 'text' when absent (legacy) */
  kind?: 'text' | 'media' | 'voice'
  /** text body, or a media caption; '' for media/voice without a caption */
  text: string
  /** media/voice payload reference (ciphertext is server-side; the key is here) */
  media?: MediaRef
  /** id of the message this replies to */
  replyTo?: string
  /** emoji → the accountIds who reacted with it */
  reactions?: Record<string, string[]>
  editedAt?: number
  /** set when deleted-for-everyone; the row is kept as a tombstone */
  deletedAt?: number
  /** the tombstone was a moderator removal (distinct placeholder copy) rather than an
   *  author self-delete */
  removedByModerator?: boolean
  /** view-once: content is gated behind a tap and self-destructs after first open */
  once?: boolean
  /** view-once has been opened → content cleared, an "opened" tombstone remains */
  viewOnceOpened?: boolean
  sentAt: number
  outgoing: boolean
}

interface MessageRow {
  groupId: string
  seq: number
  /** plaintext timestamp — device-local only, enables TTL pruning without
   *  decrypting every row (the message text stays sealed in `box`) */
  sentAt: number
  box: Uint8Array
}

export const messageStore = {
  async list(groupId: string): Promise<StoredMessage[]> {
    const sealed = await tx<MessageRow[]>(
      'messages',
      'readonly',
      (s) =>
        s.getAll(IDBKeyRange.bound([groupId, 0], [groupId, Number.MAX_SAFE_INTEGER])) as IDBRequest<
          MessageRow[]
        >,
    )
    return sealed.map((row) => openJson<StoredMessage>(row.box, `msg:${groupId}:${row.seq}`))
  },
  put(message: StoredMessage): Promise<unknown> {
    return tx('messages', 'readwrite', (s) =>
      s.put({
        groupId: message.groupId,
        seq: message.seq,
        sentAt: message.sentAt,
        box: sealJson(message, `msg:${message.groupId}:${message.seq}`),
      } satisfies MessageRow),
    )
  },
  /** Disappearing messages: delete this group's rows older than `cutoffMs`. */
  async pruneOlderThan(groupId: string, cutoffMs: number): Promise<void> {
    const rows = await tx<MessageRow[]>(
      'messages',
      'readonly',
      (s) =>
        s.getAll(IDBKeyRange.bound([groupId, 0], [groupId, Number.MAX_SAFE_INTEGER])) as IDBRequest<
          MessageRow[]
        >,
    )
    const stale = rows.filter((r) => r.sentAt < cutoffMs)
    for (const row of stale) {
      await tx('messages', 'readwrite', (s) => s.delete([row.groupId, row.seq]))
    }
  },
}

/** Full local wipe — "forget this device". */
export async function wipeAll(): Promise<void> {
  const db = await openDb()
  db.close()
  dbPromise = null
  box = null
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('wipe failed'))
  })
}

export async function requestPersistence(): Promise<void> {
  try {
    await navigator.storage?.persist?.()
  } catch {
    // best effort — Safari may decline silently
  }
}
