import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Gathernet } from '../src/index.ts'

/**
 * jsdom-style unit test of the popup handshake. We stub window.open and
 * fetch (for the /app/me validation) and drive postMessage manually to
 * assert origin + state validation.
 */

const HUB = 'https://hub.example'
const APP_ID = 'pub_0000000000000001'

function stubStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  })
}

describe('Gathernet.login popup handshake', () => {
  let messageHandler: ((e: MessageEvent) => void) | null = null
  let opened: { closed: boolean } | null = null
  let openedState = ''

  beforeEach(() => {
    stubStorage()
    messageHandler = null
    opened = { closed: false }
    vi.stubGlobal('location', { origin: 'https://app.example', protocol: 'https:' })
    vi.stubGlobal('window', {
      open: (url: string) => {
        openedState = new URL(url).searchParams.get('state') ?? ''
        return opened
      },
      addEventListener: (_type: string, h: (e: MessageEvent) => void) => {
        messageHandler = h
      },
      removeEventListener: () => {
        messageHandler = null
      },
    })
    vi.stubGlobal('fetch', async () => new Response('null', { status: 200 }))
  })

  afterEach(() => vi.unstubAllGlobals())

  function post(data: unknown, origin: string) {
    messageHandler?.({ origin, data } as MessageEvent)
  }

  it('resolves on a valid same-origin, matching-state grant', async () => {
    const gn = await Gathernet.init({ appId: APP_ID, hubUrl: HUB })
    const promise = gn.login({ scopes: ['identity'] })
    await vi.waitFor(() => expect(messageHandler).not.toBeNull())

    // Foreign origin and wrong state are both ignored...
    post({ type: 'gathernet:grant', state: openedState, token: 'gna.x' }, 'https://evil.example')
    post({ type: 'gathernet:grant', state: 'wrong', token: 'gna.x' }, HUB)
    // ...then the genuine message resolves login().
    post(
      {
        type: 'gathernet:grant',
        state: openedState,
        token: 'gna.tok',
        appUserId: 'au_1',
        displayName: 'Alice',
        scopes: ['identity'],
        expiresAt: Date.now() + 1000,
      },
      HUB,
    )
    const user = await promise
    expect(user).toMatchObject({ appUserId: 'au_1', displayName: 'Alice' })
    expect(gn.user?.appUserId).toBe('au_1')
  })

  it('rejects on grant-denied', async () => {
    const gn = await Gathernet.init({ appId: APP_ID, hubUrl: HUB })
    const promise = gn.login()
    await vi.waitFor(() => expect(messageHandler).not.toBeNull())
    post({ type: 'gathernet:grant-denied', state: openedState }, HUB)
    await expect(promise).rejects.toMatchObject({ code: 'denied' })
  })

  it('ignores messages from a foreign origin', async () => {
    const gn = await Gathernet.init({ appId: APP_ID, hubUrl: HUB })
    let settled = false
    const promise = gn.login().then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await vi.waitFor(() => expect(messageHandler).not.toBeNull())
    post({ type: 'gathernet:grant', state: openedState, token: 'gna.x' }, 'https://evil.example')
    await Promise.resolve()
    expect(settled).toBe(false)
    void promise
  })
})
