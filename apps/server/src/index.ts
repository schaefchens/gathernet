import { buildApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createDb, createPool, runMigrations } from './db/index.ts'

const config = loadConfig()
const pool = createPool(config.DATABASE_URL)
const db = createDb(pool)
await runMigrations(db)

const { app } = await buildApp({ config, db })

try {
  await app.listen({ port: config.SERVER_PORT, host: config.SERVER_HOST })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close()
    await pool.end()
    process.exit(0)
  })
}
