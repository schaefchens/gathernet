import { create } from 'zustand'

interface ChannelSelectionState {
  /** communityId → the channel the user is currently reading */
  byCommunity: Record<string, string | null>
}

/**
 * Which channel is open per community. Lifted out of the community route because
 * the channel list lives in the app sidebar on desktop and in the page on mobile —
 * both need to read and write the same selection.
 */
export const useChannelSelection = create<ChannelSelectionState>(() => ({ byCommunity: {} }))

export function selectChannel(communityId: string, channelId: string | null): void {
  useChannelSelection.setState((s) => ({
    byCommunity: { ...s.byCommunity, [communityId]: channelId },
  }))
}
