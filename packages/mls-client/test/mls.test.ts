import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  argon2idHash,
  DeviceKeypair,
  decodeDeviceCert,
  deriveStorageRoot,
  ed25519Sign,
  ed25519Verify,
  encodeDeviceCert,
  generateMnemonic,
  IdentityKeypair,
  initMls,
  MlsDevice,
  makeCredential,
  openSealed,
  parseCredential,
  seal,
  validateMnemonic,
} from '../src/index.ts'

const PHRASE_A =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PHRASE_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

/** Cross-check vector: hex of derive_storage_root(PHRASE_A), pinned by the
 * Rust test `storage_root_derivation_and_domain_separation`. */
const STORAGE_ROOT_VECTOR_A = '652fd378df74398c8270228badf21255994a026410550e29e1a114dc180dded6'

const utf8 = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b)
const hex = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')

interface TestDevice {
  device: MlsDevice
  credential: Uint8Array
  secret: Uint8Array
  deviceId: string
}

function makeDevice(identity: IdentityKeypair, name: string): TestDevice {
  const dk = DeviceKeypair.generate()
  const cert = encodeDeviceCert(identity.publicKey(), dk.publicKey(), name, 1_700_000_000)
  const credential = makeCredential(cert, identity.signDeviceCert(cert))
  const secret = dk.secret()
  return {
    device: MlsDevice.create(credential, secret),
    credential,
    secret,
    deviceId: dk.deviceId(),
  }
}

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../wasm/mls_wasm_bg.wasm', import.meta.url))
  await initMls({ wasmBytes: await readFile(wasmPath) })
})

describe('crypto helpers', () => {
  it('generates and validates mnemonics deterministically', () => {
    const phrase = generateMnemonic()
    expect(phrase.split(' ')).toHaveLength(12)
    expect(validateMnemonic(phrase)).toBe(true)
    expect(validateMnemonic('definitely not a mnemonic')).toBe(false)

    const a1 = IdentityKeypair.fromMnemonic(PHRASE_A)
    const a2 = IdentityKeypair.fromMnemonic(PHRASE_A)
    const b = IdentityKeypair.fromMnemonic(PHRASE_B)
    expect(a1.accountId()).toBe(a2.accountId())
    expect(a1.accountId()).not.toBe(b.accountId())
    expect(a1.publicKey()).toEqual(a2.publicKey())
    expect(a1.publicKey()).toHaveLength(32)

    const sig = a1.sign(utf8('hello'))
    expect(sig).toHaveLength(64)
    expect(ed25519Verify(a1.publicKey(), utf8('hello'), sig)).toBe(true)
    expect(ed25519Verify(a1.publicKey(), utf8('tampered'), sig)).toBe(false)
  })

  it('derives the storage root deterministically and domain-separated', () => {
    const root = deriveStorageRoot(PHRASE_A)
    expect(root).toHaveLength(32)
    // Cross-check vector pinned by the Rust test suite.
    expect(hex(root)).toBe(STORAGE_ROOT_VECTOR_A)
    expect(hex(deriveStorageRoot(PHRASE_A))).toBe(STORAGE_ROOT_VECTOR_A)
    expect(hex(deriveStorageRoot(PHRASE_B))).not.toBe(STORAGE_ROOT_VECTOR_A)
    // Domain separation: not the identity public key either.
    expect(hex(root)).not.toBe(hex(IdentityKeypair.fromMnemonic(PHRASE_A).publicKey()))
    expect(() => deriveStorageRoot('definitely not a mnemonic')).toThrow()
  })

  it('signs with raw device seeds', () => {
    const dk = DeviceKeypair.generate()
    const sig = ed25519Sign(dk.secret(), utf8('msg'))
    expect(ed25519Verify(dk.publicKey(), utf8('msg'), sig)).toBe(true)
    const restored = DeviceKeypair.fromSecret(dk.secret())
    expect(restored.deviceId()).toBe(dk.deviceId())
    expect(dk.deviceId()).toHaveLength(32)
  })

  it('hashes with argon2id light profile', () => {
    const salt = utf8('0123456789abcdef')
    const h1 = argon2idHash('password', salt, 'light')
    const h2 = argon2idHash('password', salt, 'light')
    expect(h1).toHaveLength(32)
    expect(h1).toEqual(h2)
    const other = argon2idHash('password', utf8('fedcba9876543210'), 'light')
    expect(other).not.toEqual(h1)
    expect(() => argon2idHash('password', salt, 'bogus' as never)).toThrow()
  })

  it('seals and opens with tamper rejection', () => {
    const key = new Uint8Array(32).fill(7)
    const sealed = seal(key, utf8('secret payload'), utf8('aad'))
    expect(text(openSealed(key, sealed, utf8('aad')))).toBe('secret payload')

    const tampered = sealed.slice()
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
    expect(() => openSealed(key, tampered, utf8('aad'))).toThrow()
    expect(() => openSealed(key, sealed, utf8('wrong aad'))).toThrow()
    expect(() => openSealed(new Uint8Array(32).fill(8), sealed, utf8('aad'))).toThrow()
  })

  it('roundtrips device certs and verifies credentials', () => {
    const identity = IdentityKeypair.fromMnemonic(PHRASE_A)
    const dk = DeviceKeypair.generate()
    const certBytes = encodeDeviceCert(identity.publicKey(), dk.publicKey(), 'laptop', 1234567890)

    const cert = decodeDeviceCert(certBytes)
    expect(cert.version).toBe(1)
    expect(cert.accountPk).toEqual(identity.publicKey())
    expect(cert.devicePk).toEqual(dk.publicKey())
    expect(cert.deviceId).toBe(dk.deviceId())
    expect(cert.name).toBe('laptop')
    expect(cert.createdAt).toBe(1234567890)

    const sig = identity.signDeviceCert(certBytes)
    const credential = makeCredential(certBytes, sig)
    const parsed = parseCredential(credential)
    expect(parsed.deviceId).toBe(dk.deviceId())
    expect(parsed.sig).toEqual(sig)

    // Signature from the wrong identity is rejected.
    const other = IdentityKeypair.fromMnemonic(PHRASE_B)
    const badCredential = makeCredential(certBytes, other.signDeviceCert(certBytes))
    expect(() => parseCredential(badCredential)).toThrow()
  })
})

describe('MLS multi-device scenario', () => {
  it('runs the full group lifecycle', () => {
    const alice = IdentityKeypair.fromMnemonic(PHRASE_A)
    const bob = IdentityKeypair.fromMnemonic(PHRASE_B)

    const alice1 = makeDevice(alice, 'alice-laptop')
    const bob1 = makeDevice(bob, 'bob-laptop')
    const bob2 = makeDevice(bob, 'bob-phone')

    const groupId = utf8('gathernet-e2e-group')

    // Alice-1 creates the group.
    const created = alice1.device.createGroup(groupId)
    expect(created.snapshot.length).toBeGreaterThan(0)
    expect(alice1.device.currentEpoch(groupId)).toBe(0)

    // Alice-2 publishes a key package, then "restarts" before the welcome
    // arrives: private state is restored via importKeyPackagePrivate.
    const alice2Initial = makeDevice(alice, 'alice-phone')
    const alice2Kp = alice2Initial.device.generateKeyPackage(false)
    expect(alice2Kp.ref.length).toBeGreaterThan(0)
    expect(alice2Kp.privateState.length).toBeGreaterThan(0)
    const alice2: TestDevice = {
      ...alice2Initial,
      device: MlsDevice.create(alice2Initial.credential, alice2Initial.secret),
    }
    alice2.device.importKeyPackagePrivate(alice2Kp.ref, alice2Kp.privateState)

    const bob1Kp = bob1.device.generateKeyPackage(true)

    // Alice-1 adds Alice-2 and Bob-1.
    const add = alice1.device.addMembers(groupId, [alice2Kp.message, bob1Kp.message])
    expect(alice1.device.currentEpoch(groupId)).toBe(1)
    expect(add.welcomes.length).toBeGreaterThan(0)
    expect(add.groupInfo.length).toBeGreaterThan(0)

    const joinA2 = alice2.device.joinFromWelcome(add.welcomes[0] as Uint8Array)
    expect(joinA2.groupId).toEqual(groupId)
    expect(joinA2.epoch).toBe(1)
    expect(joinA2.members).toHaveLength(3)

    const joinB1 = bob1.device.joinFromWelcome(add.welcomes[0] as Uint8Array)
    expect(joinB1.epoch).toBe(1)

    // Everyone exchanges messages.
    const msg1 = alice1.device.encrypt(groupId, utf8('hello from alice-1'))
    const pA2 = alice2.device.processIncoming(groupId, msg1.ciphertext)
    expect(pA2.kind).toBe('application')
    expect(text(pA2.plaintext)).toBe('hello from alice-1')
    expect(pA2.senderDeviceId).toBe(alice1.deviceId)
    expect(pA2.senderAccountId).toBe(alice.accountId())
    const pB1 = bob1.device.processIncoming(groupId, msg1.ciphertext)
    expect(text(pB1.plaintext)).toBe('hello from alice-1')

    const msg2 = bob1.device.encrypt(groupId, utf8('hello from bob-1'))
    expect(text(alice1.device.processIncoming(groupId, msg2.ciphertext).plaintext)).toBe(
      'hello from bob-1',
    )
    expect(text(alice2.device.processIncoming(groupId, msg2.ciphertext).plaintext)).toBe(
      'hello from bob-1',
    )

    // Bob-2 external-joins from published group info.
    const ext = bob2.device.externalJoin(add.groupInfo)
    expect(ext.groupId).toEqual(groupId)
    expect(ext.epoch).toBe(2)

    for (const member of [alice1, alice2, bob1]) {
      const p = member.device.processIncoming(groupId, ext.commit)
      expect(p.kind).toBe('commit')
      expect(p.epoch).toBe(2)
      expect(p.groupInfo).toBeDefined()
      expect(p.senderDeviceId).toBe(bob2.deviceId)
    }

    // Bob-2 decrypts new messages.
    const msg3 = alice2.device.encrypt(groupId, utf8('welcome bob-2'))
    expect(text(bob2.device.processIncoming(groupId, msg3.ciphertext).plaintext)).toBe(
      'welcome bob-2',
    )
    alice1.device.processIncoming(groupId, msg3.ciphertext)
    bob1.device.processIncoming(groupId, msg3.ciphertext)

    // Membership carries parsed identities.
    const members = bob2.device.members(groupId)
    expect(members).toHaveLength(4)
    expect(members.filter((m) => m.accountId === bob.accountId())).toHaveLength(2)
    expect(members.map((m) => m.name)).toContain('alice-laptop')

    // Bob-2 removes Bob-1.
    const removal = bob2.device.removeMembers(groupId, [bob1.deviceId])
    expect(bob2.device.currentEpoch(groupId)).toBe(3)

    for (const member of [alice1, alice2]) {
      const p = member.device.processIncoming(groupId, removal.commit)
      expect(p.kind).toBe('commit')
      expect(p.epoch).toBe(3)
    }
    // Bob-1 learns it was removed.
    expect(bob1.device.processIncoming(groupId, removal.commit).kind).toBe('commit')
    expect(bob2.device.members(groupId)).toHaveLength(3)

    // Removed member cannot decrypt epoch-3 traffic.
    const msg4 = alice1.device.encrypt(groupId, utf8('post-removal'))
    expect(() => bob1.device.processIncoming(groupId, msg4.ciphertext)).toThrow()
    expect(text(bob2.device.processIncoming(groupId, msg4.ciphertext).plaintext)).toBe(
      'post-removal',
    )
    alice2.device.processIncoming(groupId, msg4.ciphertext)

    // Snapshot persist/reload continuation: a brand-new device instance loads
    // Alice-1's latest snapshot and keeps working.
    const reloaded = MlsDevice.create(alice1.credential, alice1.secret)
    reloaded.loadGroup(groupId, msg4.snapshot)
    expect(reloaded.currentEpoch(groupId)).toBe(3)

    const msg5 = reloaded.encrypt(groupId, utf8('after reload'))
    expect(text(alice2.device.processIncoming(groupId, msg5.ciphertext).plaintext)).toBe(
      'after reload',
    )

    const msg6 = bob2.device.encrypt(groupId, utf8('to reloaded alice'))
    expect(text(reloaded.processIncoming(groupId, msg6.ciphertext).plaintext)).toBe(
      'to reloaded alice',
    )
  })

  it('exports epoch-bound secrets shared by members', () => {
    const alice = IdentityKeypair.fromMnemonic(PHRASE_A)
    const a1 = makeDevice(alice, 'a1')
    const a2 = makeDevice(alice, 'a2')
    const a3 = makeDevice(alice, 'a3')
    const groupId = utf8('exporter-test-group')

    a1.device.createGroup(groupId)
    const kp2 = a2.device.generateKeyPackage(false)
    const add = a1.device.addMembers(groupId, [kp2.message])
    a2.device.joinFromWelcome(add.welcomes[0] as Uint8Array)

    // Same epoch, same (label, context, length): equal bytes on both members.
    const s1 = a1.device.exportSecret(groupId, 'gathernet/test', utf8('ctx'), 32)
    const s2 = a2.device.exportSecret(groupId, 'gathernet/test', utf8('ctx'), 32)
    expect(s1).toHaveLength(32)
    expect(hex(s1)).toBe(hex(s2))

    // Non-mutating: epoch unchanged, re-derivation matches.
    expect(a1.device.currentEpoch(groupId)).toBe(1)
    expect(hex(a1.device.exportSecret(groupId, 'gathernet/test', utf8('ctx'), 32))).toBe(hex(s1))

    // Different label/context diverge; other lengths work.
    expect(hex(a1.device.exportSecret(groupId, 'gathernet/other', utf8('ctx'), 32))).not.toBe(
      hex(s1),
    )
    expect(hex(a1.device.exportSecret(groupId, 'gathernet/test', utf8('other'), 32))).not.toBe(
      hex(s1),
    )
    expect(a1.device.exportSecret(groupId, 'gathernet/test', utf8('ctx'), 64)).toHaveLength(64)

    // After a commit (epoch change) the exported secret differs.
    const kp3 = a3.device.generateKeyPackage(false)
    const add2 = a1.device.addMembers(groupId, [kp3.message])
    expect(a2.device.processIncoming(groupId, add2.commit).epoch).toBe(2)
    const s1e2 = a1.device.exportSecret(groupId, 'gathernet/test', utf8('ctx'), 32)
    expect(hex(s1e2)).toBe(hex(a2.device.exportSecret(groupId, 'gathernet/test', utf8('ctx'), 32)))
    expect(hex(s1e2)).not.toBe(hex(s1))
  })
})
