import { sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'

const CACHE_TTL_MS = 60_000

let cache: { origins: Set<string>; loadedAt: number } | null = null

/** All registered app origins — used by the CORS allowlist. Cached 60 s. */
export async function allowedAppOrigins(db: Db): Promise<Set<string>> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.origins
  const result = await db.execute(sql`SELECT DISTINCT unnest(origins) AS origin FROM app_configs`)
  const origins = new Set((result.rows as { origin: string }[]).map((r) => r.origin))
  cache = { origins, loadedAt: Date.now() }
  return origins
}

/** Test seam / call after registration mutations. */
export function invalidateOriginCache(): void {
  cache = null
}
