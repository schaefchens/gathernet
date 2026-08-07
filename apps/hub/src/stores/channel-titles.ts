import { create } from 'zustand'

interface DecryptedNames {
  /** channelId → decrypted title, learned as rows render */
  byId: Record<string, string>
  /** communityId → decrypted name */
  communities: Record<string, string>
}

/**
 * Decrypted channel titles, cached as the rows that decrypt them render.
 *
 * The conversation list needs titles to filter by channel name, but a title only
 * exists after `useDecryptedMeta` has opened the sealed metadata — which happens
 * inside each row, and can't be hoisted into a loop of hooks over a list whose
 * length changes. So rows publish what they decrypt and the list reads it here.
 * Titles for channels never rendered are simply unknown, which is why searching
 * expands the communities it is searching through.
 */
export const useChannelTitles = create<DecryptedNames>(() => ({ byId: {}, communities: {} }))

export function rememberChannelTitle(channelId: string, title: string): void {
  if (useChannelTitles.getState().byId[channelId] === title) return
  useChannelTitles.setState((s) => ({ byId: { ...s.byId, [channelId]: title } }))
}

export function rememberCommunityName(communityId: string, name: string): void {
  if (useChannelTitles.getState().communities[communityId] === name) return
  useChannelTitles.setState((s) => ({ communities: { ...s.communities, [communityId]: name } }))
}
