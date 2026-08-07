import type { Block, ConnectRequestsResponse, IncomingConnectRequest } from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChatIcon } from '../components/icons.tsx'
import { MenuButton } from '../components/MenuButton.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { ChatList } from '../features/chat/ChatList.tsx'
import { PresenceSelector } from '../features/presence/PresenceSelector.tsx'
import { api } from '../lib/api.ts'
import { openConnectRequest } from '../lib/connect.ts'
import { secureStore } from '../lib/storage.ts'
import { DESKTOP_QUERY, useMediaQuery } from '../lib/use-media-query.ts'
import { useSession } from '../stores/session.ts'

export const Route = createFileRoute('/')({ component: ChatsScreen })

/**
 * The Chats screen: one list holding both the communities you're in and the
 * friends you can message, plus the connect requests and time-limited blocks
 * that belong to managing that list.
 */
function ChatsScreen() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const isDesktop = useMediaQuery(DESKTOP_QUERY)

  const blocks = useQuery({
    queryKey: ['blocks'],
    queryFn: () => api<{ blocks: Block[] }>('GET', '/api/v1/friends/blocks'),
  })
  const requests = useQuery({
    queryKey: ['connect-requests'],
    queryFn: () => api<ConnectRequestsResponse>('GET', '/api/v1/friends/requests'),
  })
  const refreshRequests = () => queryClient.invalidateQueries({ queryKey: ['connect-requests'] })

  const acceptReq = useMutation({
    mutationFn: (requestId: string) =>
      api('POST', `/api/v1/friends/requests/${requestId}/accept`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['friends'] })
      void refreshRequests()
    },
  })
  const declineReq = useMutation({
    mutationFn: (requestId: string) =>
      api('POST', `/api/v1/friends/requests/${requestId}/decline`, {}),
    onSuccess: refreshRequests,
  })
  const cancelReq = useMutation({
    mutationFn: (requestId: string) => api('DELETE', `/api/v1/friends/requests/${requestId}`),
    onSuccess: refreshRequests,
  })

  const unblock = useMutation({
    mutationFn: (accountId: string) => api('DELETE', `/api/v1/friends/${accountId}/block`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['blocks'] }),
  })

  const activeBlocks = blocks.data?.blocks ?? []

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('chats.title')}
        actions={
          <>
            <Link to="/friends/add" className="btn-gold text-sm">
              {t('friends.add')}
            </Link>
            <MenuButton
              items={[
                { label: t('chats.newCommunity'), to: '/communities' },
                { label: t('settings.title'), to: '/settings' },
              ]}
              footer={!isDesktop ? <PresenceSelector /> : undefined}
            />
          </>
        }
      />

      {requests.data?.incoming.length || requests.data?.outgoing.length ? (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-ink-soft">{t('connect.requestsTitle')}</h2>
          <ul className="space-y-2">
            {requests.data?.incoming.map((req) => (
              <ConnectRequestRow
                key={req.requestId}
                req={req}
                busy={acceptReq.isPending || declineReq.isPending}
                onAccept={() => acceptReq.mutate(req.requestId)}
                onDecline={() => declineReq.mutate(req.requestId)}
              />
            ))}
            {requests.data?.outgoing.map((req) => (
              <li
                key={req.requestId}
                className="card flex items-center gap-3 py-2.5 text-sm text-ink-soft"
              >
                <span className="flex-1 min-w-0 truncate">
                  {t('connect.outgoingTo', { name: req.toDisplayName })}
                </span>
                <span className="text-xs text-ink-faint">{t('connect.pending')}</span>
                <button
                  type="button"
                  className="btn-quiet text-xs disabled:opacity-40"
                  disabled={cancelReq.isPending}
                  onClick={() => cancelReq.mutate(req.requestId)}
                >
                  {t('connect.cancel')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* The sidebar owns this list on desktop; rendering it here too would put every
          conversation in the DOM twice. Below `md` there is no sidebar, so it lives here. */}
      {isDesktop ? (
        <div className="card grid min-h-[55vh] place-items-center text-center">
          <div className="space-y-3">
            <span className="seal mx-auto h-14 w-14" aria-hidden>
              <ChatIcon size={26} />
            </span>
            <p className="font-display text-xl text-ink-soft">{t('chats.pickOne')}</p>
            {/* No "Add friend" here — the page header already offers it, and two
                links with the same name is one too many for anyone navigating by name. */}
            <Link to="/communities" className="btn-quiet text-sm">
              {t('chats.browseCommunities')}
            </Link>
          </div>
        </div>
      ) : (
        <ChatList manage />
      )}

      {activeBlocks.length > 0 && (
        <section className="space-y-2 pt-2">
          <h2 className="text-sm font-medium text-ink-soft">{t('friends.takingSpaceTitle')}</h2>
          <ul className="space-y-2">
            {activeBlocks.map((b) => (
              <li
                key={b.accountId}
                className="card flex items-center gap-3 py-2.5 text-sm text-ink-soft"
              >
                <span className="flex-1 min-w-0 truncate">{b.displayName}</span>
                <span className="text-xs text-ink-faint">
                  {t('friends.blockedUntil', {
                    date: new Date(b.expiresAt).toLocaleDateString(),
                  })}
                </span>
                <button
                  type="button"
                  className="btn-quiet text-xs disabled:opacity-40"
                  disabled={unblock.isPending}
                  onClick={() => unblock.mutate(b.accountId)}
                >
                  {t('friends.lift')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** One incoming connect request — decrypts + verifies the intro client-side (the server
 *  never sees it), then offers accept / decline. */
function ConnectRequestRow({
  req,
  busy,
  onAccept,
  onDecline,
}: {
  req: IncomingConnectRequest
  busy: boolean
  onAccept: () => void
  onDecline: () => void
}) {
  const { t } = useTranslation()
  const myAccountId = useSession((s) => s.accountId)
  const [dec, setDec] = useState<{ message: string; verified: boolean } | null | 'pending'>(
    'pending',
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      const record = await secureStore.getDevice()
      if (!record || !myAccountId) {
        if (alive) setDec(null)
        return
      }
      const r = await openConnectRequest(req, myAccountId, record)
      if (alive) setDec(r)
    })()
    return () => {
      alive = false
    }
  }, [req, myAccountId])

  return (
    <li className="card space-y-2 py-3 px-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">{req.fromDisplayName}</span>
        <span className="text-xs text-ink-faint">{t('connect.wantsToConnect')}</span>
        {dec !== 'pending' && dec !== null && !dec.verified && (
          <span className="rounded-full border border-danger/50 px-1.5 py-0.5 text-[11px] text-danger">
            {t('connect.unverified')}
          </span>
        )}
      </div>
      {dec === 'pending' ? (
        <p className="text-xs text-ink-faint">{t('common.loading')}</p>
      ) : dec === null ? (
        <p className="text-xs text-ink-faint">{t('connect.undecryptable')}</p>
      ) : (
        dec.message && <p className="text-ink-soft break-words">“{dec.message}”</p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-gold text-xs px-3 disabled:opacity-40"
          disabled={busy}
          onClick={onAccept}
        >
          {t('connect.accept')}
        </button>
        <button
          type="button"
          className="btn-quiet text-xs px-3 disabled:opacity-40"
          disabled={busy}
          onClick={onDecline}
        >
          {t('connect.decline')}
        </button>
      </div>
    </li>
  )
}
