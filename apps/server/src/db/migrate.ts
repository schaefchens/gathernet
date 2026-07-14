import { loadConfig } from '../config.ts'
import { createDb, createPool, runMigrations } from './index.ts'

const config = loadConfig()
const pool = createPool(config.DATABASE_URL)
await runMigrations(createDb(pool))
await pool.end()
console.log('migrations applied')
