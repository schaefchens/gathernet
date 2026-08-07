import type { CommunityListItem, Friend } from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronIcon, MoreIcon } from '../../components/icons.tsx'
import { api } from '../../lib/api.ts'
import type { CommunityMeta } from '../../lib/community-keys.ts'
import type { StoredMessage } from '../../lib/storage.ts'
import { useChat } from '../../stores/chat.ts'
import { useCommunityChat } from '../../stores/community-chat.ts'
import { usePresence } from '../../stores/presence.ts'
import { channelKey, dmKey, useReadState } from '../../stores/read-state.ts'
import { ChannelList } from '../communities/ChannelList.tsx'
import { CommunityAvatar } from '../communities/CommunityAvatar.tsx'
import { useDecryptedMeta } from '../communities/meta.ts'
import { PersonAvatar } from './PersonAvatar.tsx'

/** Block durations offered — time-limited by design (no permanent block). */
const BLOCK_DURATIONS = [
  { key: 'day', hours: 24 },
  { key: 'week', hours: 24 * 7 },
  { key: 'month', hours: 24 * 30 },
] as const

/**
 * One line of preview for a conversation row. Mirrors what the bubble would show.
 * Takes resolved strings rather than `t` — the typed i18n `t` can't be narrowed to
 * a plain `(key: string) => string`.
 */
function preview(
  m: StoredMessage,
  labels: { deleted: string; viewOnce: string; attachment: string; you: string },
): string {
  const body = m.deletedAt
    ? labels.deleted
    : m.once
      ? labels.viewOnce
      : m.text || (m.media ? labels.attachment : '')
  return m.outgoing ? `${labels.you} ${body}` : body
}

/** Time for today's messages, date for anything older — the usual list convention. */
function whenLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * The one conversation list: the communities you're in and the friends you can
 * message, in a single column. A community row opens the community; a person row
 * opens the 1:1 chat. The desktop sidebar renders it `compact` for navigation and
 * the Chats screen renders it with `manage` for the per-person actions — one
 * component, so the two views can't drift apart.
 */
export function ChatList({ compact, manage }: { compact?: boolean; manage?: boolean }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const statuses = usePresence((s) => s.statuses)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})
  // Previews and unread marks come from what this device has already decrypted —
  // no extra requests, and nothing about read state leaves the device.
  const dmGroups = useChat((s) => s.groups)
  const dmMessages = useChat((s) => s.messages)
  const lastRead = useReadState((s) => s.lastRead)
  const previewLabels = {
    deleted: t('chat.deleted'),
    viewOnce: t('chat.viewOnce'),
    attachment: t('chat.attachment'),
    you: t('chats.youPrefix'),
  }

  const friends = useQuery({
    queryKey: ['friends'],
    queryFn: () => api<{ friends: Friend[] }>('GET', '/api/v1/friends'),
  })
  const communities = useQuery({
    queryKey: ['communities'],
    queryFn: () => api<{ communities: CommunityListItem[] }>('GET', '/api/v1/communities'),
  })

  const invalidate = () => {
    setOpenMenu(null)
    void queryClient.invalidateQueries({ queryKey: ['friends'] })
    void queryClient.invalidateQueries({ queryKey: ['blocks'] })
  }
  const remove = useMutation({
    mutationFn: (accountId: string) => api('DELETE', `/api/v1/friends/${accountId}`),
    onSuccess: invalidate,
  })
  const block = useMutation({
    mutationFn: (v: { accountId: string; durationHours: number }) =>
      api('POST', `/api/v1/friends/${v.accountId}/block`, { durationHours: v.durationHours }),
    onSuccess: invalidate,
  })

  const list = communities.data?.communities ?? []
  const people = [...(friends.data?.friends ?? [])].sort((a, b) => {
    const rank = (f: Friend) =>
      statuses[f.accountId] && statuses[f.accountId] !== 'offline' ? 0 : 1
    return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName)
  })

  if (friends.isLoading || communities.isLoading) {
    return (
      <ul className="space-y-1" aria-busy="true" aria-label={t('common.loading')}>
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex items-center gap-3 px-3 py-2.5">
            <span className="skeleton h-8 w-8 rounded-full" />
            <span className="min-w-0 flex-1 space-y-1.5">
              <span className="skeleton block h-3 w-1/2" />
              <span className="skeleton block h-2.5 w-3/4" />
            </span>
          </li>
        ))}
      </ul>
    )
  }

  if (list.length === 0 && people.length === 0) {
    return (
      <p
        className={
          compact ? 'px-3 py-6 text-sm text-ink-soft' : 'card py-12 text-center text-ink-soft'
        }
      >
        {t('chats.empty')}
      </p>
    )
  }

  return (
    <ul className="space-y-1">
      {list.map((community) => {
        const viewing = pathname.includes(community.communityId)
        // Expanded by default for the community you're looking at; otherwise the
        // user's own choice. Same behaviour on both mobile and desktop.
        const expanded = expandedIds[community.communityId] ?? viewing
        return (
          <li key={community.communityId}>
            <CommunityRow
              community={community}
              active={viewing}
              expanded={expanded}
              onToggle={() =>
                setExpandedIds((prev) => ({ ...prev, [community.communityId]: !expanded }))
              }
            />
            {expanded && (
              <div className="mt-0.5 mb-1 ml-5 border-l border-edge pl-2">
                <ChannelList communityId={community.communityId} />
              </div>
            )}
          </li>
        )
      })}

      {people.map((friend) => {
        const status = statuses[friend.accountId] ?? 'offline'
        const menuOpen = openMenu === friend.accountId
        const group = dmGroups[friend.accountId]
        const last = group ? dmMessages[group.groupId]?.at(-1) : undefined
        const unread =
          !!last && !last.outgoing && last.sentAt > (lastRead[dmKey(friend.accountId)] ?? 0)
        return (
          <li key={friend.accountId} className={menuOpen ? 'rounded-lg bg-selected' : undefined}>
            <div className="flex items-center">
              <Link
                to="/chat/$friendId"
                params={{ friendId: friend.accountId }}
                className="list-row min-w-0 flex-1"
                data-active={pathname === `/chat/${friend.accountId}`}
              >
                <PersonAvatar
                  accountId={friend.accountId}
                  label={friend.displayName}
                  size="sm"
                  status={status}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span
                      className={`min-w-0 flex-1 truncate ${unread ? 'font-semibold text-ink' : 'font-medium'}`}
                    >
                      {friend.displayName}
                    </span>
                    {last && (
                      <span className="shrink-0 text-[10px] text-ink-faint">
                        {whenLabel(last.sentAt)}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    <span
                      className={`min-w-0 flex-1 truncate text-xs ${unread ? 'text-ink-soft' : 'text-ink-faint'}`}
                    >
                      {last ? preview(last, previewLabels) : t(`friends.presence.${status}`)}
                    </span>
                    {/* With a preview occupying the subtitle, presence would otherwise
                        be colour-only. */}
                    {last && <span className="sr-only">{t(`friends.presence.${status}`)}</span>}
                    {unread && (
                      <>
                        <span className="sr-only">{t('chats.unread')}</span>
                        <span
                          className="h-2 w-2 shrink-0 rounded-full bg-gold-bright"
                          aria-hidden
                        />
                      </>
                    )}
                  </span>
                </span>
              </Link>
              {manage && (
                <button
                  type="button"
                  className="mr-1 rounded-md px-1.5 py-1 text-ink-faint hover:text-gold-bright"
                  aria-label={t('friends.actions')}
                  aria-expanded={menuOpen}
                  onClick={() => setOpenMenu(menuOpen ? null : friend.accountId)}
                >
                  <MoreIcon size={18} />
                </button>
              )}
            </div>

            {manage && menuOpen && (
              <div className="space-y-3 rounded-b-lg border-t border-edge px-3 py-3 text-sm">
                <div>
                  <button
                    type="button"
                    className="font-medium text-danger disabled:opacity-40"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(friend.accountId)}
                  >
                    {t('friends.remove')}
                  </button>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {t('friends.removeConfirm', { name: friend.displayName })}
                  </p>
                </div>
                <div>
                  <p className="font-medium">{t('friends.block')}</p>
                  <p className="mt-0.5 mb-1.5 text-xs text-ink-faint">
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
  )
}

function CommunityRow({
  community,
  active,
  expanded,
  onToggle,
}: {
  community: CommunityListItem
  active: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const meta = useDecryptedMeta<CommunityMeta>(community.communityId, community.metaCiphertext)
  const name = meta?.name ?? t('communities.encryptedName')
  // Unread across the community's channels, for the channels this device knows about
  // (learned on first open). A community you've never opened simply shows no mark.
  const channelIds = useReadState((s) => s.communityChannels[community.communityId])
  const lastRead = useReadState((s) => s.lastRead)
  const channelMessages = useCommunityChat((s) => s.messages)
  const unread = (channelIds ?? []).some((id) => {
    const last = channelMessages[id]?.at(-1)
    return !!last && !last.outgoing && last.sentAt > (lastRead[channelKey(id)] ?? 0)
  })

  return (
    <div className="flex items-center">
      {/* Collapse the community's channels without leaving where you are — the row
          itself still opens the community. */}
      <button
        type="button"
        className="shrink-0 rounded px-1 py-1 text-ink-faint hover:text-gold-bright"
        aria-expanded={expanded}
        aria-label={expanded ? t('chats.collapse') : t('chats.expand')}
        onClick={onToggle}
      >
        <ChevronIcon
          size={14}
          className={expanded ? 'rotate-90 transition-transform' : 'transition-transform'}
        />
      </button>
      <Link
        to="/communities/$communityId"
        params={{ communityId: community.communityId }}
        className="list-row min-w-0 flex-1"
        data-active={active}
      >
        <CommunityAvatar
          communityId={community.communityId}
          mediaId={community.avatarMediaId}
          label={name}
          size="sm"
        />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate font-display ${unread ? 'font-semibold text-ink' : 'font-medium'}`}
          >
            {name}
          </span>
          <span className="block truncate text-xs text-ink-faint">
            {t('communities.channelCount', { count: community.channelCount })}
          </span>
        </span>
        {unread && (
          <>
            <span className="sr-only">{t('chats.unread')}</span>
            <span className="h-2 w-2 shrink-0 rounded-full bg-gold-bright" aria-hidden />
          </>
        )}
      </Link>
    </div>
  )
}
