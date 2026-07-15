import { z } from 'zod'

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

/** base58(account public key) — self-authenticating account identifier */
export type AccountId = Brand<string, 'AccountId'>
/** hex(first 16 bytes of SHA-256(device public key)) */
export type DeviceId = Brand<string, 'DeviceId'>
/** hex(16 random bytes) chosen by the group creator */
export type GroupId = Brand<string, 'GroupId'>
/** crockford-base32 friend invite code */
export type InviteCode = Brand<string, 'InviteCode'>

/** publication id ('pub_' + 16 hex) — doubles as the appId for kind app|game */
export type AppId = Brand<string, 'AppId'>
/** pseudonymous per-(app,account) user id ('au_' + 32 hex) */
export type AppUserId = Brand<string, 'AppUserId'>
/** device-flow grant code (8 crockford chars) */
export type GrantUserCode = Brand<string, 'GrantUserCode'>
/** room join code (4 chars, unambiguous alphabet) */
export type RoomCode = Brand<string, 'RoomCode'>
/** community id ('cm_' + 16 hex) */
export type CommunityId = Brand<string, 'CommunityId'>

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,50}$/
const HEX32_RE = /^[0-9a-f]{32}$/
const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/
const APP_ID_RE = /^pub_[0-9a-f]{16}$/
const APP_USER_ID_RE = /^au_[0-9a-f]{32}$/
const GRANT_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/
const ROOM_CODE_RE = /^[2-9ACDEFGHJKMNPQRTVWXYZ]{4}$/
const COMMUNITY_ID_RE = /^cm_[0-9a-f]{16}$/

export const accountIdSchema = z
  .string()
  .regex(BASE58_RE)
  .transform((v) => v as AccountId)
export const deviceIdSchema = z
  .string()
  .regex(HEX32_RE)
  .transform((v) => v as DeviceId)
export const groupIdSchema = z
  .string()
  .regex(HEX32_RE)
  .transform((v) => v as GroupId)
export const inviteCodeSchema = z
  .string()
  .transform((v) => v.toUpperCase().replaceAll('O', '0').replaceAll('I', '1').replaceAll('L', '1'))
  .pipe(z.string().regex(CROCKFORD_RE))
  .transform((v) => v as InviteCode)

export const appIdSchema = z
  .string()
  .regex(APP_ID_RE)
  .transform((v) => v as AppId)
export const appUserIdSchema = z
  .string()
  .regex(APP_USER_ID_RE)
  .transform((v) => v as AppUserId)
export const grantUserCodeSchema = z
  .string()
  .transform((v) =>
    v
      .toUpperCase()
      .replaceAll('-', '')
      .replaceAll('O', '0')
      .replaceAll('I', '1')
      .replaceAll('L', '1'),
  )
  .pipe(z.string().regex(GRANT_CODE_RE))
  .transform((v) => v as GrantUserCode)
export const roomCodeSchema = z
  .string()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(ROOM_CODE_RE))
  .transform((v) => v as RoomCode)
export const communityIdSchema = z
  .string()
  .regex(COMMUNITY_ID_RE)
  .transform((v) => v as CommunityId)
