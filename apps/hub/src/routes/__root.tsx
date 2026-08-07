import { createRootRoute, Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CatalogIcon,
  ChatIcon,
  CommunityIcon,
  ConnectIcon,
  LockIcon,
  SettingsIcon,
  ShieldIcon,
} from '../components/icons.tsx'
import { ChatList } from '../features/chat/ChatList.tsx'
import { CommunitySidebarPanels } from '../features/communities/CommunitySidebarPanels.tsx'
import { WelcomeFlow } from '../features/onboarding/WelcomeFlow.tsx'
import { PresenceSelector } from '../features/presence/PresenceSelector.tsx'
import { UpdatePrompt } from '../features/pwa/UpdatePrompt.tsx'
import { UnlockScreen } from '../features/unlock/UnlockScreen.tsx'
import { useReminderClock } from '../lib/reminder-clock.ts'
import { DESKTOP_QUERY, useMediaQuery } from '../lib/use-media-query.ts'
import { type WsStatus, wsClient } from '../lib/ws-client.ts'
import { useSession } from '../stores/session.ts'

export const Route = createRootRoute({ component: RootComponent })

function RootComponent() {
  const phase = useSession((s) => s.phase)
  const { t } = useTranslation()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // The /authorize popup drives the session phases itself (minimal chrome,
  // no AppShell) — always render the route there instead of gating on phase.
  if (pathname.startsWith('/authorize')) {
    return (
      <>
        <Outlet />
        <UpdatePrompt />
      </>
    )
  }

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

/** A 1:1 chat or a single community — the routes that should fill the window. */
function isConversation(pathname: string): boolean {
  return pathname.startsWith('/chat/') || /^\/communities\/[^/]+/.test(pathname)
}

/** Top-level surfaces, shared by the desktop rail and the mobile tab bar. */
const NAV = [
  { to: '/', labelKey: 'nav.chats', Icon: ChatIcon },
  { to: '/communities', labelKey: 'nav.communities', Icon: CommunityIcon },
  { to: '/friends/add', labelKey: 'nav.connect', Icon: ConnectIcon },
  { to: '/catalog', labelKey: 'nav.catalog', Icon: CatalogIcon },
] as const

/**
 * The four-column shell: icon rail, conversation sidebar, content, and whatever
 * panel a route opens. Below `md` the rail and sidebar collapse — the sidebar's
 * conversation list becomes the `/` route and the rail becomes a bottom tab bar
 * with an elevated Connect action.
 */
function AppShell() {
  const { t } = useTranslation()
  const [wsStatus, setWsStatus] = useState<WsStatus>(wsClient.status)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const communityId = /^\/communities\/([^/]+)/.exec(pathname)?.[1] ?? null

  useEffect(() => wsClient.onStatus(setWsStatus), [])
  // Peer-triggered event reminders run while the authenticated shell is mounted.
  useReminderClock()

  const isCurrent = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to))

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      {/* Icon rail — desktop only. The whole rail/sidebar/tab-bar split is mounted
          conditionally rather than toggled with `hidden`, so only one copy of the
          navigation, wordmark, and presence control is ever in the DOM. */}
      {isDesktop && (
        <nav
          aria-label={t('nav.primary')}
          className="flex w-[72px] shrink-0 flex-col items-center gap-2 border-r border-edge bg-night py-4"
        >
          <span className="seal h-10 w-10 mb-3" aria-hidden>
            <ShieldIcon size={20} />
          </span>
          {NAV.map(({ to, labelKey, Icon }) => (
            <Link
              key={to}
              to={to}
              className="rail-item"
              aria-label={t(labelKey)}
              title={t(labelKey)}
              aria-current={isCurrent(to) ? 'page' : undefined}
            >
              <Icon />
            </Link>
          ))}
          <span className="flex-1" />
          <Link
            to="/settings"
            className="rail-item"
            aria-label={t('settings.title')}
            title={t('settings.title')}
            aria-current={isCurrent('/settings') ? 'page' : undefined}
          >
            <SettingsIcon />
          </Link>
        </nav>
      )}

      {/* Conversation sidebar — desktop only. */}
      {isDesktop && (
        <aside className="flex w-[310px] shrink-0 flex-col border-r border-edge bg-raised">
          <div className="px-4 pt-4 pb-3">
            <Link to="/" className="font-display text-2xl text-gold-bright leading-none">
              {t('common.appName')}
            </Link>
            <p className="mt-1 text-xs italic text-ink-faint">{t('nav.tagline')}</p>
          </div>
          {/* Both ways of starting something live above the list, so the list itself
              is only conversations. */}
          <div className="flex gap-2 px-3 pb-3">
            <Link to="/friends/add" className="btn-quiet flex-1 text-center text-xs">
              {t('friends.add')}
            </Link>
            <Link
              to="/communities"
              search={{ join: true }}
              className="btn-quiet flex-1 text-center text-xs"
            >
              {t('chats.joinCommunity')}
            </Link>
          </div>
          <p className="section-label px-4 pb-2">{t('chats.title')}</p>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <ChatList compact manage />
            {/* Inside a community the sidebar also carries its people, so the
                community view reads like the chat screen rather than a page with
                panels bolted to the side. */}
            {communityId && (
              <div className="mt-4 border-t border-edge pt-3">
                <CommunitySidebarPanels communityId={communityId} />
              </div>
            )}
          </div>
          <div className="px-3 pb-3">
            <div className="card-gold flex gap-3">
              <span className="text-gold-bright shrink-0 mt-0.5">
                <LockIcon size={18} />
              </span>
              <span className="text-xs">
                <span className="block font-medium text-gold-bright">
                  {t('chats.protectedTitle')}
                </span>
                <span className="block text-ink-faint mt-0.5">{t('chats.protectedBody')}</span>
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3 border-t border-edge px-4 py-3">
            <PresenceSelector />
          </div>
        </aside>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* An E2EE app has to be honest about not being able to deliver: while the
            socket is down nothing sends or arrives, and a faint word in a corner is
            not enough warning for that. */}
        {wsStatus !== 'connected' && (
          <div
            role="status"
            className="flex items-center justify-center gap-2 border-b border-amber/40 bg-amber/10 px-4 py-1.5 text-xs text-amber"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber" />
            {t('common.connecting')}
          </div>
        )}

        {/* Conversations take the whole window; reading and form pages stay in a
            comfortable measure rather than stretching across an ultrawide display. */}
        <main
          className={
            isConversation(pathname)
              ? 'flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-3 pb-20 md:pb-3'
              : 'w-full flex-1 overflow-y-auto mx-auto max-w-4xl px-4 py-6 pb-24 md:pb-6'
          }
        >
          <Outlet />
        </main>

        {/* Mobile tab bar — the rail's counterpart, with Connect elevated. */}
        {!isDesktop && (
          <nav
            aria-label={t('nav.primary')}
            className="fixed inset-x-0 bottom-0 z-20 flex items-stretch border-t border-edge bg-night px-2 pb-[env(safe-area-inset-bottom)]"
          >
            <Link to="/" className="tab-item" aria-current={isCurrent('/') ? 'page' : undefined}>
              <ChatIcon size={22} />
              {t('nav.chats')}
            </Link>
            <Link
              to="/communities"
              className="tab-item"
              aria-current={isCurrent('/communities') ? 'page' : undefined}
            >
              <CommunityIcon size={22} />
              {t('nav.communities')}
            </Link>
            <Link
              to="/friends/add"
              className="tab-item"
              aria-label={t('nav.connect')}
              aria-current={isCurrent('/friends/add') ? 'page' : undefined}
            >
              <span className="tab-action">
                <ConnectIcon size={24} />
              </span>
              <span aria-hidden>{t('nav.connect')}</span>
            </Link>
            <Link
              to="/catalog"
              className="tab-item"
              aria-current={isCurrent('/catalog') ? 'page' : undefined}
            >
              <CatalogIcon size={22} />
              {t('nav.catalog')}
            </Link>
            <Link
              to="/settings"
              className="tab-item"
              aria-current={isCurrent('/settings') ? 'page' : undefined}
            >
              <SettingsIcon size={22} />
              {t('settings.title')}
            </Link>
          </nav>
        )}
      </div>
    </div>
  )
}
