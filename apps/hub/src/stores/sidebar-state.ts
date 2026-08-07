import { create } from 'zustand'

const KEY = 'gathernet.sidebar.v1'

interface Persisted {
  /** communityId → whether its channels are showing in the conversation list */
  expanded: Record<string, boolean>
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Persisted) : { expanded: {} }
  } catch {
    return { expanded: {} }
  }
}

/**
 * How the conversation list is arranged, remembered across navigation and reloads.
 *
 * Local to the device on purpose, like the read markers: which communities you
 * keep open is a UI preference, not something the server needs to know. Held in a
 * store rather than component state because the list unmounts on mobile every time
 * you open a conversation — without this you had to re-expand a community every
 * time you came back to switch channels.
 */
export const useSidebarState = create<Persisted>(() => load())

function persist(next: Persisted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // storage blocked — the layout just won't survive a reload
  }
}

export function setCommunityExpanded(communityId: string, expanded: boolean): void {
  const current = useSidebarState.getState()
  if (current.expanded[communityId] === expanded) return
  const next = { expanded: { ...current.expanded, [communityId]: expanded } }
  useSidebarState.setState(next)
  persist(next)
}
