import type { AccountId, DeviceId } from '@gathernet/shared'
import { PROTOCOL_VERSION, parseServerMessage, ulid } from '@gathernet/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { makeTestDb, type TestDb } from './helpers/db.ts'

let testDb: TestDb
let app: FastifyInstance
let wsUrl: string

beforeAll(async () => {
  testDb = await makeTestDb()
  const built = await buildApp({
    config: loadConfig({ LOG_LEVEL: 'error', RATE_LIMIT_ENABLED: 'false' }),
    db: testDb.db,
    authenticator: {
      async verifyToken(token: string) {
        if (token !== 'dev-token') return null
        return {
          kind: 'user' as const,
          accountId: '1'.repeat(32) as AccountId,
          deviceId: '0'.repeat(32) as DeviceId,
        }
      },
    },
  })
  app = built.app
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  wsUrl = `ws://127.0.0.1:${address.port}/ws`
})

afterAll(async () => {
  await app.close()
  await testDb.teardown()
})

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(data.toString()))
    socket.once('close', (code) => reject(new Error(`closed: ${code}`)))
  })
}

describe('healthz', () => {
  it('responds ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
  })
})

describe('ws gateway', () => {
  it('completes the hello handshake', async () => {
    const socket = await connect()
    const id = ulid()
    socket.send(
      JSON.stringify({
        type: 'hello',
        id,
        payload: { token: 'dev-token', protocolVersion: PROTOCOL_VERSION },
      }),
    )
    const reply = parseServerMessage(await nextMessage(socket))
    expect(reply.ok).toBe(true)
    if (reply.ok) {
      expect(reply.message.type).toBe('hello.ok')
      if (reply.message.type === 'hello.ok') {
        expect(reply.message.replyTo).toBe(id)
        expect(reply.message.payload.serverTime).toBeGreaterThan(0)
      }
    }
    socket.close()
  })

  it('rejects wrong protocol version and closes 4400', async () => {
    const socket = await connect()
    socket.send(
      JSON.stringify({
        type: 'hello',
        id: ulid(),
        payload: { token: 'dev-token', protocolVersion: 999 },
      }),
    )
    const reply = parseServerMessage(await nextMessage(socket))
    expect(reply.ok && reply.message.type === 'hello.error').toBe(true)
    const code = await new Promise<number>((resolve) => socket.once('close', resolve))
    expect(code).toBe(4400)
  })

  it('rejects messages before hello', async () => {
    const socket = await connect()
    socket.send(JSON.stringify({ type: 'presence.set', id: ulid(), payload: { status: 'online' } }))
    const reply = parseServerMessage(await nextMessage(socket))
    expect(reply.ok && reply.message.type === 'error').toBe(true)
    const code = await new Promise<number>((resolve) => socket.once('close', resolve))
    expect(code).toBe(4401)
  })

  it('answers unknown types with error, stays open', async () => {
    const socket = await connect()
    socket.send(
      JSON.stringify({
        type: 'hello',
        id: ulid(),
        payload: { token: 'dev-token', protocolVersion: PROTOCOL_VERSION },
      }),
    )
    await nextMessage(socket)
    socket.send(JSON.stringify({ type: 'bogus', id: ulid(), payload: {} }))
    const reply = parseServerMessage(await nextMessage(socket))
    expect(reply.ok && reply.message.type === 'error').toBe(true)
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
  })
})
