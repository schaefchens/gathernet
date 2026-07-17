/**
 * The Hub's single doorway to the WASM crypto module (@gathernet/mls-client).
 * Everything cryptographic flows through this interface; no other file
 * imports the WASM package.
 *
 * NOTE: the concrete wiring lands with packages/mls-client (stage 2).
 * Until then loadCrypto() throws — every UI flow is written against the
 * final interface.
 */

export interface IdentityHandle {
  publicKey: Uint8Array
  accountId: string
  sign(message: Uint8Array): Uint8Array
  zeroize(): void
}

export interface DeviceKeys {
  secret: Uint8Array
  publicKey: Uint8Array
  deviceId: string
}

export interface KeyPackageResult {
  ref: Uint8Array
  message: Uint8Array
  privateState: Uint8Array
}

export interface CommitResult {
  commit: Uint8Array
  welcomes: Uint8Array[]
  groupInfo: Uint8Array
  snapshot: Uint8Array
}

export interface RemoveResult {
  commit: Uint8Array
  groupInfo: Uint8Array
  snapshot: Uint8Array
}

export interface ProcessedMessage {
  kind: 'application' | 'commit' | 'proposal'
  plaintext?: Uint8Array
  senderDeviceId?: string
  senderAccountId?: string
  epoch: number
  groupInfo?: Uint8Array
  snapshot: Uint8Array
}

export interface MemberInfo {
  accountId: string
  deviceId: string
  name: string
}

export interface MlsDeviceHandle {
  generateKeyPackage(lastResort: boolean): KeyPackageResult
  importKeyPackagePrivate(ref: Uint8Array, privateState: Uint8Array): void
  createGroup(groupId: Uint8Array): { snapshot: Uint8Array }
  loadGroup(groupId: Uint8Array, snapshot: Uint8Array): void
  addMembers(groupId: Uint8Array, keyPackages: Uint8Array[]): CommitResult
  removeMembers(groupId: Uint8Array, deviceIds: string[]): RemoveResult
  joinFromWelcome(welcome: Uint8Array): {
    groupId: Uint8Array
    epoch: number
    members: MemberInfo[]
    snapshot: Uint8Array
  }
  externalJoin(groupInfo: Uint8Array): {
    groupId: Uint8Array
    commit: Uint8Array
    epoch: number
    snapshot: Uint8Array
  }
  encrypt(
    groupId: Uint8Array,
    plaintext: Uint8Array,
  ): { ciphertext: Uint8Array; snapshot: Uint8Array }
  processIncoming(groupId: Uint8Array, message: Uint8Array): ProcessedMessage
  currentGroupInfo(groupId: Uint8Array): Uint8Array
  members(groupId: Uint8Array): MemberInfo[]
  currentEpoch(groupId: Uint8Array): number
}

export interface HubCrypto {
  generateMnemonic(): string
  validateMnemonic(phrase: string): boolean
  identityFromMnemonic(phrase: string): IdentityHandle
  /** 32-byte storage-root key, domain-separated from the identity derivation. */
  deriveStorageRoot(phrase: string): Uint8Array
  generateDeviceKeypair(): DeviceKeys
  deviceKeypairFromSecret(secret: Uint8Array): DeviceKeys
  ed25519Sign(secret: Uint8Array, message: Uint8Array): Uint8Array
  /** Verify an Ed25519 signature (surfaces the already-built mls-client fn). */
  ed25519Verify(publicKey: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean
  /** Decode a DeviceCert to read its account/device public keys (no verify). */
  decodeDeviceCert(cert: Uint8Array): { accountPk: Uint8Array; devicePk: Uint8Array }
  argon2id(password: string, salt: Uint8Array, profile: 'default' | 'light'): Uint8Array
  seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array
  open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array
  encodeDeviceCert(
    accountPk: Uint8Array,
    devicePk: Uint8Array,
    name: string,
    createdAtSecs: number,
  ): Uint8Array
  makeCredential(certBytes: Uint8Array, certSig: Uint8Array): Uint8Array
  createDevice(credential: Uint8Array, deviceSecret: Uint8Array): MlsDeviceHandle
}

let cryptoPromise: Promise<HubCrypto> | null = null

export function loadCrypto(): Promise<HubCrypto> {
  cryptoPromise ??= loadImpl()
  return cryptoPromise
}

async function loadImpl(): Promise<HubCrypto> {
  const mls = await import('@gathernet/mls-client')
  await mls.initMls()
  return {
    generateMnemonic: mls.generateMnemonic,
    validateMnemonic: mls.validateMnemonic,
    deriveStorageRoot: mls.deriveStorageRoot,
    identityFromMnemonic(phrase) {
      const keypair = mls.IdentityKeypair.fromMnemonic(phrase)
      return {
        publicKey: keypair.publicKey(),
        accountId: keypair.accountId(),
        sign: (message) => keypair.sign(message),
        zeroize: () => keypair.free(),
      }
    },
    generateDeviceKeypair() {
      const keypair = mls.DeviceKeypair.generate()
      const keys = {
        secret: keypair.secret(),
        publicKey: keypair.publicKey(),
        deviceId: keypair.deviceId(),
      }
      keypair.free()
      return keys
    },
    deviceKeypairFromSecret(secret) {
      const keypair = mls.DeviceKeypair.fromSecret(secret)
      const keys = {
        secret: keypair.secret(),
        publicKey: keypair.publicKey(),
        deviceId: keypair.deviceId(),
      }
      keypair.free()
      return keys
    },
    ed25519Sign: mls.ed25519Sign,
    ed25519Verify: mls.ed25519Verify,
    decodeDeviceCert: (cert) => {
      const info = mls.decodeDeviceCert(cert)
      return { accountPk: info.accountPk, devicePk: info.devicePk }
    },
    argon2id: (password, salt, profile) => mls.argon2idHash(password, salt, profile),
    seal: mls.seal,
    open: mls.openSealed,
    encodeDeviceCert: (accountPk, devicePk, name, createdAtSecs) =>
      mls.encodeDeviceCert(accountPk, devicePk, name, createdAtSecs),
    makeCredential: mls.makeCredential,
    createDevice: (credential, deviceSecret) => mls.MlsDevice.create(credential, deviceSecret),
  }
}

/** Test/wiring seam. */
export function installCrypto(impl: () => Promise<HubCrypto>): void {
  cryptoPromise = impl()
}
