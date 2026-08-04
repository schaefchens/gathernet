/**
 * Encrypted chat attachments (images/files/voice). A file is sealed client-side with
 * a FRESH per-file key (XChaCha20-Poly1305); only the ciphertext is uploaded, and the
 * key travels inside the E2EE message body (see message-body.ts). The server stores
 * an opaque blob keyed by a high-entropy mediaId and never sees the key — a downloaded
 * blob is undecryptable on its own.
 */

import { MESSAGE_MEDIA_MAX_BYTES } from '@gathernet/shared'
import { api, apiBytes } from './api.ts'
import { fromStdB64, toStdB64 } from './community-keys.ts'
import type { MediaRef } from './message-body.ts'
import { loadCrypto } from './mls.ts'

/** Domain-separates attachment AEAD from every other seal() use. */
const MEDIA_AAD = new TextEncoder().encode('gathernet:message-media:v1')

/** Encrypt a file with a fresh key, upload the ciphertext, return the E2EE MediaRef. */
export async function encryptAndUpload(
  file: Blob,
  extra?: { name?: string; durationMs?: number; width?: number; height?: number },
): Promise<MediaRef> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mls = await loadCrypto()
  const key = crypto.getRandomValues(new Uint8Array(32))
  const ciphertext = mls.seal(key, bytes, MEDIA_AAD)
  if (ciphertext.length > MESSAGE_MEDIA_MAX_BYTES) throw new Error('media_too_large')
  const { mediaId } = await api<{ mediaId: string }>('POST', '/api/v1/media', {
    ciphertext: toStdB64(ciphertext),
  })
  return {
    mediaId,
    key: toStdB64(key),
    mime: file.type || 'application/octet-stream',
    size: bytes.length,
    ...(extra?.name ? { name: extra.name } : {}),
    ...(extra?.durationMs ? { durationMs: extra.durationMs } : {}),
    ...(extra?.width ? { width: extra.width } : {}),
    ...(extra?.height ? { height: extra.height } : {}),
  }
}

/**
 * Duplicate a media blob into a fresh, caller-owned copy and return a MediaRef with
 * the new mediaId (same per-file key). Used when pinning a message's attachment so
 * the pin owns its blob and survives the original message's deletion/TTL.
 */
export async function copyMedia(ref: MediaRef): Promise<MediaRef> {
  const { mediaId } = await api<{ mediaId: string }>('POST', `/api/v1/media/${ref.mediaId}/copy`)
  return { ...ref, mediaId }
}

/** Download an attachment's ciphertext + decrypt it with the key from the body → Blob. */
export async function downloadAndDecrypt(ref: MediaRef): Promise<Blob> {
  const ciphertext = await apiBytes(`/api/v1/media/${ref.mediaId}`)
  const mls = await loadCrypto()
  const bytes = mls.open(fromStdB64(ref.key), ciphertext, MEDIA_AAD)
  return new Blob([bytes as BlobPart], { type: ref.mime })
}
