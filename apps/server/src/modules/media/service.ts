import { randomBytes } from 'node:crypto'
import { MESSAGE_MEDIA_MAX_BYTES } from '@gathernet/shared'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { messageMedia } from '../../db/schema.ts'
import { ServiceError } from '../accounts/service.ts'

/**
 * Store an encrypted chat attachment. The server only ever sees ciphertext — the
 * per-file key lives inside the (E2EE) message body. Returns a high-entropy mediaId
 * that the sender embeds in that body; possession of the id is the download token.
 */
export async function uploadMessageMedia(
  db: Db,
  accountId: string,
  ciphertextB64: string,
): Promise<{ mediaId: string }> {
  const ciphertext = Buffer.from(ciphertextB64, 'base64')
  if (ciphertext.length === 0) throw new ServiceError(400, 'empty_media')
  if (ciphertext.length > MESSAGE_MEDIA_MAX_BYTES) throw new ServiceError(413, 'media_too_large')
  const mediaId = `mm_${randomBytes(16).toString('hex')}`
  await db.insert(messageMedia).values({
    mediaId,
    ciphertext,
    sizeBytes: ciphertext.length,
    uploaderAccountId: accountId,
  })
  return { mediaId }
}

/**
 * Fetch an attachment's ciphertext. Auth-gated (any account) — the mediaId is a
 * bearer token that only appears inside E2EE bodies, and the bytes are useless
 * without the per-file key from that body.
 */
export async function getMessageMedia(db: Db, mediaId: string): Promise<Buffer> {
  const row = await db.query.messageMedia.findFirst({
    where: eq(messageMedia.mediaId, mediaId),
  })
  if (!row) throw new ServiceError(404, 'media_not_found')
  return row.ciphertext
}

/** Delete an attachment (delete-for-everyone cleanup) — uploader only; idempotent. */
export async function deleteMessageMedia(
  db: Db,
  accountId: string,
  mediaId: string,
): Promise<void> {
  await db
    .delete(messageMedia)
    .where(and(eq(messageMedia.mediaId, mediaId), eq(messageMedia.uploaderAccountId, accountId)))
}
