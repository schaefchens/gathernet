/**
 * @gathernet/sdk/server — a headless Node client for an app's own backend.
 *
 * ```ts
 * import { GathernetServer } from '@gathernet/sdk/server'
 * const gn = await GathernetServer.init({
 *   appId: 'pub_…',
 *   serverUrl: 'http://localhost:4000',
 *   serviceToken: process.env.GATHERNET_SERVICE_TOKEN, // a gna. app token
 * })
 * const room = await gn.rooms.create({ title: 'Lobby', public: true, compatTag: 'v1' })
 * room.onMessage(({ from, payload }) => { /* authoritative game logic *\/ })
 * ```
 *
 * It joins rooms as a normal app member (bot / authoritative logic) using the
 * app's own service account token, and exposes the SAME rooms API as the
 * browser SDK — the Room implementation is shared (see rooms/client.ts).
 *
 * SERVICE-ACCOUNT / isService NOTE: room_members carries an `is_service`
 * column, but no server code path sets it (registerAppDevice / joinRoom insert
 * plain rows). For M2 a "service account" is therefore just an ordinary app
 * account whose token happens to live on a backend; isService stays false and
 * server devices are indistinguishable from user devices at the protocol
 * level. Marking service members would need a server change, deliberately not
 * made here.
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { GathernetError } from './errors.ts'
import { HttpClient } from './internal.ts'
import { RoomsClient } from './rooms/client.ts'
import type { MlsModule } from './rooms/mls.ts'

export { GathernetError } from './errors.ts'
export type {
  ChatMessage,
  CreateRoomOptions,
  EphemeralMessage,
  IntentMessage,
  PublicRoom,
  Room,
  RoomMember,
} from './rooms/client.ts'

const DEFAULT_SERVER = 'http://localhost:4000'

export interface GathernetServerConfig {
  appId: string
  serverUrl?: string
  /** A pre-minted `gna.` app-session token for the app's service account. */
  serviceToken: string
  /** Optional fixed 32-byte device seed for a stable bot device id. */
  deviceSecret?: Uint8Array
}

interface AppMeResponse {
  appUserId: string
  displayName: string
  scopes: string[]
  app: { appId: string; name: string }
}

/**
 * Resolve the wasm bytes shipped with @gathernet/mls-client (Node has no URL
 * fetch). Uses createRequire().resolve — works in real Node ESM and under
 * vitest, unlike import.meta.resolve which the test transform strips.
 */
async function loadMlsModule(): Promise<MlsModule> {
  const mls = await import('@gathernet/mls-client')
  const require = createRequire(import.meta.url)
  const entry = require.resolve('@gathernet/mls-client')
  const wasmUrl = new URL('../wasm/mls_wasm_bg.wasm', `file://${entry}`)
  await mls.initMls({ wasmBytes: new Uint8Array(await readFile(fileURLToPath(wasmUrl))) })
  return mls
}

export class GathernetServer {
  private constructor(
    private readonly http: HttpClient,
    private readonly serviceToken: string,
    readonly me: { appUserId: string; displayName: string; scopes: string[] },
    readonly rooms: RoomsClient,
  ) {}

  static async init(config: GathernetServerConfig): Promise<GathernetServer> {
    if (!config.serviceToken) throw new GathernetError('unauthorized', 'serviceToken required')
    const serverUrl = config.serverUrl ?? DEFAULT_SERVER
    const http = new HttpClient(
      serverUrl,
      () => config.serviceToken,
      () => undefined,
    )

    const { data: me } = await http.request<AppMeResponse>('GET', '/api/v1/app/me')
    if (!me.scopes.includes('rooms')) {
      throw new GathernetError('insufficient_scope', "service token lacks the 'rooms' scope")
    }

    const rooms = new RoomsClient({
      http,
      serverUrl,
      getToken: () => config.serviceToken,
      self: () => ({ appUserId: me.appUserId, displayName: me.displayName }),
      initMls: loadMlsModule,
      ...(config.deviceSecret ? { deviceSecret: config.deviceSecret } : {}),
    })

    return new GathernetServer(http, config.serviceToken, me, rooms)
  }

  /** Log this service session out and tear down the rooms WebSocket. */
  async close(): Promise<void> {
    await this.rooms.close()
    await this.http.request('POST', '/api/v1/app/logout').catch(() => undefined)
  }
}
