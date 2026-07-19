import { z } from 'zod'
import {
  channelMemberRoleSchema,
  channelMyStatusSchema,
  communityRoleSchema,
} from '../api/communities.ts'
import {
  accountIdSchema,
  appUserIdSchema,
  communityIdSchema,
  deviceIdSchema,
  groupIdSchema,
} from '../ids.ts'

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

/* ---------- rooms (roomId == MLS groupId) ---------- */

/** Live relay of a room.ephemeral client frame — never persisted. */
export const roomEphemeralMessage = z.object({
  type: z.literal('room.ephemeral'),
  payload: z.object({
    groupId: groupIdSchema,
    epoch: z.number().int().nonnegative(),
    /** may be a real device id or an app device id — same hex32 shape */
    senderDevice: deviceIdSchema,
    payload: z.string(),
  }),
})

export const roomMemberJoinedMessage = z.object({
  type: z.literal('room.member_joined'),
  payload: z.object({
    roomId: groupIdSchema,
    appUserId: appUserIdSchema,
    displayName: z.string(),
  }),
})

export const roomMemberLeftMessage = z.object({
  type: z.literal('room.member_left'),
  payload: z.object({
    roomId: groupIdSchema,
    appUserId: appUserIdSchema,
  }),
})

export const roomMemberKickedMessage = z.object({
  type: z.literal('room.member_kicked'),
  payload: z.object({
    roomId: groupIdSchema,
    appUserId: appUserIdSchema,
  }),
})

export const roomHostChangedMessage = z.object({
  type: z.literal('room.host_changed'),
  payload: z.object({
    roomId: groupIdSchema,
    hostAppUserId: appUserIdSchema,
  }),
})

export const roomJoinRequestMessage = z.object({
  type: z.literal('room.join_request'),
  payload: z.object({
    roomId: groupIdSchema,
    requestId: z.string(),
    appUserId: appUserIdSchema,
    displayName: z.string(),
  }),
})

export const roomJoinApprovedMessage = z.object({
  type: z.literal('room.join_approved'),
  payload: z.object({
    roomId: groupIdSchema,
    /** latest GroupInfo for the external join */
    groupInfo: z.base64().nullable(),
    epoch: z.number().int().nonnegative(),
  }),
})

export const roomJoinDeclinedMessage = z.object({
  type: z.literal('room.join_declined'),
  payload: z.object({
    roomId: groupIdSchema,
  }),
})

export const roomPhaseMessage = z.object({
  type: z.literal('room.phase'),
  payload: z.object({
    roomId: groupIdSchema,
    phase: z.enum(['open', 'in_progress']),
  }),
})

export const roomClosedMessage = z.object({
  type: z.literal('room.closed'),
  payload: z.object({
    roomId: groupIdSchema,
    reason: z.string(),
  }),
})

/* ---------- communities (channelId == MLS groupId) ---------- */

export const communityMemberJoinedMessage = z.object({
  type: z.literal('community.member_joined'),
  payload: z.object({
    communityId: communityIdSchema,
    accountId: accountIdSchema,
    displayName: z.string(),
  }),
})

export const communityMemberLeftMessage = z.object({
  type: z.literal('community.member_left'),
  payload: z.object({
    communityId: communityIdSchema,
    accountId: accountIdSchema,
  }),
})

export const communityMemberRemovedMessage = z.object({
  type: z.literal('community.member_removed'),
  payload: z.object({
    communityId: communityIdSchema,
    accountId: accountIdSchema,
  }),
})

export const communityRoleChangedMessage = z.object({
  type: z.literal('community.role_changed'),
  payload: z.object({
    communityId: communityIdSchema,
    accountId: accountIdSchema,
    role: communityRoleSchema,
  }),
})

/** Community display metadata (name/avatar) changed — clients refetch + redecrypt. */
export const communityUpdatedMessage = z.object({
  type: z.literal('community.updated'),
  payload: z.object({
    communityId: communityIdSchema,
  }),
})

/** To a grantee account: a K_meta grant is available — a device lacking the key
 *  can fetch + open it (cross-device sync). */
export const communityKeyGrantsMessage = z.object({
  type: z.literal('community.key_grants_available'),
  payload: z.object({
    communityId: communityIdSchema,
  }),
})

/** To remaining community leaders: a member left/was removed → a leader's client
 *  should rotate K_meta (re-encrypt metadata under a new epoch). */
export const communityRotationNeededMessage = z.object({
  type: z.literal('community.rotation_needed'),
  payload: z.object({
    communityId: communityIdSchema,
  }),
})

export const communityChannelCreatedMessage = z.object({
  type: z.literal('community.channel_created'),
  payload: z.object({
    communityId: communityIdSchema,
    channelId: groupIdSchema,
  }),
})

export const communityChannelUpdatedMessage = z.object({
  type: z.literal('community.channel_updated'),
  payload: z.object({
    communityId: communityIdSchema,
    channelId: groupIdSchema,
  }),
})

export const communityChannelDeletedMessage = z.object({
  type: z.literal('community.channel_deleted'),
  payload: z.object({
    communityId: communityIdSchema,
    channelId: groupIdSchema,
  }),
})

/** To channel moderators + community leaders: someone requested to join. */
export const communityChannelJoinRequestMessage = z.object({
  type: z.literal('community.channel_join_request'),
  payload: z.object({
    communityId: communityIdSchema,
    channelId: groupIdSchema,
    accountId: accountIdSchema,
    displayName: z.string(),
  }),
})

/** To the requester: a moderator accepted — carries GroupInfo for the join. */
export const communityChannelJoinApprovedMessage = z.object({
  type: z.literal('community.channel_join_approved'),
  payload: z.object({
    communityId: communityIdSchema,
    channelId: groupIdSchema,
    groupInfo: z.base64().nullable(),
    epoch: z.number().int().nonnegative(),
  }),
})

/** To the requester: a moderator declined the join request. */
export const communityChannelJoinDeclinedMessage = z.object({
  type: z.literal('community.channel_join_declined'),
  payload: z.object({
    communityId: communityIdSchema,
    channelId: groupIdSchema,
  }),
})

/** To the invitee: a moderator invited them to a channel (they may accept). */
export const communityChannelInvitedMessage = z.object({
  type: z.literal('community.channel_invited'),
  payload: z.object({
    communityId: communityIdSchema,
    channelId: groupIdSchema,
  }),
})

/**
 * To active channel members + community leaders + the affected account: a
 * channel membership changed (joined/left/kicked/moderator-set). `status` is
 * the new channel-membership state; `role` the new channel role.
 */
export const communityChannelMemberChangedMessage = z.object({
  type: z.literal('community.channel_member_changed'),
  payload: z.object({
    communityId: communityIdSchema,
    channelId: groupIdSchema,
    accountId: accountIdSchema,
    status: channelMyStatusSchema,
    role: channelMemberRoleSchema,
  }),
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
  roomEphemeralMessage,
  roomMemberJoinedMessage,
  roomMemberLeftMessage,
  roomMemberKickedMessage,
  roomHostChangedMessage,
  roomJoinRequestMessage,
  roomJoinApprovedMessage,
  roomJoinDeclinedMessage,
  roomPhaseMessage,
  roomClosedMessage,
  communityMemberJoinedMessage,
  communityMemberLeftMessage,
  communityMemberRemovedMessage,
  communityRoleChangedMessage,
  communityUpdatedMessage,
  communityKeyGrantsMessage,
  communityRotationNeededMessage,
  communityChannelCreatedMessage,
  communityChannelUpdatedMessage,
  communityChannelDeletedMessage,
  communityChannelJoinRequestMessage,
  communityChannelJoinApprovedMessage,
  communityChannelJoinDeclinedMessage,
  communityChannelInvitedMessage,
  communityChannelMemberChangedMessage,
])

export type ServerMessage = z.infer<typeof serverMessageSchema>
export type ServerMessageType = ServerMessage['type']
