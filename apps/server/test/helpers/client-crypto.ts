import { createHash, generateKeyPairSync, type KeyObject, sign as nodeSign } from 'node:crypto'
import { SIG_DOMAIN } from '@gathernet/shared'
import { Encoder } from 'cbor-x'

/**
 * Test-side stand-in for the WASM client crypto: real Ed25519 keys and a
 * CBOR device cert with the same array layout as crates/mls-wasm.
 */

const encoder = new Encoder({ tagUint8Array: false })

export interface TestKeypair {
  publicRaw: Buffer
  privateKey: KeyObject
}

export function generateEd25519(): TestKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  return { publicRaw: Buffer.from(spki.subarray(spki.length - 32)), privateKey }
}

export function sign(keypair: TestKeypair, ...parts: Buffer[]): Buffer {
  return nodeSign(null, Buffer.concat(parts), keypair.privateKey)
}

export function deviceIdOf(devicePk: Buffer): string {
  return createHash('sha256').update(devicePk).digest().subarray(0, 16).toString('hex')
}

export function buildDeviceCert(
  identity: TestKeypair,
  device: TestKeypair,
  name: string,
): { certBytes: Buffer; certSig: Buffer; deviceId: string } {
  const deviceIdBytes = createHash('sha256').update(device.publicRaw).digest().subarray(0, 16)
  const certBytes = Buffer.from(
    encoder.encode([
      1,
      identity.publicRaw,
      device.publicRaw,
      deviceIdBytes,
      name,
      Math.floor(Date.now() / 1000),
    ]),
  )
  const certSig = sign(identity, Buffer.from(SIG_DOMAIN.deviceCert, 'utf8'), certBytes)
  return { certBytes, certSig, deviceId: deviceIdBytes.toString('hex') }
}

export interface EnrollmentBody {
  accountPk: string
  deviceCert: string
  certSig: string
  challenge: string
  identitySig: string
  deviceSig: string
}

export function buildEnrollment(
  identity: TestKeypair,
  device: TestKeypair,
  challengeB64: string,
  deviceName: string,
): { body: EnrollmentBody; deviceId: string } {
  const { certBytes, certSig, deviceId } = buildDeviceCert(identity, device, deviceName)
  const challenge = Buffer.from(challengeB64, 'base64')
  const domain = Buffer.from(SIG_DOMAIN.enroll, 'utf8')
  return {
    deviceId,
    body: {
      accountPk: identity.publicRaw.toString('base64'),
      deviceCert: certBytes.toString('base64'),
      certSig: certSig.toString('base64'),
      challenge: challengeB64,
      identitySig: sign(identity, domain, challenge, certBytes).toString('base64'),
      deviceSig: sign(device, domain, challenge, certBytes).toString('base64'),
    },
  }
}

export function buildLoginSig(device: TestKeypair, deviceId: string, challengeB64: string): string {
  return sign(
    device,
    Buffer.from(SIG_DOMAIN.auth, 'utf8'),
    Buffer.from(challengeB64, 'base64'),
    Buffer.from(deviceId, 'utf8'),
  ).toString('base64')
}
