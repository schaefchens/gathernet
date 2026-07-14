import {
  challengeRequestSchema,
  createAccountRequestSchema,
  enrollDeviceRequestSchema,
  loginRequestSchema,
  updateMeRequestSchema,
} from '@gathernet/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError, type ZodType } from 'zod'
import type { Db } from '../../db/index.ts'
import type { ConnectionRegistry } from '../../ws/registry.ts'
import { issueChallenge } from '../auth/challenges.ts'
import {
  createAccount,
  enrollDevice,
  getMe,
  listDevices,
  login,
  revokeDevice,
  ServiceError,
  updateMe,
} from './service.ts'

function parseBody<T>(schema: ZodType<T>, request: FastifyRequest): T {
  return schema.parse(request.body)
}

export interface AccountRoutesOptions {
  db: Db
  registry: ConnectionRegistry
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
}

export function registerAccountRoutes(
  app: FastifyInstance,
  { db, registry, authenticate }: AccountRoutesOptions,
): void {
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ServiceError) {
      return reply.status(err.status).send({ error: err.code })
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'invalid_body' })
    }
    request.log.error({ err }, 'unhandled error')
    return reply.status(500).send({ error: 'internal' })
  })

  app.post('/api/v1/auth/challenge', async (request) => {
    const body = parseBody(challengeRequestSchema, request)
    const { challenge, expiresAt } = await issueChallenge(db, body.purpose)
    return { challenge: challenge.toString('base64'), expiresAt: expiresAt.getTime() }
  })

  app.post('/api/v1/auth/token', async (request) => {
    const body = parseBody(loginRequestSchema, request)
    return login(db, body)
  })

  app.post('/api/v1/accounts', async (request, reply) => {
    const body = parseBody(createAccountRequestSchema, request)
    reply.status(201)
    return createAccount(db, body)
  })

  app.post('/api/v1/devices', async (request, reply) => {
    const body = parseBody(enrollDeviceRequestSchema, request)
    reply.status(201)
    return enrollDevice(db, body)
  })

  app.get('/api/v1/accounts/me', { preHandler: authenticate }, async (request) => {
    const session = request.session
    if (!session) throw new ServiceError(401, 'unauthorized')
    return getMe(db, session.accountId)
  })

  app.patch('/api/v1/accounts/me', { preHandler: authenticate }, async (request) => {
    const session = request.session
    if (!session) throw new ServiceError(401, 'unauthorized')
    const body = parseBody(updateMeRequestSchema, request)
    return updateMe(db, session.accountId, body)
  })

  app.get('/api/v1/devices', { preHandler: authenticate }, async (request) => {
    const session = request.session
    if (!session) throw new ServiceError(401, 'unauthorized')
    return { devices: await listDevices(db, session.accountId, session.deviceId) }
  })

  app.post<{ Params: { deviceId: string } }>(
    '/api/v1/devices/:deviceId/revoke',
    { preHandler: authenticate },
    async (request) => {
      const session = request.session
      if (!session) throw new ServiceError(401, 'unauthorized')
      await revokeDevice(db, session.accountId, request.params.deviceId)
      // Kill any live sockets of the revoked device immediately.
      registry.closeDevice(request.params.deviceId, {
        type: 'session.revoked',
        payload: {},
      })
      return { ok: true }
    },
  )
}
