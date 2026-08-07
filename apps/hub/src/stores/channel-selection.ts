import { create } from 'zustand'

const KEY = 'gathernet.channelSelection.v1'

function load(): Record<string, string | null> {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Record<string, string | null>) : {}
  } catch {
    return {}
  }
}

interface ChannelSelectionState {
  /** communityId → the channel the user is currently reading */
  byCommunity: Record<string, string | null>
}

/**
 * Which channel is open per community. Lifted out of the community route because
 * the channel list lives in the app sidebar on desktop and in the page on mobile —
 * both need to read and write the same selection.
 */
export const useChannelSelection = create<ChannelSelectionState>(() => ({
  byCommunity: load(),
}))

export function selectChannel(communityId: string, channelId: string | null): void {
  const next = { ...useChannelSelection.getState().byCommunity, [communityId]: channelId }
  useChannelSelection.setState({ byCommunity: next })
  try {
    // Coming back to a community should land you where you left it.
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // storage blocked — selection just won't survive a reload
  }
}
