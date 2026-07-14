import { z } from 'zod'
import { groupIdSchema } from '../ids.ts'

/**
 * Client → server WS messages. Every message carries a client-generated
 * ulid `id`; the server answers each with exactly one `ack` or `error`
 * whose `replyTo` echoes that id.
 */

export const helloMessage = z.object({
  type: z.literal('hello'),
  id: z.string().min(1),
  payload: z.object({
    token: z.string().min(1),
    protocolVersion: z.number().int().positive(),
  }),
})

export const presenceSetMessage = z.object({
  type: z.literal('presence.set'),
  id: z.string().min(1),
  payload: z.object({
    status: z.enum(['online', 'away', 'invisible']),
  }),
})

export const chatSendMessage = z.object({
  type: z.literal('chat.send'),
  id: z.string().min(1),
  payload: z.object({
    groupId: groupIdSchema,
    epoch: z.number().int().nonnegative(),
    /** base64 MLS application message — opaque to the server */
    ciphertext: z.string().min(1),
  }),
})

export const chatAckMessage = z.object({
  type: z.literal('chat.ack'),
  id: z.string().min(1),
  payload: z.object({
    groupId: groupIdSchema,
    seq: z.number().int().nonnegative(),
  }),
})

export const welcomeAckMessage = z.object({
  type: z.literal('welcome.ack'),
  id: z.string().min(1),
  payload: z.object({
    welcomeId: z.number().int().nonnegative(),
  }),
})

export const clientMessageSchema = z.discriminatedUnion('type', [
  helloMessage,
  presenceSetMessage,
  chatSendMessage,
  chatAckMessage,
  welcomeAckMessage,
])

export type ClientMessage = z.infer<typeof clientMessageSchema>
export type ClientMessageType = ClientMessage['type']
