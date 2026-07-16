export type GathernetErrorCode =
  | 'cancelled'
  | 'denied'
  | 'popup_blocked'
  | 'expired'
  | 'unauthorized'
  | 'insufficient_scope'
  | 'no_storage_key'
  | 'version_conflict'
  | 'quota_exceeded'
  | 'not_found'
  | 'network'
  | 'server'

export class GathernetError extends Error {
  constructor(
    readonly code: GathernetErrorCode | string,
    message?: string,
    readonly status?: number,
  ) {
    super(message ?? code)
    this.name = 'GathernetError'
  }
}
