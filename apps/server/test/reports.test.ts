import { randomBytes } from 'node:crypto'
import type { DeviceId } from '@gathernet/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// web-push mocked — no network (reports never push, but buildApp wires the push service).
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async () => ({ statusCode: 201 })),
  },
}))

import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import {
  accounts,
  channelMembers,
  communities,
  communityChannels,
  communityMembers,
  devices,
  groups,
} from '../src/db/schema.ts'
import {
  listModerationRecipients,
  listReports,
  postReport,
  resolveReport,
} from '../src/modules/communities/service.ts'
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

/** Fake registry — postReport only fans a content-free nudge via sendToAccount. */
const fakeRegistry = { sendToAccount() {} } as unknown as ConnectionRegistry

async function newAccount(): Promise<string> {
  const accountId = `ac_${(n++).toString(16).padStart(16, '0')}`
  await db
    .insert(accounts)
    .values({ accountId, accountPk: randomBytes(32), displayName: accountId })
  return accountId
}

/** An active device; `receipt` gives it a receipt key (required to be a report recipient). */
async function newDevice(accountId: string, opts: { receipt?: boolean } = {}): Promise<string> {
  const deviceId = `dv_${(n++).toString(16).padStart(16, '0')}`
  await db.insert(devices).values({
    deviceId,
    accountId,
    devicePk: randomBytes(32),
    cert: randomBytes(32),
    certSig: randomBytes(64),
    name: 'Browser',
    ...(opts.receipt ? { receiptPk: randomBytes(32), receiptPkSig: randomBytes(64) } : {}),
  })
  return deviceId
}

/** A community + one channel, owned by a fresh leader (owner has no device by default). */
async function makeChannel(): Promise<{
  communityId: string
  channelId: string
  ownerAccountId: string
}> {
  const ownerAccountId = await newAccount()
  const communityId = `cm_${(n++).toString(16).padStart(16, '0')}`
  const channelId = `ch_${(n++).toString(16).padStart(16, '0')}`
  await db.insert(communities).values({ communityId, ownerAccountId })
  await db
    .insert(communityMembers)
    .values({ communityId, accountId: ownerAccountId, role: 'owner', status: 'active' })
  // A channel IS a group (community_channels.channel_id → groups.group_id).
  await db
    .insert(groups)
    .values({ groupId: channelId, kind: 'channel', creatorAccountId: ownerAccountId })
  await db.insert(communityChannels).values({ channelId, communityId })
  await db
    .insert(channelMembers)
    .values({ channelId, accountId: ownerAccountId, role: 'moderator', status: 'active' })
  return { communityId, channelId, ownerAccountId }
}

async function addMember(
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

describe('message reports', () => {
  it('lists only manager devices that have a receipt key', async () => {
    const c = await makeChannel()

    const modA = await newAccount()
    const modADevice = await newDevice(modA, { receipt: true })
    await addMember(c.communityId, c.channelId, modA, 'moderator')

    const plain = await newAccount()
    await newDevice(plain, { receipt: true })
    await addMember(c.communityId, c.channelId, plain, 'member')

    const modB = await newAccount()
    await newDevice(modB) // moderator, but no receipt key → skipped
    await addMember(c.communityId, c.channelId, modB, 'moderator')

    // Reporter is a plain member and is allowed to fetch the recipient set (no 403).
    const reporter = await newAccount()
    await addMember(c.communityId, c.channelId, reporter, 'member')

    const res = await listModerationRecipients(db, reporter, c.communityId, c.channelId)
    expect(res.devices.map((d) => d.deviceId)).toEqual([modADevice])
  })

  it('stores a report and delivers a mod their own envelope', async () => {
    const c = await makeChannel()
    const mod = await newAccount()
    const modDevice = await newDevice(mod, { receipt: true })
    await addMember(c.communityId, c.channelId, mod, 'moderator')
    const reporter = await newAccount()
    const reporterDevice = await newDevice(reporter)
    await addMember(c.communityId, c.channelId, reporter, 'member')

    const reportId = crypto.randomUUID()
    const sealed = randomBytes(48).toString('base64')
    await postReport(db, fakeRegistry, reporter, c.communityId, c.channelId, {
      reportId,
      reporterDeviceId: reporterDevice as DeviceId,
      reporterSig: randomBytes(64).toString('base64'),
      recipients: [
        {
          recipientDeviceId: modDevice as DeviceId,
          sealedReport: sealed,
          senderPkB64: randomBytes(32).toString('base64'),
        },
      ],
    })

    const res = await listReports(db, mod, c.communityId, c.channelId)
    expect(res.reports).toHaveLength(1)
    expect(res.reports[0]?.reportId).toBe(reportId)
    expect(res.reports[0]?.sealedReport).toBe(sealed)
    expect(res.reports[0]?.status).toBe('pending')
  })

  it('refuses a non-manager listing reports', async () => {
    const c = await makeChannel()
    const member = await newAccount()
    await addMember(c.communityId, c.channelId, member, 'member')
    await expect(listReports(db, member, c.communityId, c.channelId)).rejects.toMatchObject({
      status: 403,
    })
  })

  it('dismisses a report so it leaves the pending queue', async () => {
    const c = await makeChannel()
    const mod = await newAccount()
    const modDevice = await newDevice(mod, { receipt: true })
    await addMember(c.communityId, c.channelId, mod, 'moderator')
    const reporter = await newAccount()
    const reporterDevice = await newDevice(reporter)
    await addMember(c.communityId, c.channelId, reporter, 'member')

    const reportId = crypto.randomUUID()
    await postReport(db, fakeRegistry, reporter, c.communityId, c.channelId, {
      reportId,
      reporterDeviceId: reporterDevice as DeviceId,
      reporterSig: randomBytes(64).toString('base64'),
      recipients: [
        {
          recipientDeviceId: modDevice as DeviceId,
          sealedReport: randomBytes(32).toString('base64'),
          senderPkB64: randomBytes(32).toString('base64'),
        },
      ],
    })

    await resolveReport(db, mod, c.communityId, c.channelId, reportId, { action: 'dismiss' })
    const res = await listReports(db, mod, c.communityId, c.channelId)
    expect(res.reports).toHaveLength(0)
  })
})
