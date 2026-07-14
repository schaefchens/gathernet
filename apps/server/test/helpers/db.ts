import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { inject } from 'vitest'
import { createDb, createPool, type Db, runMigrations } from '../../src/db/index.ts'

export interface TestDb {
  db: Db
  teardown(): Promise<void>
}

/** Fresh database per test file on the shared testcontainer instance. */
export async function makeTestDb(): Promise<TestDb> {
  const adminUri = inject('pgUri')
  const dbName = `test_${randomBytes(8).toString('hex')}`

  const admin = new pg.Client({ connectionString: adminUri })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${dbName}`)
  await admin.end()

  const url = new URL(adminUri)
  url.pathname = `/${dbName}`
  const pool = createPool(url.toString())
  const db = createDb(pool)
  await runMigrations(db)

  return {
    db,
    async teardown() {
      await pool.end()
    },
  }
}
