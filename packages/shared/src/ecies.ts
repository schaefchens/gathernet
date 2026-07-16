/**
 * ECIES-style sealed box for the device-code grant flow: the Hub seals the
 * per-app storage key to the SDK's ephemeral P-256 key so the server only
 * ever relays ciphertext. WebCrypto only — works in browsers and Node ≥ 20.
 */

const HKDF_INFO = 'gathernet/v1/grant-key-handoff'

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const fromB64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

/**
 * Environment-derived WebCrypto types — avoids naming DOM-lib types
 * (CryptoKey/BufferSource) so this file typechecks in Node and browsers.
 */
type WebCryptoKey = Parameters<(typeof crypto)['subtle']['exportKey']>[1]
type BinaryData = Parameters<(typeof crypto)['subtle']['digest']>[1]

export interface EciesKeypair {
  /** raw SPKI, base64 — safe to send to the server */
  publicKeyB64: string
  privateKey: WebCryptoKey
}

export async function generateEciesKeypair(): Promise<EciesKeypair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  return { publicKeyB64: b64(spki), privateKey: pair.privateKey }
}

async function deriveAesKey(privateKey: WebCryptoKey, peerSpkiB64: string): Promise<WebCryptoKey> {
  const peerKey = await crypto.subtle.importKey(
    'spki',
    fromB64(peerSpkiB64) as BinaryData,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, privateKey, 256)
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Seal `plaintext` to a recipient's public key; returns the sender's ephemeral pk too. */
/**
 * Seal `plaintext` to a recipient public key. The recipient key is bound into
 * the AES-GCM AAD, so a box can only be opened by a party that agrees on the
 * exact recipient — a relaying server that swaps the recipient key cannot make
 * the ciphertext validate against a substituted key.
 */
export async function eciesSeal(
  recipientSpkiB64: string,
  plaintext: Uint8Array,
): Promise<{ sealedB64: string; senderPkB64: string }> {
  const sender = await generateEciesKeypair()
  const aesKey = await deriveAesKey(sender.privateKey, recipientSpkiB64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aad = new TextEncoder().encode(`gathernet/v1/ecies/${recipientSpkiB64}`)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad as BinaryData },
      aesKey,
      plaintext as BinaryData,
    ),
  )
  const sealed = new Uint8Array(iv.length + ciphertext.length)
  sealed.set(iv)
  sealed.set(ciphertext, iv.length)
  return { sealedB64: b64(sealed), senderPkB64: sender.publicKeyB64 }
}

/**
 * Open a sealed box. `recipientPkB64` MUST be the recipient's own public key
 * (SPKI base64) — it is checked via the AAD, and the recipient must supply the
 * key it actually controls, never one relayed by an untrusted party.
 */
export async function eciesOpen(
  recipientPrivateKey: WebCryptoKey,
  senderPkB64: string,
  sealedB64: string,
  recipientPkB64: string,
): Promise<Uint8Array> {
  const aesKey = await deriveAesKey(recipientPrivateKey, senderPkB64)
  const sealed = fromB64(sealedB64)
  const iv = sealed.subarray(0, 12) as BinaryData
  const ciphertext = sealed.subarray(12)
  const aad = new TextEncoder().encode(`gathernet/v1/ecies/${recipientPkB64}`)
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad as BinaryData },
      aesKey,
      ciphertext as BinaryData,
    ),
  )
}
