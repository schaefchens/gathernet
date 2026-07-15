import { z } from 'zod'
import { APP_SCOPES } from '../constants.ts'
import { appIdSchema, appUserIdSchema, grantUserCodeSchema } from '../ids.ts'

export const appScopeSchema = z.enum(APP_SCOPES)
export const scopesSchema = z.array(appScopeSchema).min(1).max(4)

const originSchema = z.url().refine((v) => {
  try {
    const url = new URL(v)
    return (
      url.origin === v &&
      (url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    )
  } catch {
    return false
  }
}, 'must be an exact https origin (or localhost for development)')

/** Self-serve publication registration — any account, starts unlisted. */
export const registerPublicationRequestSchema = z.object({
  kind: z.enum(['app', 'game', 'book', 'video']),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  iconUrl: z.url().max(300).optional(),
  /** required for kind app|game */
  appConfig: z
    .object({
      origins: z.array(originSchema).min(1).max(10),
      allowedScopes: scopesSchema,
    })
    .optional(),
})

export const publicationSchema = z.object({
  pubId: appIdSchema,
  kind: z.enum(['app', 'game', 'book', 'video']),
  name: z.string(),
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
  listing: z.enum(['draft', 'unlisted', 'listed']),
  createdAt: z.number().int(),
})

/** Public card shown on consent screens. */
export const publicationCardSchema = z.object({
  pubId: appIdSchema,
  kind: z.enum(['app', 'game', 'book', 'video']),
  name: z.string(),
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
  allowedScopes: z.array(appScopeSchema),
})

/** Hub → server: mint an app session after consent (popup flow). */
export const authorizeAppRequestSchema = z.object({
  scopes: scopesSchema,
  /** the app origin the popup will postMessage to — must be registered */
  origin: z.string(),
})

export const appSessionResponseSchema = z.object({
  token: z.string(),
  appUserId: appUserIdSchema,
  displayName: z.string(),
  scopes: z.array(appScopeSchema),
  expiresAt: z.number().int(),
  origin: z.string(),
})

export const appMeResponseSchema = z.object({
  appUserId: appUserIdSchema,
  displayName: z.string(),
  scopes: z.array(appScopeSchema),
  app: z.object({ appId: appIdSchema, name: z.string() }),
})

export const grantSummarySchema = z.object({
  appId: appIdSchema,
  name: z.string(),
  iconUrl: z.string().nullable(),
  scopes: z.array(appScopeSchema),
  createdAt: z.number().int(),
  lastUsedAt: z.number().int(),
})

/** Device-code flow. */
export const createGrantCodeRequestSchema = z.object({
  appId: appIdSchema,
  scopes: scopesSchema,
  /** raw P-256 SPKI public key (base64) for sealed storage-key handoff */
  ephemeralPk: z.base64().optional(),
})

export const createGrantCodeResponseSchema = z.object({
  userCode: z.string(),
  qrPayload: z.string(),
  pollSecret: z.string(),
  expiresAt: z.number().int(),
  intervalSeconds: z.number().int(),
})

export const pollGrantCodeRequestSchema = z.object({
  pollSecret: z.string().min(16),
})

export const grantCodePreviewSchema = z.object({
  userCode: grantUserCodeSchema,
  app: publicationCardSchema,
  requestedScopes: z.array(appScopeSchema),
  /** present iff the app supplied an ephemeral key (storage handoff possible) */
  appEphemeralPk: z.base64().nullable(),
  expiresAt: z.number().int(),
})

export const approveGrantCodeRequestSchema = z.object({
  scopes: scopesSchema,
  /** AES-GCM(ECDH-derived key, perAppStorageKey), base64 — hub-sealed */
  sealedStorageKey: z.base64().optional(),
  hubEphemeralPk: z.base64().optional(),
})

export type RegisterPublicationRequest = z.infer<typeof registerPublicationRequestSchema>
export type Publication = z.infer<typeof publicationSchema>
export type PublicationCard = z.infer<typeof publicationCardSchema>
export type AuthorizeAppRequest = z.infer<typeof authorizeAppRequestSchema>
export type AppSessionResponse = z.infer<typeof appSessionResponseSchema>
export type AppMeResponse = z.infer<typeof appMeResponseSchema>
export type GrantSummary = z.infer<typeof grantSummarySchema>
export type GrantCodePreview = z.infer<typeof grantCodePreviewSchema>
