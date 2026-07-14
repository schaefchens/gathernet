import './i18n/index.ts'
import './styles/app.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { wsClient } from './lib/ws-client.ts'
import { routeTree } from './routeTree.gen.ts'
import { wirePresence } from './stores/presence.ts'
import { useSession } from './stores/session.ts'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
})

// WS events → query invalidation + presence store.
wirePresence()
wsClient.on('friend.added', () => {
  void queryClient.invalidateQueries({ queryKey: ['friends'] })
})
wsClient.on('friend.removed', () => {
  void queryClient.invalidateQueries({ queryKey: ['friends'] })
})
wsClient.on('session.revoked', () => {
  void useSession.getState().forgetDevice()
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
