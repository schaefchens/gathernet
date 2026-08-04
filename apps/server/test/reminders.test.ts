import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// web-push mocked — no network. sendNotification is a spy so we can assert who got pushed.
const sendNotification = vi.fn(async (_sub?: unknown, _body?: unknown) => ({ statusCode: 201 }))
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (sub: unknown, body: unknown) => sendNotification(sub, body),
  },
}))

import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import {
  accounts,
  channelArtifactParticipants,
  channelArtifacts,
  channelMembers,
  communities,
  communityChannels,
  communityMembers,
  devices,
  groups,
  pushSubscriptions,
} from '../src/db/schema.ts'
import { triggerChannelReminder } from '../src/modules/communities/service.ts'
import { InMemoryBlobStore } from '../src/storage/blob-store.ts'
import type { ConnectionRegistry } from '../src/ws/registry.ts'
import { makeTestDb, type TestDb } from './helpers/db.ts'

let testDb: TestDb
let app: FastifyInstance
let db: TestDb['db']
let n = 0

beforeAll(async () => {
  testDb = await makeTestDb()
  db = testDb.db
  const built = await buildApp({
    config: loadConfig({ LOG_LEVEL: 'error', RATE_LIMIT_ENABLED: 'false' }),
    db,
    blobStore: new InMemoryBlobStore(),
  })
  app = built.app
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await testDb.teardown()
})

beforeEach(() => sendNotification.mockClear())

/** Fake registry — the trigger only reads isAccountOnline. */
function registryWith(online: Set<string>): ConnectionRegistry {
  return { isAccountOnline: (a: string) => online.has(a) } as unknown as ConnectionRegistry
}

async function newAccount(): Promise<string> {
  const accountId = `ac_${(n++).toString(16).padStart(16, '0')}`
  await db
    .insert(accounts)
    .values({ accountId, accountPk: randomBytes(32), displayName: accountId })
  return accountId
}

/** An account with an active device + a push subscription (so a push actually fires). */
async function newSubscribedAccount(): Promise<{ accountId: string; deviceId: string }> {
  const accountId = await newAccount()
  const deviceId = `dv_${(n++).toString(16).padStart(16, '0')}`
  await db.insert(devices).values({
    deviceId,
    accountId,
    devicePk: randomBytes(32),
    cert: randomBytes(32),
    certSig: randomBytes(64),
    name: 'Browser',
  })
  await db.insert(pushSubscriptions).values({
    deviceId,
    accountId,
    endpoint: `https://push.example/${deviceId}`,
    p256dh: 'p',
    auth: 'a',
  })
  return { accountId, deviceId }
}

/** A community + channel + one event artifact, owned by a fresh owner (community leader). */
async function makeChannelWithEvent(): Promise<{
  communityId: string
  channelId: string
  artifactId: string
  ownerAccountId: string
  ownerDeviceId: string
}> {
  const owner = await newSubscribedAccount()
  const communityId = `cm_${(n++).toString(16).padStart(16, '0')}`
  const channelId = `ch_${(n++).toString(16).padStart(16, '0')}`
  const artifactId = crypto.randomUUID()
  await db.insert(communities).values({ communityId, ownerAccountId: owner.accountId })
  await db
    .insert(communityMembers)
    .values({ communityId, accountId: owner.accountId, role: 'owner', status: 'active' })
  // A channel IS a group (community_channels.channel_id → groups.group_id).
  await db
    .insert(groups)
    .values({ groupId: channelId, kind: 'channel', creatorAccountId: owner.accountId })
  await db.insert(communityChannels).values({ channelId, communityId })
  await db
    .insert(channelMembers)
    .values({ channelId, accountId: owner.accountId, role: 'moderator', status: 'active' })
  await db.insert(channelArtifacts).values({
    artifactId,
    channelId,
    communityId,
    kind: 'event',
    sealEpoch: 0,
    sealedBody: randomBytes(48),
    issuerDeviceId: owner.deviceId,
    issuerSig: randomBytes(64),
    createdBy: owner.accountId,
  })
  return {
    communityId,
    channelId,
    artifactId,
    ownerAccountId: owner.accountId,
    ownerDeviceId: owner.deviceId,
  }
}

async function addChannelMember(
  communityId: string,
  channelId: string,
  accountId: string,
  role: 'member' | 'moderator' = 'member',
): Promise<void> {
  await db
    .insert(communityMembers)
    .values({ communityId, accountId, role: 'member', status: 'active' })
    .onConflictDoNothing()
  await db.insert(channelMembers).values({ channelId, accountId, role, status: 'active' })
}

async function rsvp(
  artifactId: string,
  channelId: string,
  accountId: string,
  deviceId: string,
): Promise<void> {
  await db
    .insert(channelArtifactParticipants)
    .values({ artifactId, channelId, accountId, deviceId, sig: randomBytes(64) })
}

describe('event reminder trigger', () => {
  it('fires and pushes an offline RSVP participant', async () => {
    const c = await makeChannelWithEvent()
    const p = await newSubscribedAccount()
    await addChannelMember(c.communityId, c.channelId, p.accountId)
    await rsvp(c.artifactId, c.channelId, p.accountId, p.deviceId)

    const res = await triggerChannelReminder(
      db,
      registryWith(new Set()),
      c.ownerAccountId, // a moderator → may trigger anytime
      c.communityId,
      c.channelId,
      c.artifactId,
      { reminderInstant: Date.now() },
    )
    // notifyEventReminder is fire-and-forget; let its microtasks flush.
    await new Promise((r) => setTimeout(r, 20))

    expect(res.fired).toBe(true)
    const pushed = sendNotification.mock.calls.map(
      (call) => (call[0] as { endpoint: string }).endpoint,
    )
    expect(pushed).toContain(`https://push.example/${p.deviceId}`)
  })

  it('dedups a second trigger for the same reminder instant', async () => {
    const c = await makeChannelWithEvent()
    const instant = Date.now()
    const first = await triggerChannelReminder(
      db,
      registryWith(new Set()),
      c.ownerAccountId,
      c.communityId,
      c.channelId,
      c.artifactId,
      { reminderInstant: instant },
    )
    const second = await triggerChannelReminder(
      db,
      registryWith(new Set()),
      c.ownerAccountId,
      c.communityId,
      c.channelId,
      c.artifactId,
      { reminderInstant: instant },
    )
    expect(first.fired).toBe(true)
    expect(second.fired).toBe(false)
  })

  it('rejects a reminder instant outside the accept window', async () => {
    const c = await makeChannelWithEvent()
    const reg = registryWith(new Set())
    await expect(
      triggerChannelReminder(db, reg, c.ownerAccountId, c.communityId, c.channelId, c.artifactId, {
        reminderInstant: Date.now() + 3 * 60 * 60 * 1000, // 3h ahead > 2h window
      }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      triggerChannelReminder(db, reg, c.ownerAccountId, c.communityId, c.channelId, c.artifactId, {
        reminderInstant: Date.now() - 60 * 60 * 1000, // 1h stale > 15m grace
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('blocks a regular member while a manager is online, allows when dark', async () => {
    const c = await makeChannelWithEvent()
    const member = await newAccount()
    await addChannelMember(c.communityId, c.channelId, member, 'member')

    // Owner (a manager) online → regular member's trigger is refused.
    await expect(
      triggerChannelReminder(
        db,
        registryWith(new Set([c.ownerAccountId])),
        member,
        c.communityId,
        c.channelId,
        c.artifactId,
        { reminderInstant: Date.now() },
      ),
    ).rejects.toMatchObject({ status: 409 })

    // No manager online → the same member may trigger.
    const ok = await triggerChannelReminder(
      db,
      registryWith(new Set()),
      member,
      c.communityId,
      c.channelId,
      c.artifactId,
      { reminderInstant: Date.now() },
    )
    expect(ok.fired).toBe(true)
  })

  it('does not push an online participant', async () => {
    const c = await makeChannelWithEvent()
    const p = await newSubscribedAccount()
    await addChannelMember(c.communityId, c.channelId, p.accountId)
    await rsvp(c.artifactId, c.channelId, p.accountId, p.deviceId)

    await triggerChannelReminder(
      db,
      registryWith(new Set([p.accountId])), // participant is online
      c.ownerAccountId,
      c.communityId,
      c.channelId,
      c.artifactId,
      { reminderInstant: Date.now() },
    )
    await new Promise((r) => setTimeout(r, 20))
    const pushed = sendNotification.mock.calls.map(
      (call) => (call[0] as { endpoint: string }).endpoint,
    )
    expect(pushed).not.toContain(`https://push.example/${p.deviceId}`)
  })

  it('rejects a non-member', async () => {
    const c = await makeChannelWithEvent()
    const outsider = await newAccount()
    await expect(
      triggerChannelReminder(
        db,
        registryWith(new Set()),
        outsider,
        c.communityId,
        c.channelId,
        c.artifactId,
        { reminderInstant: Date.now() },
      ),
    ).rejects.toMatchObject({ status: 403 })
  })
})
