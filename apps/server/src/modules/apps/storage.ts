import { APP_STORAGE_MAX_KEYS, APP_STORAGE_MAX_VALUE_BYTES } from '@gathernet/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { appStorage } from '../../db/schema.ts'
import { ServiceError } from '../accounts/service.ts'

const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Encrypted app storage: the server stores opaque client-sealed blobs.
 * Optimistic concurrency via integer versions (exposed as ETags).
 */

export async function putStorage(
  db: Db,
  pubId: string,
  accountId: string,
  key: string,
  ciphertext: Buffer,
  options: { ifVersion?: number | undefined; createOnly?: boolean | undefined },
): Promise<{ version: number }> {
  if (!KEY_RE.test(key)) throw new ServiceError(400, 'invalid_key')
  if (ciphertext.length === 0) throw new ServiceError(400, 'empty_body')
  if (ciphertext.length > APP_STORAGE_MAX_VALUE_BYTES) {
    throw new ServiceError(413, 'value_too_large')
  }

  return db.transaction(async (tx) => {
    // Serialize concurrent PUTs for this (app, account) so the key-count quota
    // check below is atomic — distinct new keys have no shared row to lock, so
    // without this N concurrent inserts could each pass the count and blow past
    // APP_STORAGE_MAX_KEYS.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${pubId}), hashtext(${accountId}))`)

    const [existing] = await tx
      .select({ version: appStorage.version })
      .from(appStorage)
      .where(
        and(
          eq(appStorage.pubId, pubId),
          eq(appStorage.accountId, accountId),
          eq(appStorage.key, key),
        ),
      )
      .for('update')

    if (!existing) {
      if (options.ifVersion !== undefined) {
        throw new ServiceError(412, 'version_conflict')
      }
      const [{ count }] = (await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(appStorage)
        .where(and(eq(appStorage.pubId, pubId), eq(appStorage.accountId, accountId)))) as [
        { count: number },
      ]
      if (count >= APP_STORAGE_MAX_KEYS) throw new ServiceError(507, 'quota_exceeded')
      await tx.insert(appStorage).values({ pubId, accountId, key, ciphertext })
      return { version: 1 }
    }

    if (options.createOnly) throw new ServiceError(412, 'already_exists')
    if (options.ifVersion !== undefined && options.ifVersion !== existing.version) {
      throw new ServiceError(412, 'version_conflict')
    }
    const newVersion = existing.version + 1
    await tx
      .update(appStorage)
      .set({ ciphertext, version: newVersion, updatedAt: new Date() })
      .where(
        and(
          eq(appStorage.pubId, pubId),
          eq(appStorage.accountId, accountId),
          eq(appStorage.key, key),
        ),
      )
    return { version: newVersion }
  })
}

export async function getStorage(db: Db, pubId: string, accountId: string, key: string) {
  const row = await db.query.appStorage.findFirst({
    where: and(
      eq(appStorage.pubId, pubId),
      eq(appStorage.accountId, accountId),
      eq(appStorage.key, key),
    ),
  })
  if (!row) throw new ServiceError(404, 'not_found')
  return { ciphertext: row.ciphertext, version: row.version }
}

export async function listStorage(db: Db, pubId: string, accountId: string) {
  const rows = await db
    .select({
      key: appStorage.key,
      version: appStorage.version,
      updatedAt: appStorage.updatedAt,
      size: sql<number>`length(${appStorage.ciphertext})::int`,
    })
    .from(appStorage)
    .where(and(eq(appStorage.pubId, pubId), eq(appStorage.accountId, accountId)))
    .orderBy(appStorage.key)
  return rows.map((r) => ({
    key: r.key,
    size: r.size,
    version: r.version,
    updatedAt: r.updatedAt.getTime(),
  }))
}

export async function deleteStorage(
  db: Db,
  pubId: string,
  accountId: string,
  key: string,
): Promise<void> {
  await db
    .delete(appStorage)
    .where(
      and(
        eq(appStorage.pubId, pubId),
        eq(appStorage.accountId, accountId),
        eq(appStorage.key, key),
      ),
    )
}
