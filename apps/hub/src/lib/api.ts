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
