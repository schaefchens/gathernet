import { create } from 'zustand'

const READ_KEY = 'gathernet.lastRead.v1'
const CHANNELS_KEY = 'gathernet.communityChannels.v1'

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage full or blocked — unread marks are a convenience, not state worth failing over
  }
}

interface ReadState {
  /** conversation key → the `sentAt` of the newest message the user has seen */
  lastRead: Record<string, number>
  /** communityId → its channelIds, learned when a community is opened */
  communityChannels: Record<string, string[]>
}

/**
 * Read markers and the community→channel index, held on this device only.
 *
 * Deliberately never sent to the server: what you have read, and when, is exactly
 * the kind of per-user metadata the product does not want the server to hold. The
 * cost is that read state does not follow you to another device, which is the
 * right trade here.
 */
export const useReadState = create<ReadState>(() => ({
  lastRead: load(READ_KEY, {}),
  communityChannels: load(CHANNELS_KEY, {}),
}))

export const dmKey = (friendAccountId: string): string => `dm:${friendAccountId}`
export const channelKey = (channelId: string): string => `ch:${channelId}`

/** Mark everything up to `ts` as read. Monotonic — never moves backwards. */
export function markRead(key: string, ts: number): void {
  const current = useReadState.getState().lastRead
  if ((current[key] ?? 0) >= ts) return
  const next = { ...current, [key]: ts }
  useReadState.setState({ lastRead: next })
  persist(READ_KEY, next)
}

/**
 * Record which channels belong to a community, so the conversation list can tell
 * whether a community has anything unread without fetching every community's
 * detail on load. Communities you have never opened simply show no unread mark.
 */
export function rememberCommunityChannels(communityId: string, channelIds: string[]): void {
  const current = useReadState.getState().communityChannels
  const previous = current[communityId]
  if (
    previous &&
    previous.length === channelIds.length &&
    previous.every((id, i) => id === channelIds[i])
  ) {
    return
  }
  const next = { ...current, [communityId]: channelIds }
  useReadState.setState({ communityChannels: next })
  persist(CHANNELS_KEY, next)
}
