import { GathernetError } from './errors.ts'

export interface SdkConfig {
  appId: string
  serverUrl: string
  hubUrl: string
}

export interface StoredSession {
  token: string
  appUserId: string
  displayName: string
  scopes: string[]
  expiresAt: number
  /** base64 per-app storage key, present iff the storage scope was granted with a key */
  storageKey?: string
}

export const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
export const fromB64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

const sessionKey = (appId: string) => `gn.sdk.${appId}`

export function loadStoredSession(appId: string): StoredSession | null {
  try {
    const raw = localStorage.getItem(sessionKey(appId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredSession
    if (!parsed.token || parsed.expiresAt < Date.now()) return null
    return parsed
  } catch {
    return null
  }
}

export function storeSession(appId: string, session: StoredSession | null): void {
  if (session) {
    localStorage.setItem(sessionKey(appId), JSON.stringify(session))
  } else {
    localStorage.removeItem(sessionKey(appId))
  }
}

export class HttpClient {
  constructor(
    private readonly serverUrl: string,
    private readonly getToken: () => string | null,
    private readonly onUnauthorized: () => void,
  ) {}

  async request<T>(
    method: string,
    path: string,
    options: {
      json?: unknown
      body?: Uint8Array
      headers?: Record<string, string>
      auth?: boolean
      raw?: boolean
    } = {},
  ): Promise<{ data: T; headers: Headers }> {
    const headers: Record<string, string> = { ...options.headers }
    if (options.auth !== false) {
      const token = this.getToken()
      if (!token) throw new GathernetError('unauthorized', 'not logged in')
      headers.authorization = `Bearer ${token}`
    }
    let body: string | Uint8Array | undefined
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.json)
    } else if (options.body) {
      headers['content-type'] = 'application/octet-stream'
      body = options.body
    }

    let response: Response
    try {
      response = await fetch(`${this.serverUrl}${path}`, {
        method,
        headers,
        body: (body ?? null) as BodyInit | null,
      })
    } catch (err) {
      throw new GathernetError('network', String(err))
    }

    if (response.status === 401 && options.auth !== false) {
      this.onUnauthorized()
      throw new GathernetError('unauthorized', undefined, 401)
    }
    if (!response.ok && response.status !== 202) {
      let code = 'server'
      try {
        const parsed = (await response.json()) as { error?: string }
        if (parsed.error) code = parsed.error
      } catch {
        // non-JSON error body
      }
      throw new GathernetError(code, undefined, response.status)
    }

    if (options.raw) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      return { data: bytes as unknown as T, headers: response.headers }
    }
    const text = await response.text()
    return {
      data: (text ? JSON.parse(text) : null) as T,
      headers: response.headers,
    }
  }
}
