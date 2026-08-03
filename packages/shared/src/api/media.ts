import { z } from 'zod'

/**
 * Chat-attachment media (images/files/voice). The client uploads ONLY ciphertext
 * (sealed with a fresh per-file key that stays inside the E2EE message body); the
 * server stores the opaque blob and hands back a high-entropy `mediaId`. Downloads
 * are raw octet-stream (see the GET route), not modelled here.
 */
export const uploadMessageMediaRequestSchema = z.object({
  /** base64 ciphertext */
  ciphertext: z.base64(),
})

export const uploadMessageMediaResponseSchema = z.object({
  mediaId: z.string(),
})

export type UploadMessageMediaRequest = z.infer<typeof uploadMessageMediaRequestSchema>
export type UploadMessageMediaResponse = z.infer<typeof uploadMessageMediaResponseSchema>
