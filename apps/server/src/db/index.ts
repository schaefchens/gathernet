import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import * as schema from './schema.ts'

export type Db = NodePgDatabase<typeof schema>
export { schema }

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 })
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema })
}

export async function runMigrations(db: Db): Promise<void> {
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), 'migrations')
  await migrate(db, { migrationsFolder })
}
