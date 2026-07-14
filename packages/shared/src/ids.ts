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

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,50}$/
const HEX32_RE = /^[0-9a-f]{32}$/
const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/

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
