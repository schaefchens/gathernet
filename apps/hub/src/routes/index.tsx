import type { Block, Friend } from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api.ts'
import { type FriendStatus, usePresence } from '../stores/presence.ts'

export const Route = createFileRoute('/')({ component: FriendsScreen })

const DOT: Record<FriendStatus, string> = {
  online: 'bg-olive',
  away: 'bg-amber',
  offline: 'bg-ink-faint',
}

/** Block durations offered — time-limited by design (no permanent block). */
const BLOCK_DURATIONS = [
  { key: 'day', hours: 24 },
  { key: 'week', hours: 24 * 7 },
  { key: 'month', hours: 24 * 30 },
] as const

function FriendsScreen() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const statuses = usePresence((s) => s.statuses)
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  const friends = useQuery({
    queryKey: ['friends'],
    queryFn: () => api<{ friends: Friend[] }>('GET', '/api/v1/friends'),
  })
  const blocks = useQuery({
    queryKey: ['blocks'],
    queryFn: () => api<{ blocks: Block[] }>('GET', '/api/v1/friends/blocks'),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['friends'] })
    void queryClient.invalidateQueries({ queryKey: ['blocks'] })
  }

  const remove = useMutation({
    mutationFn: (accountId: string) => api('DELETE', `/api/v1/friends/${accountId}`),
    onSuccess: () => {
      setOpenMenu(null)
      invalidate()
    },
  })
  const block = useMutation({
    mutationFn: (v: { accountId: string; durationHours: number }) =>
      api('POST', `/api/v1/friends/${v.accountId}/block`, { durationHours: v.durationHours }),
    onSuccess: () => {
      setOpenMenu(null)
      invalidate()
    },
  })
  const unblock = useMutation({
    mutationFn: (accountId: string) => api('DELETE', `/api/v1/friends/${accountId}/block`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['blocks'] }),
  })

  const sorted = [...(friends.data?.friends ?? [])].sort((a, b) => {
    const rank = (f: Friend) =>
      statuses[f.accountId] === 'offline' || !statuses[f.accountId] ? 1 : 0
    return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName)
  })
  const activeBlocks = blocks.data?.blocks ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-3xl">{t('friends.title')}</h1>
        <Link to="/friends/add" className="btn-gold">
          {t('friends.add')}
        </Link>
      </div>

      {friends.isLoading && <p className="text-ink-soft">{t('common.loading')}</p>}

      {friends.data && sorted.length === 0 && (
        <div className="card text-center text-ink-soft py-12">{t('friends.empty')}</div>
      )}

      <ul className="space-y-2">
        {sorted.map((friend) => {
          const status = statuses[friend.accountId] ?? 'offline'
          const menuOpen = openMenu === friend.accountId
          return (
            <li key={friend.accountId} className="card p-0 overflow-hidden">
              <div className="flex items-center gap-3 py-3 px-3">
                <Link
                  to="/chat/$friendId"
                  params={{ friendId: friend.accountId }}
                  className="flex flex-1 items-center gap-3 min-w-0 hover:text-indigo-soft transition-colors"
                >
                  <span className={`inline-block w-3 h-3 rounded-full ${DOT[status]}`} />
                  <span className="flex-1 font-medium truncate">{friend.displayName}</span>
                  <span className="text-xs text-ink-faint">{t(`friends.presence.${status}`)}</span>
                </Link>
                <button
                  type="button"
                  className="btn-quiet px-2 py-1 text-lg leading-none"
                  aria-label={t('friends.actions')}
                  aria-expanded={menuOpen}
                  onClick={() => setOpenMenu(menuOpen ? null : friend.accountId)}
                >
                  ⋯
                </button>
              </div>

              {menuOpen && (
                <div className="border-t border-edge bg-overlay/40 px-3 py-3 space-y-3 text-sm">
                  <div>
                    <button
                      type="button"
                      className="text-danger font-medium disabled:opacity-40"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(friend.accountId)}
                    >
                      {t('friends.remove')}
                    </button>
                    <p className="text-xs text-ink-faint mt-0.5">
                      {t('friends.removeConfirm', { name: friend.displayName })}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium">{t('friends.block')}</p>
                    <p className="text-xs text-ink-faint mt-0.5 mb-1.5">
                      {t('friends.blockHint', { name: friend.displayName })}
                    </p>
                    <div className="flex gap-2">
                      {BLOCK_DURATIONS.map((d) => (
                        <button
                          key={d.key}
                          type="button"
                          className="btn-quiet text-xs disabled:opacity-40"
                          disabled={block.isPending}
                          onClick={() =>
                            block.mutate({ accountId: friend.accountId, durationHours: d.hours })
                          }
                        >
                          {t(`friends.blockDuration.${d.key}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>

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
