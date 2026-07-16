/**
 * Client-side sealing for cloud saves: AES-256-GCM under the per-app key,
 * AAD binds ciphertext to (appId, storage key) so blobs can't be swapped.
 * Envelope: [0x01 version][12B IV][ciphertext+tag].
 */

const VERSION = 0x01
const encoder = new TextEncoder()

type BinaryData = Parameters<(typeof crypto)['subtle']['digest']>[1]

async function importAesKey(rawKey: Uint8Array) {
  return crypto.subtle.importKey('raw', rawKey as BinaryData, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

const aad = (appId: string, key: string): Uint8Array => encoder.encode(`gnapp/v1/${appId}/${key}`)

export async function sealBlob(
  rawKey: Uint8Array,
  appId: string,
  key: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const aesKey = await importAesKey(rawKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(appId, key) as BinaryData },
      aesKey,
      plaintext as BinaryData,
    ),
  )
  const out = new Uint8Array(1 + iv.length + ciphertext.length)
  out[0] = VERSION
  out.set(iv, 1)
  out.set(ciphertext, 13)
  return out
}

export async function openBlob(
  rawKey: Uint8Array,
  appId: string,
  key: string,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  if (sealed[0] !== VERSION) throw new Error('unsupported blob version')
  const aesKey = await importAesKey(rawKey)
  const iv = sealed.subarray(1, 13) as BinaryData
  const ciphertext = sealed.subarray(13) as BinaryData
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(appId, key) as BinaryData },
      aesKey,
      ciphertext,
    ),
  )
}
