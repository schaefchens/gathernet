import { randomBytes } from 'node:crypto'
import { MESSAGE_MEDIA_MAX_BYTES } from '@gathernet/shared'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { messageMedia } from '../../db/schema.ts'
import type { BlobStore } from '../../storage/blob-store.ts'
import { ServiceError } from '../accounts/service.ts'

/** Object key for a chat attachment. */
const blobKey = (mediaId: string) => `msg/${mediaId}`

/**
 * Store an encrypted chat attachment: ciphertext → object storage (BlobStore); a
 * metadata row → Postgres (size + uploader, for delete-authorization). The server
 * only ever handles ciphertext — the per-file key stays in the E2EE message body.
 */
export async function uploadMessageMedia(
  db: Db,
  blob: BlobStore,
  accountId: string,
  ciphertextB64: string,
): Promise<{ mediaId: string }> {
  const ciphertext = Buffer.from(ciphertextB64, 'base64')
  if (ciphertext.length === 0) throw new ServiceError(400, 'empty_media')
  if (ciphertext.length > MESSAGE_MEDIA_MAX_BYTES) throw new ServiceError(413, 'media_too_large')
  const mediaId = `mm_${randomBytes(16).toString('hex')}`
  await blob.put(blobKey(mediaId), ciphertext, 'application/octet-stream')
  await db.insert(messageMedia).values({
    mediaId,
    sizeBytes: ciphertext.length,
    uploaderAccountId: accountId,
  })
  return { mediaId }
}

/**
 * Fetch an attachment's ciphertext from object storage. Auth-gated (any account) —
 * the mediaId is a bearer token that only appears inside E2EE bodies, and the bytes
 * are useless without the per-file key. The browser reaches this ONLY through our
 * server; it never talks to the object store directly.
 */
export async function getMessageMedia(db: Db, blob: BlobStore, mediaId: string): Promise<Buffer> {
  const bytes = await blob.get(blobKey(mediaId))
  if (!bytes) throw new ServiceError(404, 'media_not_found')
  return bytes
}

/** Delete an attachment (delete-for-everyone cleanup) — uploader only; idempotent. */
export async function deleteMessageMedia(
  db: Db,
  blob: BlobStore,
  accountId: string,
  mediaId: string,
): Promise<void> {
  const deleted = await db
    .delete(messageMedia)
    .where(and(eq(messageMedia.mediaId, mediaId), eq(messageMedia.uploaderAccountId, accountId)))
    .returning({ mediaId: messageMedia.mediaId })
  // Only drop the blob if we owned (and thus removed) the metadata row.
  if (deleted.length > 0) await blob.delete(blobKey(mediaId))
}
