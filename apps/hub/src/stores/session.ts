import { type LoginResponse, type SessionResponse, SIG_DOMAIN } from '@gathernet/shared'
import { create } from 'zustand'
import { api, setTokenProvider } from '../lib/api.ts'
import { type HubCrypto, type IdentityHandle, loadCrypto } from '../lib/mls.ts'
import {
  type DeviceRecord,
  installCryptoBox,
  metaStore,
  requestPersistence,
  secureStore,
  wipeAll,
} from '../lib/storage.ts'
import { wsClient } from '../lib/ws-client.ts'
import { chatStore } from './chat.ts'
import { communityChatStore } from './community-chat.ts'

export type SessionPhase = 'loading' | 'welcome' | 'locked' | 'unlocked'

interface SessionState {
  phase: SessionPhase
  accountId: string | null
  deviceId: string | null
  displayName: string | null
  token: string | null
  boot(): Promise<void>
  createAccount(input: {
    displayName: string
    deviceName: string
    password: string
    phrase: string
  }): Promise<void>
  restore(input: { phrase: string; deviceName: string; password: string }): Promise<void>
  unlock(password: string): Promise<boolean>
  lock(): void
  forgetDevice(): Promise<void>
}

const encoder = new TextEncoder()

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const fromB64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

async function getChallenge(purpose: 'enroll' | 'login'): Promise<Uint8Array> {
  const res = await api<{ challenge: string }>('POST', '/api/v1/auth/challenge', { purpose })
  return fromB64(res.challenge)
}

interface EnrollmentMaterial {
  body: {
    accountPk: string
    deviceCert: string
    certSig: string
    challenge: string
    identitySig: string
    deviceSig: string
  }
  deviceSecret: Uint8Array
  credential: Uint8Array
}

/** Builds the cert + all three signatures for enroll endpoints. */
function buildEnrollment(
  crypto: HubCrypto,
  identity: IdentityHandle,
  deviceName: string,
  challenge: Uint8Array,
): EnrollmentMaterial {
  const device = crypto.generateDeviceKeypair()
  const cert = crypto.encodeDeviceCert(
    identity.publicKey,
    device.publicKey,
    deviceName,
    Math.floor(Date.now() / 1000),
  )
  const certSig = identity.sign(concat(encoder.encode(SIG_DOMAIN.deviceCert), cert))
  const enrollPayload = concat(encoder.encode(SIG_DOMAIN.enroll), challenge, cert)
  return {
    body: {
      accountPk: b64(identity.publicKey),
      deviceCert: b64(cert),
      certSig: b64(certSig),
      challenge: b64(challenge),
      identitySig: b64(identity.sign(enrollPayload)),
      deviceSig: b64(crypto.ed25519Sign(device.secret, enrollPayload)),
    },
    deviceSecret: device.secret,
    credential: crypto.makeCredential(cert, certSig),
  }
}

/** Argon2id(password) → KEK; DMK sealed under KEK lives in plaintext meta. */
async function setupLocalEncryption(
  crypto: HubCrypto,
  password: string,
  session: { accountId: string; deviceId: string; displayName: string },
): Promise<Uint8Array> {
  const salt = new Uint8Array(16)
  globalThis.crypto.getRandomValues(salt)
  const profile = 'default' as const
  const kek = crypto.argon2id(password, salt, profile)
  const dmk = new Uint8Array(32)
  globalThis.crypto.getRandomValues(dmk)
  const wrappedDmk = crypto.seal(kek, dmk, encoder.encode('gn:dmk'))
  await metaStore.put({ kdf: { salt, profile }, wrappedDmk, ...session })
  installBox(crypto, dmk)
  return dmk
}

function installBox(crypto: HubCrypto, dmk: Uint8Array): void {
  installCryptoBox({
    seal: (plaintext, aad) => crypto.seal(dmk, plaintext, encoder.encode(aad)),
    open: (sealed, aad) => crypto.open(dmk, sealed, encoder.encode(aad)),
  })
}

async function startSession(
  record: DeviceRecord,
  token: string,
  displayName: string,
  set: (state: Partial<SessionState>) => void,
): Promise<void> {
  set({
    phase: 'unlocked',
    accountId: record.accountId,
    deviceId: record.deviceId,
    displayName,
    token,
  })
  setTokenProvider(() => useSession.getState().token)
  wsClient.start(() => useSession.getState().token)
  await chatStore.init(record)
  await communityChatStore.init(record)
}

export const useSession = create<SessionState>((set, _get) => ({
  phase: 'loading',
  accountId: null,
  deviceId: null,
  displayName: null,
  token: null,

  async boot() {
    const meta = await metaStore.get()
    set({
      phase: meta ? 'locked' : 'welcome',
      accountId: meta?.accountId ?? null,
      displayName: meta?.displayName ?? null,
    })
  },

  async createAccount({ displayName, deviceName, password, phrase }) {
    const crypto = await loadCrypto()
    const identity = crypto.identityFromMnemonic(phrase)
    try {
      const challenge = await getChallenge('enroll')
      const enrollment = buildEnrollment(crypto, identity, deviceName, challenge)
      const session = await api<SessionResponse>('POST', '/api/v1/accounts', {
        ...enrollment.body,
        displayName,
      })

      await setupLocalEncryption(crypto, password, {
        accountId: session.accountId,
        deviceId: session.deviceId,
        displayName,
      })
      // The phrase is only in memory during enrollment — derive the storage
      // root now so app grants can hand out per-app keys later.
      await secureStore.putStorageRoot(crypto.deriveStorageRoot(phrase))
      const record: DeviceRecord = {
        deviceSecret: enrollment.deviceSecret,
        credential: enrollment.credential,
        accountId: session.accountId,
        deviceId: session.deviceId,
      }
      await secureStore.putDevice(record)
      await requestPersistence()
      await startSession(record, session.token, displayName, set)
    } finally {
      identity.zeroize()
    }
  },

  async restore({ phrase, deviceName, password }) {
    const crypto = await loadCrypto()
    const identity = crypto.identityFromMnemonic(phrase)
    try {
      const challenge = await getChallenge('enroll')
      const enrollment = buildEnrollment(crypto, identity, deviceName, challenge)
      const session = await api<SessionResponse>('POST', '/api/v1/devices', enrollment.body)

      await setupLocalEncryption(crypto, password, {
        accountId: session.accountId,
        deviceId: session.deviceId,
        displayName: session.displayName,
      })
      // Same as createAccount: persist the storage root while the phrase is
      // still available.
      await secureStore.putStorageRoot(crypto.deriveStorageRoot(phrase))
      const record: DeviceRecord = {
        deviceSecret: enrollment.deviceSecret,
        credential: enrollment.credential,
        accountId: session.accountId,
        deviceId: session.deviceId,
      }
      await secureStore.putDevice(record)
      await requestPersistence()
      await startSession(record, session.token, session.displayName, set)
    } finally {
      identity.zeroize()
    }
  },

  async unlock(password) {
    const crypto = await loadCrypto()
    const meta = await metaStore.get()
    if (!meta) {
      set({ phase: 'welcome' })
      return false
    }
    let dmk: Uint8Array
    try {
      const kek = crypto.argon2id(password, meta.kdf.salt, meta.kdf.profile)
      dmk = crypto.open(kek, meta.wrappedDmk, encoder.encode('gn:dmk'))
    } catch {
      return false
    }
    installBox(crypto, dmk)
    const record = await secureStore.getDevice()
    if (!record) {
      set({ phase: 'welcome' })
      return false
    }

    // Fresh token via challenge–response — tokens are never persisted.
    const challenge = await getChallenge('login')
    const sig = crypto.ed25519Sign(
      record.deviceSecret,
      concat(encoder.encode(SIG_DOMAIN.auth), challenge, encoder.encode(record.deviceId)),
    )
    const login = await api<LoginResponse>('POST', '/api/v1/auth/token', {
      deviceId: record.deviceId,
      challenge: b64(challenge),
      sig: b64(sig),
    })
    await startSession(record, login.token, login.displayName, set)
    return true
  },

  lock() {
    wsClient.stop()
    chatStore.reset()
    communityChatStore.reset()
    installCryptoBox(null)
    set({ phase: 'locked', token: null })
  },

  async forgetDevice() {
    wsClient.stop()
    chatStore.reset()
    communityChatStore.reset()
    await wipeAll()
    set({ phase: 'welcome', accountId: null, deviceId: null, displayName: null, token: null })
  },
}))
