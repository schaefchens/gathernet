import { buildApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createDb, createPool, runMigrations } from './db/index.ts'
import { pruneGrantCodes } from './modules/apps/grant-codes.ts'
import { pruneExpiredChallenges } from './modules/auth/challenges.ts'
import { pruneMailbox } from './modules/delivery/service.ts'
import { pruneRooms } from './modules/rooms/service.ts'

const config = loadConfig()
const pool = createPool(config.DATABASE_URL)
const db = createDb(pool)
await runMigrations(db)

const { app } = await buildApp({ config, db })

/** Periodic housekeeping — run once at boot, then hourly. */
async function runJobs(): Promise<void> {
  try {
    await pruneExpiredChallenges(db)
    await pruneGrantCodes(db)
    await pruneMailbox(db)
    await pruneRooms(db)
  } catch (err) {
    app.log.error({ err }, 'housekeeping job failed')
  }
}

const JOB_INTERVAL_MS = 60 * 60 * 1000
void runJobs()
const jobsTimer = setInterval(() => void runJobs(), JOB_INTERVAL_MS)

try {
  await app.listen({ port: config.SERVER_PORT, host: config.SERVER_HOST })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    clearInterval(jobsTimer)
    await app.close()
    await pool.end()
    process.exit(0)
  })
}
