import { create } from 'zustand'
import { wsClient } from '../lib/ws-client.ts'

export type FriendStatus = 'online' | 'away' | 'offline'
export type SelfStatus = 'online' | 'away' | 'invisible'

interface PresenceState {
  statuses: Record<string, FriendStatus>
  self: SelfStatus
  setSelf(status: SelfStatus): Promise<void>
}

export const usePresence = create<PresenceState>((set) => ({
  statuses: {},
  self: 'online',
  async setSelf(status) {
    set({ self: status })
    try {
      await wsClient.send('presence.set', { status })
    } catch {
      // offline — server derives presence from the connection anyway
    }
  },
}))

/** Subscribe the store to WS events; returns an unsubscribe. */
export function wirePresence(): () => void {
  const unsubscribes = [
    wsClient.on('presence.snapshot', (message) => {
      const statuses: Record<string, FriendStatus> = {}
      for (const friend of message.payload.friends) statuses[friend.accountId] = friend.status
      usePresence.setState({ statuses })
    }),
    wsClient.on('presence.update', (message) => {
      usePresence.setState((state) => ({
        statuses: { ...state.statuses, [message.payload.accountId]: message.payload.status },
      }))
    }),
  ]
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe()
  }
}
