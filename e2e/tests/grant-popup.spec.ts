import { createHash, generateKeyPairSync, type KeyObject, sign as nodeSign } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'

/**
 * M2 app-grant popup flow, end to end without the SDK: a publisher account +
 * app publication are created via the HTTP API (scripted enrollment with
 * node:crypto Ed25519 and a minimal CBOR device cert, mirroring
 * apps/server/test/helpers/client-crypto.ts), then a Hub account handles
 * /authorize popups opened from an opener page on the hub origin, asserting
 * the postMessage grant contract: deny, approve (with per-app storage key),
 * and remembered-consent auto-approval.
 */

const API = process.env.E2E_API_ORIGIN ?? 'http://localhost:4000'
const HUB_ORIGIN = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:5173').origin

/* ---------- minimal CBOR (definite lengths, enough for the device cert) ---------- */

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

/* ---------- scripted enrollment ---------- */

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

/** Enroll a publisher account and register an app publication; returns the appId. */
async function registerAppPublication(): Promise<string> {
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
    cborText('E2E publisher'),
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
    displayName: 'Publisher',
  })
  const pub = await apiCall<{ pubId: string }>(
    'POST',
    '/api/v1/publications',
    {
      kind: 'app',
      name: 'Grant Test App',
      description: 'E2E harness app',
      appConfig: { origins: [HUB_ORIGIN], allowedScopes: ['identity', 'storage'] },
    },
    session.token,
  )
  return pub.pubId
}

/* ---------- UI helpers (createAccount copied from journey.spec.ts) ---------- */

async function createAccount(page: Page, displayName: string): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create account' }).click()

  await page.getByPlaceholder('Display name').fill(displayName)
  await page.getByRole('button', { name: 'Continue' }).click()

  // Scrape the recovery phrase, then confirm the requested word.
  await expect(page.getByText('Your recovery phrase')).toBeVisible()
  const items = await page
    .getByRole('list', { name: 'recovery phrase' })
    .locator('li')
    .allTextContents()
  const words = items.map((item) => item.replace(/^\d+\./, '').trim())
  expect(words).toHaveLength(12)
  await page.getByRole('button', { name: 'I wrote it down' }).click()

  const hint = await page.getByText(/Enter word \d+ of your phrase/).textContent()
  const index = Number(/Enter word (\d+)/.exec(hint ?? '')?.[1]) - 1
  await page
    .locator('form input')
    .first()
    .fill(words[index] ?? '')
  await page.getByRole('button', { name: 'Continue' }).click()

  await page.getByPlaceholder('Unlock password', { exact: true }).fill('test-password-1')
  await page.getByPlaceholder('Repeat password').fill('test-password-1')
  await page.getByRole('button', { name: 'Continue' }).click()

  // Argon2id (64 MiB) + account creation + MLS init can take a moment.
  await expect(page.getByRole('heading', { name: 'Friends' })).toBeVisible({ timeout: 60_000 })
}

interface GrantMessage {
  type: string
  state?: string
  token?: string
  appUserId?: string
  displayName?: string
  scopes?: string[]
  expiresAt?: number
  storageKey?: string
}

type MessageWindow = Window & { __grantMessages: GrantMessage[] }

async function openAuthorizePopup(opener: Page, url: string): Promise<Page> {
  const [popup] = await Promise.all([
    opener.context().waitForEvent('page'),
    opener.evaluate((target) => {
      window.open(target, '_blank', 'width=420,height=680')
    }, url),
  ])
  popup.on('pageerror', (err) => console.log(`[popup:pageerror] ${err.message}`))
  return popup
}

async function unlockPopup(popup: Page): Promise<void> {
  await popup.getByPlaceholder('Unlock password').fill('test-password-1')
  await popup.getByRole('button', { name: 'Unlock' }).click()
}

async function waitForMessage(opener: Page, type: string, state: string): Promise<GrantMessage> {
  await opener.waitForFunction(
    ([wantType, wantState]) =>
      (window as unknown as MessageWindow).__grantMessages.some(
        (m) => m?.type === wantType && m?.state === wantState,
      ),
    [type, state] as const,
    { timeout: 60_000 },
  )
  const message = await opener.evaluate(
    ([wantType, wantState]) =>
      (window as unknown as MessageWindow).__grantMessages.find(
        (m) => m?.type === wantType && m?.state === wantState,
      ),
    [type, state] as const,
  )
  if (!message) throw new Error(`message ${type}/${state} vanished`)
  return message
}

test('authorize popup: deny, approve with storage key, remembered consent', async ({ browser }) => {
  const appId = await registerAppPublication()

  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('pageerror', (err) => console.log(`[hub:pageerror] ${err.message}`))
  await createAccount(page, 'Grace')

  // Opener page on the hub origin (the app's registered origin in this test).
  const opener = await context.newPage()
  await opener.goto('/healthz')
  await opener.evaluate(() => {
    ;(window as unknown as MessageWindow).__grantMessages = []
    window.addEventListener('message', (event) => {
      ;(window as unknown as MessageWindow).__grantMessages.push(event.data as GrantMessage)
    })
  })

  const authorizeUrl = (state: string) =>
    `/authorize?appId=${appId}&scopes=identity,storage&state=${state}&origin=${encodeURIComponent(HUB_ORIGIN)}`

  // Deny path: the opener is notified, no grant is stored.
  const denyPopup = await openAuthorizePopup(opener, authorizeUrl('state-deny'))
  await unlockPopup(denyPopup)
  await denyPopup.getByRole('button', { name: 'Deny' }).click()
  const denied = await waitForMessage(opener, 'gathernet:grant-denied', 'state-deny')
  expect(denied.state).toBe('state-deny')

  // Approve path: app session token + per-app storage key reach the opener.
  const approvePopup = await openAuthorizePopup(opener, authorizeUrl('state-approve'))
  await unlockPopup(approvePopup)
  await approvePopup.getByRole('button', { name: 'Approve' }).click()
  const granted = await waitForMessage(opener, 'gathernet:grant', 'state-approve')
  expect(granted.token).toMatch(/^gna\./)
  expect(granted.appUserId).toBeTruthy()
  expect(granted.displayName).toBe('Grace')
  expect(granted.scopes).toEqual(expect.arrayContaining(['identity', 'storage']))
  expect(typeof granted.expiresAt).toBe('number')
  expect(Buffer.from(granted.storageKey ?? '', 'base64')).toHaveLength(32)

  // Remembered consent: the same request auto-approves after unlock — no
  // Approve click. The storage key is deterministic (HKDF from the root).
  const rememberedPopup = await openAuthorizePopup(opener, authorizeUrl('state-remembered'))
  await unlockPopup(rememberedPopup)
  const remembered = await waitForMessage(opener, 'gathernet:grant', 'state-remembered')
  expect(remembered.token).toMatch(/^gna\./)
  expect(remembered.token).not.toBe(granted.token)
  expect(remembered.storageKey).toBe(granted.storageKey)

  await context.close()
})
