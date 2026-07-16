import { SIG_DOMAIN } from '@gathernet/shared'

/**
 * Room MLS helpers. Rooms use SELF-SIGNED device credentials: the SDK
 * generates a fresh Ed25519 keypair and builds a DeviceCert whose accountPk
 * equals its devicePk, signed by the device key itself. These interoperate in
 * one MLS group with real (identity-signed) device credentials — the server
 * authorizes membership out-of-band via the app_devices table, so the MLS
 * credential's self-asserted account is never trusted for authorization.
 *
 * The cert `name` field carries the pseudonymous appUserId, so any member can
 * map a decrypted message's sender device to its appUserId locally (via
 * MlsDevice.members) without the server ever revealing device↔user links.
 */

/** The subset of @gathernet/mls-client the rooms client consumes. */
export type MlsModule = typeof import('@gathernet/mls-client')
/** MlsDevice has a private constructor, so derive the instance type from `create`. */
export type MlsDevice = ReturnType<MlsModule['MlsDevice']['create']>

export interface RoomDevice {
  device: MlsDevice
  /** hex(first 16 bytes of SHA-256(devicePk)) — matches the server's rule. */
  deviceId: string
  /** 32-byte Ed25519 seed (kept in memory for reconnects). */
  secret: Uint8Array
  /** raw 32-byte Ed25519 public key. */
  publicKey: Uint8Array
}

const encoder = new TextEncoder()

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * Build a self-signed room device. Pass an existing `secret` to rebuild the
 * same device (e.g. after a reconnect); omit it to generate a new one. `name`
 * is the appUserId the credential advertises to other members.
 */
export function buildRoomDevice(mls: MlsModule, name: string, secret?: Uint8Array): RoomDevice {
  const dk = secret ? mls.DeviceKeypair.fromSecret(secret) : mls.DeviceKeypair.generate()
  try {
    const devicePk = dk.publicKey()
    const deviceSecret = dk.secret()
    const cert = mls.encodeDeviceCert(devicePk, devicePk, name, Math.floor(Date.now() / 1000))
    const selfSig = mls.ed25519Sign(
      deviceSecret,
      concat(encoder.encode(SIG_DOMAIN.deviceCert), cert),
    )
    const credential = mls.makeCredential(cert, selfSig)
    return {
      device: mls.MlsDevice.create(credential, deviceSecret),
      deviceId: dk.deviceId(),
      secret: deviceSecret,
      publicKey: devicePk,
    }
  } finally {
    dk.free()
  }
}
