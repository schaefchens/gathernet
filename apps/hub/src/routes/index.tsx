import type { Friend } from '@gathernet/shared'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api.ts'
import { type FriendStatus, usePresence } from '../stores/presence.ts'

export const Route = createFileRoute('/')({ component: FriendsScreen })

const DOT: Record<FriendStatus, string> = {
  online: 'bg-olive',
  away: 'bg-amber',
  offline: 'bg-ink-faint',
}

function FriendsScreen() {
  const { t } = useTranslation()
  const statuses = usePresence((s) => s.statuses)
  const friends = useQuery({
    queryKey: ['friends'],
    queryFn: () => api<{ friends: Friend[] }>('GET', '/api/v1/friends'),
  })

  const sorted = [...(friends.data?.friends ?? [])].sort((a, b) => {
    const rank = (f: Friend) =>
      statuses[f.accountId] === 'offline' || !statuses[f.accountId] ? 1 : 0
    return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName)
  })

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
          return (
            <li key={friend.accountId}>
              <Link
                to="/chat/$friendId"
                params={{ friendId: friend.accountId }}
                className="card flex items-center gap-3 py-3 hover:border-indigo-soft transition-colors"
              >
                <span className={`inline-block w-3 h-3 rounded-full ${DOT[status]}`} />
                <span className="flex-1 font-medium">{friend.displayName}</span>
                <span className="text-xs text-ink-faint">{t(`friends.presence.${status}`)}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
