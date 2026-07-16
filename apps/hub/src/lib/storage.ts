/**
 * IndexedDB layer. Everything except `meta` is encrypted at rest with
 * XChaCha20-Poly1305 under the Device Master Key (DMK); the seal/open
 * functions come from the WASM module and are installed at unlock.
 *
 * Crash-consistency rule (MLS): group snapshots are persisted BEFORE
 * ciphertext is released to the network and BEFORE acking received
 * messages — see persistSnapshot call sites in the chat store.
 */

const DB_NAME = 'gathernet'
const DB_VERSION = 1
const STORES = ['meta', 'secure', 'groups', 'kps', 'messages'] as const
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
  senderAccountId: string
  text: string
  sentAt: number
  outgoing: boolean
}

export const messageStore = {
  async list(groupId: string): Promise<StoredMessage[]> {
    const sealed = await tx<{ groupId: string; seq: number; box: Uint8Array }[]>(
      'messages',
      'readonly',
      (s) =>
        s.getAll(IDBKeyRange.bound([groupId, 0], [groupId, Number.MAX_SAFE_INTEGER])) as IDBRequest<
          { groupId: string; seq: number; box: Uint8Array }[]
        >,
    )
    return sealed.map((row) => openJson<StoredMessage>(row.box, `msg:${groupId}:${row.seq}`))
  },
  put(message: StoredMessage): Promise<unknown> {
    return tx('messages', 'readwrite', (s) =>
      s.put({
        groupId: message.groupId,
        seq: message.seq,
        box: sealJson(message, `msg:${message.groupId}:${message.seq}`),
      }),
    )
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
