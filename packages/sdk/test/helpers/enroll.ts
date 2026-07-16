import { createHash, generateKeyPairSync, type KeyObject, sign as nodeSign } from 'node:crypto'

/**
 * Scripted account enrollment + app authorization for SDK integration tests,
 * using node:crypto Ed25519 + a minimal CBOR device cert (mirrors
 * apps/server/test/helpers/client-crypto.ts). Produces `gna.` app-session
 * tokens so the SDK/GathernetServer can be driven against a live dev server.
 */

const API = process.env.SDK_TEST_API ?? 'http://localhost:4000'
const DEMO_ORIGIN = 'http://localhost:5175'

function cborHead(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value])
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value])
  if (value < 0x10000) {
    const buf = Buffer.alloc(3)
    buf[0] = (major << 5) | 25
    buf.writeUInt16BE(value, 1)
    return buf
  }
  const buf = Buffer.alloc(5)
  buf[0] = (major << 5) | 26
  buf.writeUInt32BE(value, 1)
  return buf
}
const cborUint = (n: number) => cborHead(0, n)
const cborBytes = (b: Buffer) => Buffer.concat([cborHead(2, b.length), b])
const cborText = (s: string) => {
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([cborHead(3, b.length), b])
}
const cborArray = (items: Buffer[]) => Buffer.concat([cborHead(4, items.length), ...items])

interface Keypair {
  publicRaw: Buffer
  privateKey: KeyObject
}
function generateEd25519(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  return { publicRaw: Buffer.from(spki.subarray(spki.length - 32)), privateKey }
}
const sign = (keypair: Keypair, ...parts: Buffer[]) =>
  nodeSign(null, Buffer.concat(parts), keypair.privateKey)

async function apiCall<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : null,
  })
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

/** Enroll a fresh device-session account; returns its gn. token. */
export async function enrollAccount(displayName: string): Promise<string> {
  const identity = generateEd25519()
  const device = generateEd25519()
  const { challenge } = await apiCall<{ challenge: string }>('POST', '/api/v1/auth/challenge', {
    purpose: 'enroll',
  })
  const deviceId = createHash('sha256').update(device.publicRaw).digest().subarray(0, 16)
  const cert = cborArray([
    cborUint(1),
    cborBytes(identity.publicRaw),
    cborBytes(device.publicRaw),
    cborBytes(deviceId),
    cborText(displayName),
    cborUint(Math.floor(Date.now() / 1000)),
  ])
  const certSig = sign(identity, Buffer.from('gathernet-device-cert-v1'), cert)
  const challengeBytes = Buffer.from(challenge, 'base64')
  const enrollDomain = Buffer.from('gathernet-enroll-v1')
  const session = await apiCall<{ token: string }>('POST', '/api/v1/accounts', {
    accountPk: identity.publicRaw.toString('base64'),
    deviceCert: cert.toString('base64'),
    certSig: certSig.toString('base64'),
    challenge,
    identitySig: sign(identity, enrollDomain, challengeBytes, cert).toString('base64'),
    deviceSig: sign(device, enrollDomain, challengeBytes, cert).toString('base64'),
    displayName,
  })
  return session.token
}

/** Register an app publication with the rooms scope; returns its appId. */
export async function registerRoomsApp(publisherToken: string): Promise<string> {
  const pub = await apiCall<{ pubId: string }>(
    'POST',
    '/api/v1/publications',
    {
      kind: 'game',
      name: 'SDK Test Game',
      appConfig: { origins: [DEMO_ORIGIN], allowedScopes: ['identity', 'rooms'] },
    },
    publisherToken,
  )
  return pub.pubId
}

/** Authorize a user account for an app → a gna. app-session token. */
export async function authorizeApp(
  userToken: string,
  appId: string,
  scopes: string[] = ['identity', 'rooms'],
): Promise<string> {
  const res = await apiCall<{ token: string }>(
    'POST',
    `/api/v1/apps/${appId}/authorize`,
    { scopes, origin: DEMO_ORIGIN },
    userToken,
  )
  return res.token
}

/** True if a dev server is reachable — gate live suites with this. */
export async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/healthz`)
    return res.ok
  } catch {
    return false
  }
}

/** One-shot: fresh account + app session token under a shared app. */
export async function serviceToken(appId: string, displayName: string): Promise<string> {
  const userToken = await enrollAccount(displayName)
  return authorizeApp(userToken, appId)
}
