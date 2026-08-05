import './i18n/index.ts'
import './styles/app.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { wsClient } from './lib/ws-client.ts'
import { routeTree } from './routeTree.gen.ts'
import { communityChatStore } from './stores/community-chat.ts'
import { wirePresence } from './stores/presence.ts'
import { useSession } from './stores/session.ts'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
})

// WS events → query invalidation + presence store.
wirePresence()
wsClient.on('friend.added', () => {
  void queryClient.invalidateQueries({ queryKey: ['friends'] })
  void queryClient.invalidateQueries({ queryKey: ['connect-requests'] })
})
wsClient.on('friend.removed', () => {
  void queryClient.invalidateQueries({ queryKey: ['friends'] })
})
// A directed connect request arrived → refresh the inbox.
wsClient.on('friend.request', () => {
  void queryClient.invalidateQueries({ queryKey: ['connect-requests'] })
})
wsClient.on('session.revoked', () => {
  void useSession.getState().forgetDevice()
})

// Community membership/role/channel changes → refresh the list + the affected
// community detail so member panels, roles, and channel lists stay live.
const invalidateCommunity = (communityId: string) => {
  void queryClient.invalidateQueries({ queryKey: ['communities'] })
  void queryClient.invalidateQueries({ queryKey: ['community', communityId] })
}
for (const event of [
  'community.member_joined',
  'community.member_left',
  'community.member_removed',
  'community.role_changed',
  'community.updated',
  'community.channel_created',
  'community.channel_updated',
  'community.channel_deleted',
  'community.channel_join_request',
  'community.channel_join_approved',
  'community.channel_join_declined',
  'community.channel_invited',
  'community.channel_member_changed',
] as const) {
  wsClient.on(event, (m) => invalidateCommunity(m.payload.communityId))
}

// A member joined → an owner/leader issues their membership cap NOW (targeted), so
// the joiner is capped before a manager tops up their key grant (else the capability
// gate would skip them, and they'd never receive the key).
wsClient.on('community.member_joined', (m) => {
  void communityChatStore.issueMemberCapForJoiner(m.payload.communityId, m.payload.accountId)
})

// A K_meta grant became available for this account → a device lacking the key
// can now fetch + open it; refresh decrypted views once it lands.
wsClient.on('community.key_grants_available', (m) => {
  // Fetch-only: obtain our key. Never re-grant here — that would cascade.
  void communityChatStore.fetchKeyGrant(m.payload.communityId).then((obtained) => {
    if (obtained) invalidateCommunity(m.payload.communityId)
  })
})

// A member left/was removed → a leader's client rotates K_meta (re-encrypts
// metadata under a new epoch). Non-leaders and non-holders no-op.
wsClient.on('community.rotation_needed', (m) => {
  void communityChatStore.rotateCommunity(m.payload.communityId).then((rotated) => {
    if (rotated) invalidateCommunity(m.payload.communityId)
  })
})

// A member left/was removed from a group_key channel → a manager's client mints
// a new K_channel epoch. The server addressed this only to managers; a
// non-holder / stale-epoch client no-ops (best effort).
wsClient.on('community.channel_key_grants_available', (m) => {
  void communityChatStore
    .fetchChannelKey(m.payload.communityId, m.payload.channelId)
    .then(() => invalidateCommunity(m.payload.communityId))
})
wsClient.on('community.channel_rotation_needed', (m) => {
  void communityChatStore.rotateChannelForEvent(m.payload.communityId, m.payload.channelId)
})
// A member joined/changed in a group_key channel → a manager tops up their grant.
wsClient.on('community.channel_member_changed', (m) => {
  void communityChatStore.syncChannelGrants(m.payload.communityId, m.payload.channelId)
})

const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

void useSession.getState().boot()

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
