import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GathernetServer } from '../src/server.ts'
import { authorizeApp, enrollAccount, registerRoomsApp, serverUp } from './helpers/enroll.ts'

/**
 * Live multi-client rooms integration. Requires a running dev server
 * (docker compose up -d postgres && pnpm --filter @gathernet/server dev)
 * with seeded apps; otherwise the whole suite is skipped so CI stays green.
 * Two GathernetServer (Node) clients act as room members over real MLS.
 */

const SERVER = process.env.SDK_TEST_API ?? 'http://localhost:4000'
const COMPAT = 'sdk-test-v1'

let live = false
let appId = ''

beforeAll(async () => {
  live = await serverUp()
  if (!live) return
  const publisher = await enrollAccount('SDK Publisher')
  appId = await registerRoomsApp(publisher)
})

async function client(name: string): Promise<GathernetServer> {
  const publisherlessUser = await enrollAccount(name)
  const token = await authorizeApp(publisherlessUser, appId)
  return GathernetServer.init({ appId, serverUrl: SERVER, serviceToken: token })
}

function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms
    const tick = () => {
      const v = fn()
      if (v !== undefined) return resolve(v)
      if (Date.now() > deadline) return reject(new Error('timeout'))
      setTimeout(tick, 50)
    }
    tick()
  })
}

const servers: GathernetServer[] = []
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)))
})

describe('sdk rooms (live — skipped without a dev server)', () => {
  it('two members exchange an intent and a chat message; both converge', async () => {
    if (!live) return
    const host = await client('Host')
    const guest = await client('Guest')
    servers.push(host, guest)

    const room = await host.rooms.create({ title: 'Sync Test', public: true, compatTag: COMPAT })

    const hostIntents: unknown[] = []
    const guestIntents: unknown[] = []
    const guestChats: string[] = []
    room.onMessage((m) => hostIntents.push(m.payload))

    const joined = await guest.rooms.joinByCode(room.code, { compatTag: COMPAT })
    joined.onMessage((m) => guestIntents.push(m.payload))
    joined.chat.onMessage((m) => guestChats.push(m.text))

    // Give the guest's external-join commit time to land on the host.
    await waitFor(() => (room.members().length >= 2 ? true : undefined))

    await room.send({ op: 'inc' })
    await room.chat.send('grace and peace')

    await waitFor(() => (guestIntents.length >= 1 ? true : undefined))
    await waitFor(() => (guestChats.length >= 1 ? true : undefined))

    expect(guestIntents[0]).toEqual({ op: 'inc' })
    expect(guestChats[0]).toBe('grace and peace')
    // The host echoes its own send locally (MLS senders can't self-decrypt).
    expect(hostIntents[0]).toEqual({ op: 'inc' })
  }, 30_000)

  it('a guest intent reaches the host', async () => {
    if (!live) return
    const host = await client('Host2')
    const guest = await client('Guest2')
    servers.push(host, guest)

    const room = await host.rooms.create({ title: 'Reverse', public: true, compatTag: COMPAT })
    const hostGot: unknown[] = []
    room.onMessage((m) => hostGot.push(m.payload))

    const joined = await guest.rooms.joinByCode(room.code, { compatTag: COMPAT })
    await waitFor(() => (room.members().length >= 2 ? true : undefined))
    await joined.send({ hello: 'from guest' })

    await waitFor(() => (hostGot.length >= 1 ? true : undefined))
    expect(hostGot[0]).toEqual({ hello: 'from guest' })
  }, 30_000)
})
