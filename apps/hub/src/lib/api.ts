export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body?: unknown,
  ) {
    super(`${status} ${code}`)
  }
}

let tokenProvider: () => string | null = () => null

/** The session store installs this once a session token exists. */
export function setTokenProvider(provider: () => string | null): void {
  tokenProvider = provider
}

export async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {}
  const token = tokenProvider()
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : null,
  })

  const json: unknown = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    const code =
      typeof json === 'object' && json !== null && 'error' in json
        ? String((json as { error: unknown }).error)
        : 'http_error'
    throw new ApiError(res.status, code, json)
  }
  return json as T
}

/** Binary GET (e.g. encrypted community media octet-streams). */
export async function apiBytes(path: string): Promise<Uint8Array> {
  const headers: Record<string, string> = {}
  const token = tokenProvider()
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(path, { method: 'GET', headers })
  if (!res.ok) throw new ApiError(res.status, 'http_error')
  return new Uint8Array(await res.arrayBuffer())
}

/** Best-effort POST that survives the page being torn down (`keepalive`). Used by the
 *  reminder clock's early-fire on pagehide — fire-and-forget, response ignored. */
export function apiKeepalive(path: string, body: unknown): void {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const token = tokenProvider()
  if (token) headers.authorization = `Bearer ${token}`
  void fetch(path, { method: 'POST', headers, body: JSON.stringify(body), keepalive: true }).catch(
    () => {},
  )
}
