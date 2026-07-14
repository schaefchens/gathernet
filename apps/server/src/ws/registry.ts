import type { ServerMessage } from '@gathernet/shared'
import type { WsSession } from './gateway.ts'

/**
 * In-memory registry of live authenticated sockets on this node.
 * Presence (stage 5) and delivery fan-out (stage 6) build on this.
 * Multi-node later replaces direct calls with a bus behind the same shape.
 */
export class ConnectionRegistry {
  private byDevice = new Map<string, Set<WsSession>>()
  private byAccount = new Map<string, Set<WsSession>>()

  add(session: WsSession): void {
    getOrCreate(this.byDevice, session.deviceId).add(session)
    getOrCreate(this.byAccount, session.accountId).add(session)
  }

  remove(session: WsSession): void {
    this.byDevice.get(session.deviceId)?.delete(session)
    if (this.byDevice.get(session.deviceId)?.size === 0) this.byDevice.delete(session.deviceId)
    this.byAccount.get(session.accountId)?.delete(session)
    if (this.byAccount.get(session.accountId)?.size === 0) {
      this.byAccount.delete(session.accountId)
    }
  }

  isAccountOnline(accountId: string): boolean {
    return (this.byAccount.get(accountId)?.size ?? 0) > 0
  }

  socketCount(accountId: string): number {
    return this.byAccount.get(accountId)?.size ?? 0
  }

  sendToAccount(accountId: string, message: ServerMessage): void {
    for (const session of this.byAccount.get(accountId) ?? []) session.send(message)
  }

  sendToDevice(deviceId: string, message: ServerMessage): void {
    for (const session of this.byDevice.get(deviceId) ?? []) session.send(message)
  }

  /** Push a final message, then close every socket of a device. */
  closeDevice(deviceId: string, message: ServerMessage): void {
    for (const session of this.byDevice.get(deviceId) ?? []) {
      session.send(message)
      session.socket.close(4403, 'revoked')
    }
  }

  onlineAccountIds(): string[] {
    return [...this.byAccount.keys()]
  }
}

function getOrCreate<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  return set
}
