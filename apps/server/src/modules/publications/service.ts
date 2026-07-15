import type { RegisterPublicationRequest } from '@gathernet/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { appConfigs, publications } from '../../db/schema.ts'
import { newHexId } from '../../lib/codes.ts'
import { ServiceError } from '../accounts/service.ts'

/**
 * Self-serve publishing: any account may register a publication. It starts
 * `unlisted` — usable by anyone holding the appId/link, invisible in any
 * catalog. Public listing requires a review step that does not exist yet (M3).
 */
export async function registerPublication(
  db: Db,
  publisherAccountId: string,
  body: RegisterPublicationRequest,
) {
  const isApp = body.kind === 'app' || body.kind === 'game'
  if (isApp && !body.appConfig) throw new ServiceError(400, 'app_config_required')
  if (!isApp && body.appConfig) throw new ServiceError(400, 'app_config_not_allowed')

  const pubId = newHexId('pub')
  await db.transaction(async (tx) => {
    await tx.insert(publications).values({
      pubId,
      kind: body.kind,
      publisherAccountId,
      name: body.name,
      description: body.description ?? null,
      iconUrl: body.iconUrl ?? null,
    })
    if (isApp && body.appConfig) {
      await tx.insert(appConfigs).values({
        pubId,
        origins: body.appConfig.origins,
        allowedScopes: body.appConfig.allowedScopes,
      })
    }
  })
  return getOwnPublication(db, publisherAccountId, pubId)
}

export async function listOwnPublications(db: Db, accountId: string) {
  const rows = await db
    .select()
    .from(publications)
    .where(eq(publications.publisherAccountId, accountId))
    .orderBy(publications.createdAt)
  return rows.map(toDto)
}

export async function getOwnPublication(db: Db, accountId: string, pubId: string) {
  const row = await db.query.publications.findFirst({ where: eq(publications.pubId, pubId) })
  if (!row || row.publisherAccountId !== accountId) {
    throw new ServiceError(404, 'publication_not_found')
  }
  const config = await db.query.appConfigs.findFirst({ where: eq(appConfigs.pubId, pubId) })
  return {
    ...toDto(row),
    appConfig: config ? { origins: config.origins, allowedScopes: config.allowedScopes } : null,
  }
}

export async function updateOwnPublication(
  db: Db,
  accountId: string,
  pubId: string,
  patch: {
    name?: string | undefined
    description?: string | undefined
    iconUrl?: string | undefined
    origins?: string[] | undefined
    allowedScopes?: string[] | undefined
  },
) {
  const row = await db.query.publications.findFirst({ where: eq(publications.pubId, pubId) })
  if (!row || row.publisherAccountId !== accountId) {
    throw new ServiceError(404, 'publication_not_found')
  }
  const pubSet: Record<string, string> = {}
  if (patch.name !== undefined) pubSet.name = patch.name
  if (patch.description !== undefined) pubSet.description = patch.description
  if (patch.iconUrl !== undefined) pubSet.iconUrl = patch.iconUrl
  if (Object.keys(pubSet).length > 0) {
    await db.update(publications).set(pubSet).where(eq(publications.pubId, pubId))
  }
  if (patch.origins !== undefined || patch.allowedScopes !== undefined) {
    const configSet: Record<string, string[]> = {}
    if (patch.origins !== undefined) configSet.origins = patch.origins
    if (patch.allowedScopes !== undefined) configSet.allowedScopes = patch.allowedScopes
    await db.update(appConfigs).set(configSet).where(eq(appConfigs.pubId, pubId))
  }
  return getOwnPublication(db, accountId, pubId)
}

/** Consent-screen card — public, but only for active app/game publications. */
export async function getPublicationCard(db: Db, pubId: string) {
  const row = await db.query.publications.findFirst({ where: eq(publications.pubId, pubId) })
  if (!row) throw new ServiceError(404, 'publication_not_found')
  const config = await db.query.appConfigs.findFirst({ where: eq(appConfigs.pubId, pubId) })
  if (!config) throw new ServiceError(404, 'publication_not_found')
  return {
    pubId: row.pubId,
    kind: row.kind,
    name: row.name,
    description: row.description,
    iconUrl: row.iconUrl,
    allowedScopes: config.allowedScopes,
  }
}

export async function getAppConfig(db: Db, pubId: string) {
  const config = await db.query.appConfigs.findFirst({ where: eq(appConfigs.pubId, pubId) })
  if (!config) throw new ServiceError(404, 'app_not_found')
  return config
}

function toDto(row: typeof publications.$inferSelect) {
  return {
    pubId: row.pubId,
    kind: row.kind,
    name: row.name,
    description: row.description,
    iconUrl: row.iconUrl,
    listing: row.listing,
    createdAt: row.createdAt.getTime(),
  }
}
