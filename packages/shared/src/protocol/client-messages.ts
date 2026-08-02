import { z } from 'zod'
import { ROOM_EPHEMERAL_MAX_BYTES } from '../constants.ts'
import { deviceIdSchema, groupIdSchema } from '../ids.ts'

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
    /**
     * App sessions (`gna.` tokens) only: bind this socket to a registered
     * app device (rooms MLS leaf). Omitted → the newest registered device.
     * Ignored for user sessions — their device comes from the token.
     */
    deviceId: deviceIdSchema.optional(),
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

/**
 * Subscribe/unsubscribe this socket to a group_key channel's delivery nudges.
 * Large channels don't push ciphertext to every member — they push a tiny
 * `channel.updated {seq}` to subscribed (i.e. currently-open) sockets, which
 * then pull the ciphertext from the mailbox. The server verifies active
 * membership before subscribing.
 */
export const channelSubscribeMessage = z.object({
  type: z.literal('channel.subscribe'),
  id: z.string().min(1),
  payload: z.object({ channelId: groupIdSchema }),
})

export const channelUnsubscribeMessage = z.object({
  type: z.literal('channel.unsubscribe'),
  id: z.string().min(1),
  payload: z.object({ channelId: groupIdSchema }),
})

/** Fire-and-forget room fan-out (cursor/pointer/typing …) — never persisted. */
export const roomEphemeralClientMessage = z.object({
  type: z.literal('room.ephemeral'),
  id: z.string().min(1),
  payload: z.object({
    groupId: groupIdSchema,
    epoch: z.number().int().nonnegative(),
    /** base64, ≤ ROOM_EPHEMERAL_MAX_BYTES decoded — opaque to the server */
    payload: z
      .base64()
      .min(1)
      .max(Math.ceil(ROOM_EPHEMERAL_MAX_BYTES / 3) * 4),
  }),
})

export const clientMessageSchema = z.discriminatedUnion('type', [
  helloMessage,
  presenceSetMessage,
  chatSendMessage,
  chatAckMessage,
  welcomeAckMessage,
  channelSubscribeMessage,
  channelUnsubscribeMessage,
  roomEphemeralClientMessage,
])

export type ClientMessage = z.infer<typeof clientMessageSchema>
export type ClientMessageType = ClientMessage['type']
