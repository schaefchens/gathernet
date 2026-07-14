import { z } from 'zod'
import { accountIdSchema, deviceIdSchema, groupIdSchema } from '../ids.ts'

/** Server → client WS messages. */

export const presenceStatusSchema = z.enum(['online', 'away', 'offline'])

export const helloOkMessage = z.object({
  type: z.literal('hello.ok'),
  replyTo: z.string(),
  payload: z.object({
    accountId: accountIdSchema,
    deviceId: deviceIdSchema,
    serverTime: z.number().int(),
    /** unclaimed key packages remaining for this device */
    kpRemaining: z.number().int().nonnegative(),
    pending: z.object({
      welcomes: z.number().int().nonnegative(),
      messages: z.number().int().nonnegative(),
    }),
  }),
})

export const helloErrorMessage = z.object({
  type: z.literal('hello.error'),
  replyTo: z.string(),
  payload: z.object({
    code: z.enum(['unauthorized', 'protocol_version', 'revoked']),
  }),
})

export const ackMessage = z.object({
  type: z.literal('ack'),
  replyTo: z.string(),
  payload: z.object({
    result: z.unknown().optional(),
  }),
})

export const errorMessage = z.object({
  type: z.literal('error'),
  replyTo: z.string().optional(),
  payload: z.object({
    code: z.string(),
    message: z.string().optional(),
  }),
})

export const presenceSnapshotMessage = z.object({
  type: z.literal('presence.snapshot'),
  payload: z.object({
    friends: z.array(
      z.object({
        accountId: accountIdSchema,
        status: presenceStatusSchema,
      }),
    ),
  }),
})

export const presenceUpdateMessage = z.object({
  type: z.literal('presence.update'),
  payload: z.object({
    accountId: accountIdSchema,
    status: presenceStatusSchema,
  }),
})

export const friendAddedMessage = z.object({
  type: z.literal('friend.added'),
  payload: z.object({
    accountId: accountIdSchema,
    displayName: z.string(),
  }),
})

export const friendRemovedMessage = z.object({
  type: z.literal('friend.removed'),
  payload: z.object({
    accountId: accountIdSchema,
  }),
})

export const chatMessageMessage = z.object({
  type: z.literal('chat.message'),
  payload: z.object({
    groupId: groupIdSchema,
    seq: z.number().int().nonnegative(),
    kind: z.enum(['application', 'commit', 'proposal']),
    epoch: z.number().int().nonnegative(),
    senderDevice: deviceIdSchema,
    /** base64 MLS message — opaque to the server */
    payload: z.string(),
    sentAt: z.number().int(),
  }),
})

export const welcomeMessage = z.object({
  type: z.literal('welcome'),
  payload: z.object({
    welcomeId: z.number().int().nonnegative(),
    groupId: groupIdSchema,
    /** base64 MLS Welcome */
    payload: z.string(),
  }),
})

export const groupCreatedMessage = z.object({
  type: z.literal('group.created'),
  payload: z.object({
    groupId: groupIdSchema,
    friendAccountId: accountIdSchema,
    /** true for the account whose device must build the MLS group */
    creator: z.boolean(),
  }),
})

export const deviceRevokedMessage = z.object({
  type: z.literal('device.revoked'),
  payload: z.object({
    accountId: accountIdSchema,
    deviceId: deviceIdSchema,
  }),
})

export const sessionRevokedMessage = z.object({
  type: z.literal('session.revoked'),
  payload: z.object({}),
})

export const serverMessageSchema = z.discriminatedUnion('type', [
  helloOkMessage,
  helloErrorMessage,
  ackMessage,
  errorMessage,
  presenceSnapshotMessage,
  presenceUpdateMessage,
  friendAddedMessage,
  friendRemovedMessage,
  chatMessageMessage,
  welcomeMessage,
  groupCreatedMessage,
  deviceRevokedMessage,
  sessionRevokedMessage,
])

export type ServerMessage = z.infer<typeof serverMessageSchema>
export type ServerMessageType = ServerMessage['type']
