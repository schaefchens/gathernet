/**
 * @gathernet/sdk — the Gathernet platform SDK for third-party apps.
 * Framework-agnostic; identity + encrypted cloud saves (rooms load lazily).
 *
 * ```ts
 * const gn = await Gathernet.init({ appId: 'pub_…' })
 * const user = gn.user ?? await gn.login({ scopes: ['identity', 'storage'] })
 * await gn.storage.putJSON('save', { level: 3 })
 * ```
 */
import { eciesOpen, GRANT_QR_PREFIX, generateEciesKeypair } from '@gathernet/shared'
import { GathernetError } from './errors.ts'
import {
  b64,
  fromB64,
  HttpClient,
  loadStoredSession,
  type SdkConfig,
  type StoredSession,
  storeSession,
} from './internal.ts'
import { RoomsClient } from './rooms/client.ts'
import type { MlsModule } from './rooms/mls.ts'
import { openBlob, sealBlob } from './storage-crypto.ts'

export { GathernetError } from './errors.ts'
export type {
  ChatMessage,
  CreateRoomOptions,
  EphemeralMessage,
  IntentMessage,
  PublicRoom,
  Room,
  RoomMember,
  RoomsClient,
} from './rooms/client.ts'

export type Scope = 'identity' | 'storage' | 'rooms'

export interface AppUser {
  appUserId: string
  displayName: string
  scopes: Scope[]
}

export interface GathernetConfig {
  appId: string
  /** default http://localhost:4000 in dev; the public API origin in prod */
  serverUrl?: string
  /** default http://localhost:5173 in dev; the Hub origin in prod */
  hubUrl?: string
}

export interface StorageEntry {
  key: string
  size: number
  version: number
  updatedAt: number
}

export interface CodeLogin {
  userCode: string
  qrPayload: string
  expiresAt: number
  waitForGrant(): Promise<AppUser>
  cancel(): void
}

const DEFAULT_SERVER = 'http://localhost:4000'
const DEFAULT_HUB = 'http://localhost:5173'

export class Gathernet {
  private session: StoredSession | null = null
  private readonly config: SdkConfig
  private readonly http: HttpClient
  private readonly authListeners = new Set<(user: AppUser | null) => void>()
  private roomsClient: RoomsClient | null = null

  private constructor(config: SdkConfig) {
    this.config = config
    this.http = new HttpClient(
      config.serverUrl,
      () => this.session?.token ?? null,
      () => this.setSession(null),
    )
  }

  /** Restores any persisted session and validates it. Never throws for a dead session. */
  static async init(config: GathernetConfig): Promise<Gathernet> {
    const gn = new Gathernet({
      appId: config.appId,
      serverUrl: config.serverUrl ?? DEFAULT_SERVER,
      hubUrl: config.hubUrl ?? DEFAULT_HUB,
    })
    const stored = loadStoredSession(config.appId)
    if (stored) {
      gn.session = stored
      try {
        await gn.http.request('GET', '/api/v1/app/me')
      } catch {
        gn.session = null
        storeSession(config.appId, null)
      }
    }
    return gn
  }

  get user(): AppUser | null {
    return this.session
      ? {
          appUserId: this.session.appUserId,
          displayName: this.session.displayName,
          scopes: this.session.scopes as Scope[],
        }
      : null
  }

  onAuthChange(listener: (user: AppUser | null) => void): () => void {
    this.authListeners.add(listener)
    return () => this.authListeners.delete(listener)
  }

  private setSession(session: StoredSession | null): void {
    this.session = session
    storeSession(this.config.appId, session)
    for (const listener of this.authListeners) listener(this.user)
  }

  /** Popup grant flow. Call from a user gesture (popup blockers). */
  async login(options: { scopes?: Scope[] } = {}): Promise<AppUser> {
    const scopes = options.scopes ?? ['identity']
    const state = b64(crypto.getRandomValues(new Uint8Array(16)))
    const url = new URL('/authorize', this.config.hubUrl)
    url.searchParams.set('appId', this.config.appId)
    url.searchParams.set('scopes', scopes.join(','))
    url.searchParams.set('state', state)
    url.searchParams.set('origin', location.origin)

    const popup = window.open(url.toString(), 'gathernet-auth', 'width=440,height=680,popup=yes')
    if (!popup) throw new GathernetError('popup_blocked')

    const hubOrigin = new URL(this.config.hubUrl).origin
    return new Promise<AppUser>((resolve, reject) => {
      const cleanup = () => {
        window.removeEventListener('message', onMessage)
        clearInterval(closedPoll)
      }
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== hubOrigin) return
        const data = event.data as {
          type?: string
          state?: string
          token?: string
          appUserId?: string
          displayName?: string
          scopes?: string[]
          expiresAt?: number
          storageKey?: string
        }
        if (data?.state !== state) return
        if (data.type === 'gathernet:grant-denied') {
          cleanup()
          reject(new GathernetError('denied'))
          return
        }
        if (data.type === 'gathernet:grant' && data.token) {
          cleanup()
          this.setSession({
            token: data.token,
            appUserId: data.appUserId ?? '',
            displayName: data.displayName ?? '',
            scopes: data.scopes ?? scopes,
            expiresAt: data.expiresAt ?? Date.now() + 13 * 24 * 3600 * 1000,
            ...(data.storageKey ? { storageKey: data.storageKey } : {}),
          })
          const user = this.user
          if (user) resolve(user)
        }
      }
      const closedPoll = setInterval(() => {
        if (popup.closed) {
          cleanup()
          reject(new GathernetError('cancelled'))
        }
      }, 500)
      window.addEventListener('message', onMessage)
    })
  }

  /** Device-code flow: show the code/QR; resolve when approved in the Hub. */
  async loginWithCode(options: { scopes?: Scope[] } = {}): Promise<CodeLogin> {
    const scopes = options.scopes ?? ['identity']
    const keys = await generateEciesKeypair()
    const { data } = await this.http.request<{
      userCode: string
      qrPayload: string
      pollSecret: string
      expiresAt: number
    }>('POST', '/api/v1/app/grant-codes', {
      auth: false,
      json: { appId: this.config.appId, scopes, ephemeralPk: keys.publicKeyB64 },
    })

    // Build the QR payload LOCALLY, embedding our ephemeral public key so it
    // travels to the Hub out-of-band (via the human scanning the code) rather
    // than through the untrusted server. The Hub seals the storage key to the
    // scanned key, so a malicious server cannot substitute its own key to MITM
    // the handoff. Manual code entry (userCode only) carries no key, so the
    // Hub grants without a storage key on that path — use login() for storage.
    const qrPayload = `${GRANT_QR_PREFIX}${data.userCode}:${keys.publicKeyB64}`

    let cancelled = false
    const waitForGrant = async (): Promise<AppUser> => {
      while (!cancelled) {
        const { data: poll } = await this.http
          .request<{
            status?: string
            token?: string
            appUserId?: string
            displayName?: string
            scopes?: string[]
            expiresAt?: number
            sealedStorageKey?: string | null
            hubEphemeralPk?: string | null
          }>('POST', '/api/v1/app/grant-codes/poll', {
            auth: false,
            json: { pollSecret: data.pollSecret, waitSeconds: 20 },
          })
          .catch((err: unknown) => {
            if (err instanceof GathernetError && err.status === 410) {
              throw new GathernetError(err.code === 'denied' ? 'denied' : 'expired')
            }
            throw err
          })

        if (poll?.token) {
          let storageKey: string | undefined
          if (poll.sealedStorageKey && poll.hubEphemeralPk) {
            const opened = await eciesOpen(
              keys.privateKey,
              poll.hubEphemeralPk,
              poll.sealedStorageKey,
              keys.publicKeyB64,
            )
            storageKey = b64(opened)
          }
          this.setSession({
            token: poll.token,
            appUserId: poll.appUserId ?? '',
            displayName: poll.displayName ?? '',
            scopes: poll.scopes ?? scopes,
            expiresAt: poll.expiresAt ?? Date.now() + 13 * 24 * 3600 * 1000,
            ...(storageKey ? { storageKey } : {}),
          })
          const user = this.user
          if (user) return user
        }
        // 202 pending — loop continues (server long-polls 20s per round)
      }
      throw new GathernetError('cancelled')
    }

    return {
      userCode: data.userCode,
      qrPayload,
      expiresAt: data.expiresAt,
      waitForGrant,
      cancel: () => {
        cancelled = true
      },
    }
  }

  async logout(): Promise<void> {
    if (this.session) {
      await this.http.request('POST', '/api/v1/app/logout').catch(() => undefined)
    }
    this.setSession(null)
  }

  /* -------------------------- E2EE rooms --------------------------- */

  /**
   * Lazy rooms accessor. First use dynamically imports @gathernet/mls-client,
   * initializes the wasm module, and opens the rooms WebSocket. Requires the
   * 'rooms' scope. Room MLS state is in-memory only (not persisted across
   * reloads in M2).
   */
  get rooms(): RoomsClient {
    if (!this.roomsClient) {
      this.roomsClient = new RoomsClient({
        http: this.http,
        serverUrl: this.config.serverUrl,
        getToken: () => this.session?.token ?? null,
        self: () => ({
          appUserId: this.session?.appUserId ?? '',
          displayName: this.session?.displayName ?? '',
        }),
        initMls: async (): Promise<MlsModule> => {
          const mls = await import('@gathernet/mls-client')
          await mls.initMls()
          return mls
        },
      })
    }
    return this.roomsClient
  }

  /* ---------------- encrypted cloud saves ---------------- */

  private storageKeyBytes(): Uint8Array {
    const key = this.session?.storageKey
    if (!key) throw new GathernetError('no_storage_key')
    return fromB64(key)
  }

  readonly storage = {
    get: async (key: string): Promise<Uint8Array | null> => {
      try {
        const { data } = await this.http.request<Uint8Array>(
          'GET',
          `/api/v1/app/storage/${encodeURIComponent(key)}`,
          { raw: true },
        )
        return await openBlob(this.storageKeyBytes(), this.config.appId, key, data)
      } catch (err) {
        if (err instanceof GathernetError && err.status === 404) return null
        throw err
      }
    },

    getJSON: async <T>(key: string): Promise<T | null> => {
      const bytes = await this.storage.get(key)
      return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as T) : null
    },

    put: async (
      key: string,
      value: Uint8Array,
      options: { ifVersion?: number } = {},
    ): Promise<{ version: number }> => {
      const sealed = await sealBlob(this.storageKeyBytes(), this.config.appId, key, value)
      const headers: Record<string, string> = {}
      if (options.ifVersion !== undefined) headers['if-match'] = `"${options.ifVersion}"`
      const { data } = await this.http.request<{ version: number }>(
        'PUT',
        `/api/v1/app/storage/${encodeURIComponent(key)}`,
        { body: sealed, headers },
      )
      return data
    },

    putJSON: async (
      key: string,
      value: unknown,
      options: { ifVersion?: number } = {},
    ): Promise<{ version: number }> => {
      return this.storage.put(key, new TextEncoder().encode(JSON.stringify(value)), options)
    },

    list: async (): Promise<StorageEntry[]> => {
      const { data } = await this.http.request<{ entries: StorageEntry[] }>(
        'GET',
        '/api/v1/app/storage',
      )
      return data.entries
    },

    delete: async (key: string): Promise<void> => {
      await this.http.request('DELETE', `/api/v1/app/storage/${encodeURIComponent(key)}`)
    },
  }
}
