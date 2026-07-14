import { SIG_DOMAIN } from '@gathernet/shared'
import { decode } from 'cbor-x'
import { ed25519Verify, safeEqual, sha256, sigPayload } from './crypto.ts'

export interface DeviceCert {
  version: number
  accountPk: Buffer
  devicePk: Buffer
  /** hex(first 16 bytes of SHA-256(devicePk)) */
  deviceId: string
  name: string
  createdAt: number
}

export type CertError = 'malformed' | 'unsupported_version' | 'device_id_mismatch' | 'bad_signature'

/**
 * Decode + validate a client-supplied DeviceCert. The signature is verified
 * over the exact bytes received (the server never re-encodes), so CBOR
 * canonicalization differences between encoders cannot break verification.
 */
export function verifyDeviceCert(
  certBytes: Buffer,
  certSig: Buffer,
): { ok: true; cert: DeviceCert } | { ok: false; error: CertError } {
  let decoded: unknown
  try {
    decoded = decode(certBytes)
  } catch {
    return { ok: false, error: 'malformed' }
  }
  if (!Array.isArray(decoded) || decoded.length !== 6) {
    return { ok: false, error: 'malformed' }
  }
  const [version, accountPk, devicePk, deviceIdBytes, name, createdAt] = decoded as unknown[]
  if (
    typeof version !== 'number' ||
    !(accountPk instanceof Uint8Array) ||
    !(devicePk instanceof Uint8Array) ||
    !(deviceIdBytes instanceof Uint8Array) ||
    typeof name !== 'string' ||
    (typeof createdAt !== 'number' && typeof createdAt !== 'bigint')
  ) {
    return { ok: false, error: 'malformed' }
  }
  if (version !== 1) return { ok: false, error: 'unsupported_version' }
  const accountPkBuf = Buffer.from(accountPk)
  const devicePkBuf = Buffer.from(devicePk)
  if (accountPkBuf.length !== 32 || devicePkBuf.length !== 32 || deviceIdBytes.length !== 16) {
    return { ok: false, error: 'malformed' }
  }

  const expectedDeviceId = sha256(devicePkBuf).subarray(0, 16)
  if (!safeEqual(Buffer.from(deviceIdBytes), expectedDeviceId)) {
    return { ok: false, error: 'device_id_mismatch' }
  }

  if (!ed25519Verify(accountPkBuf, sigPayload(SIG_DOMAIN.deviceCert, certBytes), certSig)) {
    return { ok: false, error: 'bad_signature' }
  }

  return {
    ok: true,
    cert: {
      version,
      accountPk: accountPkBuf,
      devicePk: devicePkBuf,
      deviceId: expectedDeviceId.toString('hex'),
      name,
      createdAt: Number(createdAt),
    },
  }
}
