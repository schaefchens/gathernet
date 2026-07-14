import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WelcomeFlow } from '../features/onboarding/WelcomeFlow.tsx'
import { PresenceSelector } from '../features/presence/PresenceSelector.tsx'
import { UpdatePrompt } from '../features/pwa/UpdatePrompt.tsx'
import { UnlockScreen } from '../features/unlock/UnlockScreen.tsx'
import { type WsStatus, wsClient } from '../lib/ws-client.ts'
import { useSession } from '../stores/session.ts'

export const Route = createRootRoute({ component: RootComponent })

function RootComponent() {
  const phase = useSession((s) => s.phase)
  const { t } = useTranslation()

  if (phase === 'loading') {
    return (
      <div className="min-h-screen grid place-items-center text-ink-soft">
        {t('common.loading')}
      </div>
    )
  }
  return (
    <>
      {phase === 'welcome' ? <WelcomeFlow /> : phase === 'locked' ? <UnlockScreen /> : <AppShell />}
      <UpdatePrompt />
    </>
  )
}

function AppShell() {
  const { t } = useTranslation()
  const [wsStatus, setWsStatus] = useState<WsStatus>(wsClient.status)

  useEffect(() => wsClient.onStatus(setWsStatus), [])

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-edge bg-raised">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/" className="font-display text-2xl text-gold">
            {t('common.appName')}
          </Link>
          <div className="flex items-center gap-4">
            {wsStatus !== 'connected' && (
              <span className="text-xs text-amber">{t('common.connecting')}</span>
            )}
            <PresenceSelector />
            <Link to="/settings" className="text-ink-soft hover:text-ink" aria-label="Settings">
              ⚙
            </Link>
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
