/**
 * Per-app storage-key derivation for the M2 app-grant flows.
 *
 * The mnemonic-derived storage root is persisted (DMK-sealed) at enrollment;
 * per-app keys are derived from it with HKDF so an app's key can only ever
 * decrypt that app's own saves. Accounts enrolled before M2 have no root on
 * this device — {@link backfillStorageRoot} re-derives it from the recovery
 * phrase without touching the identity key beyond an account-id check.
 */

import { loadCrypto } from './mls.ts'
import { metaStore, secureStore } from './storage.ts'

const encoder = new TextEncoder()

/**
 * HKDF-SHA256(root, salt=0^32, info='gathernet/v1/app-storage/'+appId, 256 bit).
 * Returns null when this device has no storage root (pre-M2 account).
 */
export async function getPerAppStorageKey(appId: string): Promise<Uint8Array | null> {
  const root = await secureStore.getStorageRoot()
  if (!root) return null
  const hkdfKey = await globalThis.crypto.subtle.importKey(
    'raw',
    root as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  )
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: encoder.encode(`gathernet/v1/app-storage/${appId}`),
    },
    hkdfKey,
    256,
  )
  return new Uint8Array(bits)
}

/**
 * Re-derive and persist the storage root from the recovery phrase (pre-M2
 * accounts). Returns false when the phrase is invalid or belongs to a
 * different account than the one enrolled on this device.
 */
export async function backfillStorageRoot(phrase: string): Promise<boolean> {
  const mlsCrypto = await loadCrypto()
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ')
  if (!mlsCrypto.validateMnemonic(normalized)) return false
  const meta = await metaStore.get()
  if (!meta) return false
  const identity = mlsCrypto.identityFromMnemonic(normalized)
  try {
    if (identity.accountId !== meta.accountId) return false
    await secureStore.putStorageRoot(mlsCrypto.deriveStorageRoot(normalized))
    return true
  } finally {
    identity.zeroize()
  }
}
