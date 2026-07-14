import { PROTOCOL_VERSION, parseServerMessage, ulid } from '@gathernet/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import {
  buildEnrollment,
  buildLoginSig,
  generateEd25519,
  type TestKeypair,
} from './helpers/client-crypto.ts'
import { makeTestDb, type TestDb } from './helpers/db.ts'

let testDb: TestDb
let app: FastifyInstance
let port: number

beforeAll(async () => {
  testDb = await makeTestDb()
  const built = await buildApp({
    config: loadConfig({ LOG_LEVEL: 'error', RATE_LIMIT_ENABLED: 'false' }),
    db: testDb.db,
  })
  app = built.app
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  port = address.port
})

afterAll(async () => {
  await app.close()
  await testDb.teardown()
})

async function getChallenge(purpose: 'enroll' | 'login'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/challenge',
    payload: { purpose },
  })
  expect(res.statusCode).toBe(200)
  return res.json().challenge
}

async function createTestAccount(displayName = 'Alice') {
  const identity = generateEd25519()
  const device = generateEd25519()
  const challenge = await getChallenge('enroll')
  const { body } = buildEnrollment(identity, device, challenge, 'Test Browser')
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts',
    payload: { ...body, displayName },
  })
  expect(res.statusCode).toBe(201)
  return { identity, device, session: res.json() }
}

async function enrollSecondDevice(identity: TestKeypair, name = 'Second Browser') {
  const device = generateEd25519()
  const challenge = await getChallenge('enroll')
  const { body } = buildEnrollment(identity, device, challenge, name)
  const res = await app.inject({ method: 'POST', url: '/api/v1/devices', payload: body })
  return { device, res }
}

describe('account creation', () => {
  it('creates an account and returns a working session', async () => {
    const { session } = await createTestAccount()
    expect(session.token).toMatch(/^gn\./)
    expect(session.accountId.length).toBeGreaterThan(30)
    expect(session.groups).toEqual([])

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${session.token}` },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ displayName: 'Alice', presencePref: 'online' })
  })

  it('rejects challenge replay', async () => {
    const identity = generateEd25519()
    const device = generateEd25519()
    const challenge = await getChallenge('enroll')
    const { body } = buildEnrollment(identity, device, challenge, 'Replay Browser')
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      payload: { ...body, displayName: 'Replay' },
    })
    expect(first.statusCode).toBe(201)

    // Same challenge, different (valid) account — must fail as consumed.
    const identity2 = generateEd25519()
    const device2 = generateEd25519()
    const { body: body2 } = buildEnrollment(identity2, device2, challenge, 'Replay 2')
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      payload: { ...body2, displayName: 'Replay 2' },
    })
    expect(second.statusCode).toBe(401)
    expect(second.json().error).toBe('challenge_invalid')
  })

  it('rejects a tampered identity signature', async () => {
    const identity = generateEd25519()
    const device = generateEd25519()
    const challenge = await getChallenge('enroll')
    const { body } = buildEnrollment(identity, device, challenge, 'Tampered')
    const badSig = Buffer.from(body.identitySig, 'base64')
    badSig[0] = (badSig[0] ?? 0) ^ 0xff
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      payload: { ...body, identitySig: badSig.toString('base64'), displayName: 'X' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('identity_sig_invalid')
  })

  it('rejects a cert signed by a different identity key', async () => {
    const identity = generateEd25519()
    const impostor = generateEd25519()
    const device = generateEd25519()
    const challenge = await getChallenge('enroll')
    // Cert chains to impostor, but accountPk claims identity.
    const { body } = buildEnrollment(impostor, device, challenge, 'Impostor')
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      payload: { ...body, accountPk: identity.publicRaw.toString('base64'), displayName: 'X' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects duplicate account creation', async () => {
    const identity = generateEd25519()
    const device = generateEd25519()
    const challenge = await getChallenge('enroll')
    const { body } = buildEnrollment(identity, device, challenge, 'One')
    await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      payload: { ...body, displayName: 'One' },
    })

    const device2 = generateEd25519()
    const challenge2 = await getChallenge('enroll')
    const { body: body2 } = buildEnrollment(identity, device2, challenge2, 'Two')
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      payload: { ...body2, displayName: 'Two' },
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('multi-device', () => {
  it('enrolls a second device from the recovery identity', async () => {
    const { identity, session } = await createTestAccount('Bob')
    const { res } = await enrollSecondDevice(identity)
    expect(res.statusCode).toBe(201)
    const second = res.json()
    expect(second.accountId).toBe(session.accountId)
    expect(second.displayName).toBe('Bob')
    expect(second.deviceId).not.toBe(session.deviceId)

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${second.token}` },
    })
    expect(list.statusCode).toBe(200)
    const devices = list.json().devices
    expect(devices).toHaveLength(2)
    expect(devices.filter((d: { isCurrent: boolean }) => d.isCurrent)).toHaveLength(1)
  })

  it('logs in a returning device via challenge-response', async () => {
    const { device, session } = await createTestAccount('Carol')
    const challenge = await getChallenge('login')
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: {
        deviceId: session.deviceId,
        challenge,
        sig: buildLoginSig(device, session.deviceId, challenge),
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().token).toMatch(/^gn\./)
  })

  it('rejects login with a wrong device key', async () => {
    const { session } = await createTestAccount('Dave')
    const wrongDevice = generateEd25519()
    const challenge = await getChallenge('login')
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: {
        deviceId: session.deviceId,
        challenge,
        sig: buildLoginSig(wrongDevice, session.deviceId, challenge),
      },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('device revocation', () => {
  it('revoking a device kills its sessions and its live socket', async () => {
    const { identity, session: firstSession } = await createTestAccount('Eve')
    const { res } = await enrollSecondDevice(identity)
    const secondSession = res.json()

    // First device opens a WS connection.
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    socket.send(
      JSON.stringify({
        type: 'hello',
        id: ulid(),
        payload: { token: firstSession.token, protocolVersion: PROTOCOL_VERSION },
      }),
    )
    const helloReply = await new Promise<string>((resolve) =>
      socket.once('message', (d) => resolve(d.toString())),
    )
    const parsed = parseServerMessage(helloReply)
    expect(parsed.ok && parsed.message.type === 'hello.ok').toBe(true)

    const received: string[] = []
    socket.on('message', (d) => received.push(d.toString()))
    const closed = new Promise<number>((resolve) => socket.once('close', resolve))

    // Second device revokes the first.
    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${firstSession.deviceId}/revoke`,
      headers: { authorization: `Bearer ${secondSession.token}` },
    })
    expect(revoke.statusCode).toBe(200)

    const closeCode = await closed
    expect(closeCode).toBe(4403)
    expect(received.some((m) => m.includes('session.revoked'))).toBe(true)

    // The revoked device's HTTP session is dead.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${firstSession.token}` },
    })
    expect(me.statusCode).toBe(401)

    // And it cannot log back in.
    const challenge = await getChallenge('login')
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: { deviceId: firstSession.deviceId, challenge, sig: 'AA==' },
    })
    expect(login.statusCode).not.toBe(200)
  })

  it('cannot revoke another account’s device', async () => {
    const { session: a } = await createTestAccount('Frank')
    const { session: b } = await createTestAccount('Grace')
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${a.deviceId}/revoke`,
      headers: { authorization: `Bearer ${b.token}` },
    })
    expect(res.statusCode).toBe(404)
  })
})
