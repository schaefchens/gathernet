/**
 * Dev seed: registers the demo app + the two real apps with their local
 * origins under a synthetic "Gathernet Dev" publisher account. Idempotent.
 * Run: pnpm --filter @gathernet/server seed:apps
 */
import { randomBytes } from 'node:crypto'
import { base58Encode } from '@gathernet/shared'
import { eq } from 'drizzle-orm'
import { loadConfig } from '../config.ts'
import { createDb, createPool, runMigrations } from './index.ts'
import { accounts, appConfigs, publications } from './schema.ts'

const config = loadConfig()
const pool = createPool(config.DATABASE_URL)
const db = createDb(pool)
await runMigrations(db)

// Synthetic publisher account (no real keys — cannot log in; dev only).
const publisherPk = Buffer.concat([Buffer.from('gathernet-dev-publisher-seed'), randomBytes(4)])
let publisher = await db.query.accounts.findFirst({
  where: eq(accounts.displayName, 'Gathernet Dev (seed)'),
})
if (!publisher) {
  const accountId = base58Encode(randomBytes(32))
  await db.insert(accounts).values({
    accountId,
    accountPk: publisherPk.subarray(0, 32),
    displayName: 'Gathernet Dev (seed)',
  })
  publisher = await db.query.accounts.findFirst({ where: eq(accounts.accountId, accountId) })
}
if (!publisher) throw new Error('seed publisher missing')

const SEED_APPS = [
  {
    pubId: 'pub_00000000000000d1',
    kind: 'app' as const,
    name: 'Gathernet Demo',
    description: 'SDK demo app (in-repo)',
    origins: ['http://localhost:5175'],
  },
  {
    pubId: 'pub_00000000000000d2',
    kind: 'app' as const,
    name: 'Biblionaire Quiz',
    description: 'Bible quiz (dev)',
    origins: ['http://localhost:5174'],
  },
  {
    pubId: 'pub_00000000000000d3',
    kind: 'game' as const,
    name: 'Walk in the Spirit',
    description: 'Biblical roguelike (dev)',
    origins: ['http://localhost:5176'],
  },
]

for (const seedApp of SEED_APPS) {
  await db
    .insert(publications)
    .values({
      pubId: seedApp.pubId,
      kind: seedApp.kind,
      publisherAccountId: publisher.accountId,
      name: seedApp.name,
      description: seedApp.description,
    })
    .onConflictDoNothing()
  await db
    .insert(appConfigs)
    .values({
      pubId: seedApp.pubId,
      origins: seedApp.origins,
      allowedScopes: ['identity', 'storage', 'rooms'],
    })
    .onConflictDoNothing()
  console.log(`seeded ${seedApp.pubId} — ${seedApp.name}`)
}

await pool.end()
