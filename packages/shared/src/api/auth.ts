import { z } from 'zod'
import { accountIdSchema, deviceIdSchema, groupIdSchema } from '../ids.ts'

/**
 * Domain-separation prefixes. Every Ed25519 signature in the system signs
 * `utf8(domain) || payload` — never a bare payload. Must match crates/mls-wasm.
 */
export const SIG_DOMAIN = {
  deviceCert: 'gathernet-device-cert-v1',
  enroll: 'gathernet-enroll-v1',
  auth: 'gathernet-auth-v1',
  revoke: 'gathernet-revoke-v1',
  /** Ed25519(DK, domain.receiptKey || receiptPk) — binds the ECIES receipt key
   *  to the device signing key, which the DeviceCert already binds to the
   *  identity. Lets community K_meta grants be sealed to an authenticated key. */
  receiptKey: 'gathernet-receipt-key-v1',
} as const

export const displayNameSchema = z.string().trim().min(1).max(64)
export const deviceNameSchema = z.string().trim().min(1).max(64)

export const challengeRequestSchema = z.object({
  purpose: z.enum(['enroll', 'login']),
})

export const challengeResponseSchema = z.object({
  challenge: z.base64(),
  expiresAt: z.number().int(),
})

/** Shared shape for first-device (account create) and later-device enrollment. */
const enrollmentFields = {
  /** base64 raw Ed25519 account public key */
  accountPk: z.base64(),
  /** base64 canonical-CBOR device certificate */
  deviceCert: z.base64(),
  /** base64 Ed25519(IK, domain.deviceCert || cert) */
  certSig: z.base64(),
  /** the challenge previously issued for purpose=enroll */
  challenge: z.base64(),
  /** base64 Ed25519(IK, domain.enroll || challenge || cert) */
  identitySig: z.base64(),
  /** base64 Ed25519(DK, domain.enroll || challenge || cert) */
  deviceSig: z.base64(),
  /** base64 raw SPKI of the device's persistent ECIES receipt public key */
  receiptPk: z.base64().optional(),
  /** base64 Ed25519(DK, domain.receiptKey || receiptPk) */
  receiptPkSig: z.base64().optional(),
}

export const createAccountRequestSchema = z.object({
  ...enrollmentFields,
  displayName: displayNameSchema,
})

export const enrollDeviceRequestSchema = z.object({
  ...enrollmentFields,
})

export const sessionResponseSchema = z.object({
  accountId: accountIdSchema,
  deviceId: deviceIdSchema,
  displayName: z.string(),
  token: z.string(),
  expiresAt: z.number().int(),
  /** existing MLS groups this device should external-join (empty until stage 6) */
  groups: z.array(
    z.object({
      groupId: groupIdSchema,
      groupInfo: z.base64(),
    }),
  ),
})

export const loginRequestSchema = z.object({
  deviceId: deviceIdSchema,
  challenge: z.base64(),
  /** base64 Ed25519(DK, domain.auth || challenge || utf8(deviceId)) */
  sig: z.base64(),
})

export const loginResponseSchema = z.object({
  accountId: accountIdSchema,
  deviceId: deviceIdSchema,
  displayName: z.string(),
  token: z.string(),
  expiresAt: z.number().int(),
})

export const meResponseSchema = z.object({
  accountId: accountIdSchema,
  displayName: z.string(),
  presencePref: z.enum(['online', 'away', 'invisible']),
  createdAt: z.number().int(),
})

export const updateMeRequestSchema = z.object({
  displayName: displayNameSchema.optional(),
  presencePref: z.enum(['online', 'away', 'invisible']).optional(),
})

export const deviceInfoSchema = z.object({
  deviceId: deviceIdSchema,
  name: z.string(),
  status: z.enum(['active', 'revoked']),
  isCurrent: z.boolean(),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int().nullable(),
})

export const devicesResponseSchema = z.object({
  devices: z.array(deviceInfoSchema),
})

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
})

export type ChallengeRequest = z.infer<typeof challengeRequestSchema>
export type ChallengeResponse = z.infer<typeof challengeResponseSchema>
export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>
export type EnrollDeviceRequest = z.infer<typeof enrollDeviceRequestSchema>
export type SessionResponse = z.infer<typeof sessionResponseSchema>
export type LoginRequest = z.infer<typeof loginRequestSchema>
export type LoginResponse = z.infer<typeof loginResponseSchema>
export type MeResponse = z.infer<typeof meResponseSchema>
export type DeviceInfo = z.infer<typeof deviceInfoSchema>
