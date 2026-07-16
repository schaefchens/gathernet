import { z } from 'zod'
import { ROOM_MAX_MEMBERS } from '../constants.ts'
import { appUserIdSchema, deviceIdSchema, groupIdSchema, roomCodeSchema } from '../ids.ts'

/**
 * E2EE rooms — app-token surface (`/api/v1/app/…`, Bearer `gna.` + scope
 * 'rooms'). A room's `roomId` doubles as the MLS groupId (groups.kind='room').
 */

export const roomVisibilitySchema = z.enum(['public', 'private'])
export const roomPhaseSchema = z.enum(['open', 'in_progress', 'closed'])
export type RoomVisibility = z.infer<typeof roomVisibilitySchema>
export type RoomPhase = z.infer<typeof roomPhaseSchema>

const compatTagSchema = z.string().trim().min(1).max(64)

/**
 * SDK-side room device registration. The SDK generates its own Ed25519
 * keypair and builds a SELF-SIGNED DeviceCert-shaped MLS credential
 * (accountPk == devicePk, cert signed by the device key). deviceId =
 * hex(first 16 bytes of SHA-256(devicePk)), exactly like real devices.
 */
export const registerAppDeviceRequestSchema = z.object({
  /** raw 32-byte Ed25519 public key, base64 */
  devicePk: z.base64(),
  name: z.string().trim().min(1).max(60),
})

export const registerAppDeviceResponseSchema = z.object({
  deviceId: deviceIdSchema,
})

export const createRoomRequestSchema = z.object({
  visibility: roomVisibilitySchema,
  title: z.string().trim().min(1).max(80),
  maxMembers: z.number().int().min(2).max(ROOM_MAX_MEMBERS).default(ROOM_MAX_MEMBERS),
  /** opaque app version fingerprint; joining requires exact equality */
  compatTag: compatTagSchema,
})

export const createRoomResponseSchema = z.object({
  roomId: groupIdSchema,
  code: roomCodeSchema,
})

/** Epoch-0 GroupInfo publish — the host's first act after creating the MLS group. */
export const publishRoomGroupInfoRequestSchema = z.object({
  groupInfo: z.base64(),
  /** the host's registered app device (becomes the first MLS leaf) */
  deviceId: deviceIdSchema,
})

export const roomBrowserItemSchema = z.object({
  roomId: groupIdSchema,
  title: z.string(),
  memberCount: z.number().int().nonnegative(),
  maxMembers: z.number().int().positive(),
  compatTag: z.string(),
})

export const listRoomsResponseSchema = z.object({
  rooms: z.array(roomBrowserItemSchema),
})

export const joinRoomRequestSchema = z
  .object({
    code: roomCodeSchema.optional(),
    roomId: groupIdSchema.optional(),
    compatTag: compatTagSchema,
    deviceId: deviceIdSchema,
  })
  .refine((v) => v.code !== undefined || v.roomId !== undefined, {
    message: 'code or roomId required',
  })

export const joinRoomResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('joined'),
    roomId: groupIdSchema,
    code: roomCodeSchema,
    /** latest GroupInfo for the external join — null until the host publishes */
    groupInfo: z.base64().nullable(),
    epoch: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('pending'),
    requestId: z.uuid(),
  }),
])

export const roomMemberSchema = z.object({
  appUserId: appUserIdSchema,
  displayName: z.string(),
  isHost: z.boolean(),
  isService: z.boolean(),
  /** active MLS leaves owned by this member's account */
  deviceCount: z.number().int().nonnegative(),
})

export const roomDetailResponseSchema = z.object({
  roomId: groupIdSchema,
  code: roomCodeSchema,
  title: z.string(),
  phase: roomPhaseSchema,
  visibility: roomVisibilitySchema,
  hostAppUserId: appUserIdSchema,
  groupInfo: z.base64().nullable(),
  epoch: z.number().int().nonnegative(),
  members: z.array(roomMemberSchema),
})

export const roomJoinRequestSummarySchema = z.object({
  requestId: z.uuid(),
  appUserId: appUserIdSchema,
  displayName: z.string(),
  createdAt: z.number().int(),
})

export const listRoomJoinRequestsResponseSchema = z.object({
  requests: z.array(roomJoinRequestSummarySchema),
})

export const resolveRoomJoinRequestSchema = z.object({
  action: z.enum(['approve', 'decline']),
})

export const kickRoomMemberRequestSchema = z.object({
  appUserId: appUserIdSchema,
})

export const setRoomPhaseRequestSchema = z.object({
  phase: z.enum(['open', 'in_progress']),
})

export type RegisterAppDeviceRequest = z.infer<typeof registerAppDeviceRequestSchema>
export type RegisterAppDeviceResponse = z.infer<typeof registerAppDeviceResponseSchema>
export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>
export type PublishRoomGroupInfoRequest = z.infer<typeof publishRoomGroupInfoRequestSchema>
export type RoomBrowserItem = z.infer<typeof roomBrowserItemSchema>
export type JoinRoomRequest = z.infer<typeof joinRoomRequestSchema>
export type JoinRoomResponse = z.infer<typeof joinRoomResponseSchema>
export type RoomMember = z.infer<typeof roomMemberSchema>
export type RoomDetailResponse = z.infer<typeof roomDetailResponseSchema>
export type RoomJoinRequestSummary = z.infer<typeof roomJoinRequestSummarySchema>
export type ResolveRoomJoinRequest = z.infer<typeof resolveRoomJoinRequestSchema>
export type KickRoomMemberRequest = z.infer<typeof kickRoomMemberRequestSchema>
export type SetRoomPhaseRequest = z.infer<typeof setRoomPhaseRequestSchema>
