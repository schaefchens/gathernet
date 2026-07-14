/**
 * @gathernet/mls-client — typed facade over the mls-wasm module.
 *
 * Call {@link initMls} once before using anything else. In the browser (Vite)
 * the wasm binary is resolved relative to this package; in Node/vitest pass the
 * bytes explicitly:
 *
 * ```ts
 * import { readFile } from "node:fs/promises";
 * await initMls({ wasmBytes: await readFile(wasmPath) });
 * ```
 *
 * Crash-consistency rule: every mutating MLS operation returns a `snapshot` of
 * the group state taken after the operation. Persist the snapshot BEFORE
 * releasing the produced ciphertext/commit — reloading an older snapshot and
 * encrypting again would reuse ratchet positions and receivers will reject the
 * replayed generations.
 */

type WasmModule = typeof import('../wasm/mls_wasm.js')
type WasmIdentityKeypair = import('../wasm/mls_wasm.js').IdentityKeypair
type WasmDeviceKeypair = import('../wasm/mls_wasm.js').DeviceKeypair
type WasmMlsDevice = import('../wasm/mls_wasm.js').MlsDevice

let wasm: WasmModule | null = null

function mod(): WasmModule {
  if (!wasm) {
    throw new Error('mls-client not initialized: call initMls() first')
  }
  return wasm
}

/**
 * Load and instantiate the WebAssembly module. Idempotent.
 *
 * @param input.wasmBytes Raw bytes of `mls_wasm_bg.wasm` for environments
 * without URL-based fetching (Node, vitest).
 */
export async function initMls(input?: { wasmBytes?: Uint8Array }): Promise<void> {
  if (wasm) {
    return
  }
  const loaded = await import('../wasm/mls_wasm.js')
  const source: URL | Uint8Array =
    input?.wasmBytes ?? new URL('../wasm/mls_wasm_bg.wasm', import.meta.url)
  await loaded.default({ module_or_path: source })
  wasm = loaded
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface MemberInfo {
  /** base58 of the account public key. */
  accountId: string
  /** hex of the 16-byte device id. */
  deviceId: string
  /** Device name from the certificate. */
  name: string
}

export interface KeyPackageResult {
  /** Key package reference (storage id). */
  ref: Uint8Array
  /** Serialized MlsMessage to publish to the hub. */
  message: Uint8Array
  /** Private entry to persist locally until the Welcome arrives. */
  privateState: Uint8Array
}

export interface CreateGroupResult {
  snapshot: Uint8Array
}

export interface AddMembersResult {
  commit: Uint8Array
  welcomes: Uint8Array[]
  groupInfo: Uint8Array
  snapshot: Uint8Array
}

export interface RemoveMembersResult {
  commit: Uint8Array
  groupInfo: Uint8Array
  snapshot: Uint8Array
}

export interface JoinResult {
  groupId: Uint8Array
  epoch: number
  members: MemberInfo[]
  snapshot: Uint8Array
}

export interface ExternalJoinResult {
  groupId: Uint8Array
  commit: Uint8Array
  epoch: number
  snapshot: Uint8Array
}

export interface EncryptResult {
  ciphertext: Uint8Array
  snapshot: Uint8Array
}

export type ProcessedKind = 'application' | 'commit' | 'proposal'

export interface ProcessedMessage {
  kind: ProcessedKind
  /** Decrypted payload for application messages. */
  plaintext?: Uint8Array
  senderDeviceId?: string
  senderAccountId?: string
  epoch: number
  /** Fresh group info after a commit was applied; re-publish it to the hub. */
  groupInfo?: Uint8Array
  snapshot: Uint8Array
}

export interface DeviceCertInfo {
  version: number
  accountPk: Uint8Array
  devicePk: Uint8Array
  /** hex of the 16-byte device id. */
  deviceId: string
  name: string
  /** Seconds since the Unix epoch. */
  createdAt: number
}

export interface ParsedCredential extends DeviceCertInfo {
  /** 64-byte Ed25519 certificate signature (already verified). */
  sig: Uint8Array
}

export type Argon2Profile = 'default' | 'light'

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/** Generate a fresh BIP39 English 12-word mnemonic. */
export function generateMnemonic(): string {
  return mod().generate_mnemonic()
}

/** Check whether a phrase is a valid BIP39 English mnemonic. */
export function validateMnemonic(phrase: string): boolean {
  return mod().validate_mnemonic(phrase)
}

/** Account identity keypair, deterministically derived from a BIP39 mnemonic. */
export class IdentityKeypair {
  private constructor(private readonly inner: WasmIdentityKeypair) {}

  static fromMnemonic(phrase: string): IdentityKeypair {
    return new IdentityKeypair(mod().IdentityKeypair.from_mnemonic(phrase))
  }

  /** 32-byte raw Ed25519 public key. */
  publicKey(): Uint8Array {
    return this.inner.public_key()
  }

  /** 64-byte Ed25519 signature over `msg`. */
  sign(msg: Uint8Array): Uint8Array {
    return this.inner.sign(msg)
  }

  /** Domain-separated device certificate signature ("gathernet-device-cert-v1"). */
  signDeviceCert(certBytes: Uint8Array): Uint8Array {
    return this.inner.sign_device_cert(certBytes)
  }

  /** base58btc encoding of the public key. */
  accountId(): string {
    return this.inner.account_id()
  }

  /** Zeroize and free the underlying key material. */
  free(): void {
    this.inner.free()
  }
}

/** Per-device Ed25519 keypair. */
export class DeviceKeypair {
  private constructor(private readonly inner: WasmDeviceKeypair) {}

  static generate(): DeviceKeypair {
    return new DeviceKeypair(mod().DeviceKeypair.generate())
  }

  static fromSecret(bytes: Uint8Array): DeviceKeypair {
    return new DeviceKeypair(mod().DeviceKeypair.from_secret(bytes))
  }

  /** 32-byte Ed25519 seed. */
  secret(): Uint8Array {
    return this.inner.secret()
  }

  /** 32-byte raw Ed25519 public key. */
  publicKey(): Uint8Array {
    return this.inner.public_key()
  }

  /** hex of the first 16 bytes of SHA-256(public key). */
  deviceId(): string {
    return this.inner.device_id()
  }

  /** Zeroize and free the underlying key material. */
  free(): void {
    this.inner.free()
  }
}

/** Ed25519 signature from a 32-byte secret seed. */
export function ed25519Sign(secretSeed: Uint8Array, msg: Uint8Array): Uint8Array {
  return mod().ed25519_sign(secretSeed, msg)
}

/** Verify an Ed25519 signature. */
export function ed25519Verify(publicKey: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  return mod().ed25519_verify(publicKey, msg, sig)
}

/**
 * Argon2id, 32-byte output.
 * Profiles: "default" (m=65536 KiB, t=3, p=1), "light" (m=19456 KiB, t=2, p=1).
 */
export function argon2idHash(
  password: string,
  salt: Uint8Array,
  profile: Argon2Profile,
): Uint8Array {
  return mod().argon2id_hash(password, salt, profile)
}

/** XChaCha20-Poly1305 seal; random 24-byte nonce prepended to the ciphertext. */
export function seal(key32: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  return mod().seal(key32, plaintext, aad)
}

/** Open a sealed box produced by {@link seal}. Throws on wrong key/aad/tampering. */
export function openSealed(key32: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array {
  return mod().open_sealed(key32, sealed, aad)
}

/**
 * Deterministic CBOR device certificate:
 * `[1, bytes(accountPk), bytes(devicePk), bytes(deviceId), str(name), u64(createdAt)]`.
 */
export function encodeDeviceCert(
  accountPk: Uint8Array,
  devicePk: Uint8Array,
  name: string,
  createdAtSecs: number | bigint,
): Uint8Array {
  return mod().encode_device_cert(accountPk, devicePk, name, BigInt(createdAtSecs))
}

/** Decode a device certificate (no signature verification). */
export function decodeDeviceCert(bytes: Uint8Array): DeviceCertInfo {
  return mod().decode_device_cert(bytes) as DeviceCertInfo
}

/** Build credential bytes: certBytes || 64-byte signature. */
export function makeCredential(certBytes: Uint8Array, certSig: Uint8Array): Uint8Array {
  return mod().make_credential(certBytes, certSig)
}

/**
 * Split, decode and VERIFY a credential against the embedded account public
 * key. Throws if the signature is invalid.
 */
export function parseCredential(bytes: Uint8Array): ParsedCredential {
  return mod().parse_credential(bytes) as ParsedCredential
}

// ---------------------------------------------------------------------------
// MLS device
// ---------------------------------------------------------------------------

/**
 * An MLS client bound to one device credential, over exportable in-memory
 * storage. Group state is persisted by the caller via the `snapshot` returned
 * from every mutating call.
 */
export class MlsDevice {
  private constructor(private readonly inner: WasmMlsDevice) {}

  /** Build from credential bytes (cert || sig) and the device's 32-byte Ed25519 seed. */
  static create(credentialBytes: Uint8Array, deviceSecretSeed: Uint8Array): MlsDevice {
    return new MlsDevice(mod().MlsDevice.create(credentialBytes, deviceSecretSeed))
  }

  /**
   * Generate a key package. Persist `privateState` (keyed by `ref`) until the
   * corresponding Welcome has been processed.
   */
  generateKeyPackage(lastResort: boolean): KeyPackageResult {
    return this.inner.generate_key_package(lastResort) as KeyPackageResult
  }

  /** Restore a key package private entry so a Welcome can still be processed. */
  importKeyPackagePrivate(ref: Uint8Array, privateState: Uint8Array): void {
    this.inner.import_key_package_private(ref, privateState)
  }

  createGroup(groupId: Uint8Array): CreateGroupResult {
    return this.inner.create_group(groupId) as CreateGroupResult
  }

  /** Import a snapshot produced by any mutating call and load the group. */
  loadGroup(groupId: Uint8Array, snapshot: Uint8Array): void {
    this.inner.load_group(groupId, snapshot)
  }

  /** Commit adding members by their key package messages (self-applies the commit). */
  addMembers(groupId: Uint8Array, keyPackageMsgs: Uint8Array[]): AddMembersResult {
    return this.inner.add_members(groupId, keyPackageMsgs) as AddMembersResult
  }

  /** Commit removing members by device id (hex). */
  removeMembers(groupId: Uint8Array, deviceIds: string[]): RemoveMembersResult {
    return this.inner.remove_members(groupId, deviceIds) as RemoveMembersResult
  }

  joinFromWelcome(welcomeMsg: Uint8Array): JoinResult {
    return this.inner.join_from_welcome(welcomeMsg) as JoinResult
  }

  /** 0-RTT join via a published GroupInfo message; broadcast the returned commit. */
  externalJoin(groupInfoMsg: Uint8Array): ExternalJoinResult {
    return this.inner.external_join(groupInfoMsg) as ExternalJoinResult
  }

  /** Encrypt an application message. Persist `snapshot` before sending `ciphertext`. */
  encrypt(groupId: Uint8Array, plaintext: Uint8Array): EncryptResult {
    return this.inner.encrypt(groupId, plaintext) as EncryptResult
  }

  /**
   * Process an incoming MLS message (application, commit or proposal).
   * Do not feed a device's own commits back to it.
   */
  processIncoming(groupId: Uint8Array, message: Uint8Array): ProcessedMessage {
    return this.inner.process_incoming(groupId, message) as ProcessedMessage
  }

  /** Serialized GroupInfo MlsMessage (ratchet tree included) for external joins. */
  currentGroupInfo(groupId: Uint8Array): Uint8Array {
    return this.inner.current_group_info(groupId)
  }

  members(groupId: Uint8Array): MemberInfo[] {
    return this.inner.members(groupId) as MemberInfo[]
  }

  currentEpoch(groupId: Uint8Array): number {
    return this.inner.current_epoch(groupId)
  }

  /** Free the underlying wasm object (zeroizes group secrets in memory). */
  free(): void {
    this.inner.free()
  }
}
