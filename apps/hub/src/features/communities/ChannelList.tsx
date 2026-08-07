import type { CommunityChannel, CommunityDetailResponse } from '@gathernet/shared'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { LockIcon } from '../../components/icons.tsx'
import { api } from '../../lib/api.ts'
import type { ChannelMeta } from '../../lib/community-keys.ts'
import { selectChannel, useChannelSelection } from '../../stores/channel-selection.ts'
import { rememberChannelTitle } from '../../stores/channel-titles.ts'
import { useCommunityChat } from '../../stores/community-chat.ts'
import { channelKey, rememberCommunityChannels, useReadState } from '../../stores/read-state.ts'
import { CommunityAvatar } from './CommunityAvatar.tsx'
import { channelFallbackTitle, useDecryptedMeta } from './meta.ts'

/**
 * The channels of one community. Rendered nested under the open community in the
 * desktop sidebar and, since there is no sidebar below `md`, in the community page
 * itself — never both, so a channel appears exactly once. Reads the same
 * `['community', id]` query the route uses, so it shares the cache rather than
 * fetching again.
 */
export function ChannelList({
  communityId,
  query,
}: {
  communityId: string
  /** when searching, only channels whose title matches are listed */
  query?: string | undefined
}) {
  const { t } = useTranslation()
  const detail = useQuery({
    queryKey: ['community', communityId],
    queryFn: () => api<CommunityDetailResponse>('GET', `/api/v1/communities/${communityId}`),
  })
  const selected = useChannelSelection((s) => s.byCommunity[communityId] ?? null)
  const navigate = useNavigate()

  const channels = [...(detail.data?.channels ?? [])].sort((a, b) => a.position - b.position)

  // Teach the conversation list which channels this community has, so it can show
  // an unread mark on the community without fetching every community's detail.
  const channelIds = channels.map((c) => c.channelId).join(',')
  useEffect(() => {
    if (channelIds) rememberCommunityChannels(communityId, channelIds.split(','))
  }, [communityId, channelIds])

  if (channels.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-ink-faint">{t('communities.noChannels')}</p>
  }

  return (
    <ul className="space-y-0.5">
      {channels.map((channel) => (
        <ChannelRow
          key={channel.channelId}
          communityId={communityId}
          channel={channel}
          query={query}
          active={channel.channelId === selected}
          onSelect={() => {
            selectChannel(communityId, channel.channelId)
            // From the conversation list, picking a channel should land you in that
            // channel's conversation, not just mark it selected somewhere else.
            void navigate({ to: '/communities/$communityId', params: { communityId } })
          }}
        />
      ))}
    </ul>
  )
}

function ChannelRow({
  communityId,
  channel,
  active,
  onSelect,
  query,
}: {
  communityId: string
  channel: CommunityChannel
  active: boolean
  onSelect: () => void
  query?: string | undefined
}) {
  const { t } = useTranslation()
  const meta = useDecryptedMeta<ChannelMeta>(communityId, channel.metaCiphertext)
  const title = meta?.title ?? channelFallbackTitle(channel.channelId)
  const lastRead = useReadState((s) => s.lastRead[channelKey(channel.channelId)] ?? 0)
  const last = useCommunityChat((s) => s.messages[channel.channelId]?.at(-1))
  const unread = !active && !!last && !last.outgoing && last.sentAt > lastRead

  // Publish the title so the conversation list can filter by channel name.
  useEffect(() => {
    rememberChannelTitle(channel.channelId, title)
  }, [channel.channelId, title])

  if (query && !title.toLowerCase().includes(query)) return null

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`w-full flex items-center gap-2 text-left rounded-md px-2 py-1.5 text-sm transition-colors ${
          active
            ? 'bg-selected text-gold-bright'
            : 'text-ink-soft hover:text-ink hover:bg-selected/60'
        }`}
      >
        {channel.avatarMediaId ? (
          <CommunityAvatar
            communityId={communityId}
            mediaId={channel.avatarMediaId}
            label={meta?.emoji ?? title}
            size="sm"
          />
        ) : (
          // The same seal an uploaded avatar gets, at the same size. A bare 24px glyph
          // next to a 40px sealed one left the rows on two different grids, and read as
          // the emoji channels having no mark rather than a different one.
          <span className="seal h-10 w-10 text-lg" aria-hidden>
            {meta?.emoji ?? '#'}
          </span>
        )}
        <span className={`truncate flex-1 ${unread ? 'font-semibold text-ink' : ''}`}>{title}</span>
        {unread && (
          <>
            <span className="sr-only">{t('chats.unread')}</span>
            <span className="h-2 w-2 shrink-0 rounded-full bg-gold-bright" aria-hidden />
          </>
        )}
        {channel.access === 'leaders' && (
          <span className="text-ink-faint" title={t('communities.access.leaders')}>
            <LockIcon size={13} />
          </span>
        )}
        {channel.visibility === 'unlisted' && (
          <span className="text-[10px] text-ink-faint uppercase tracking-wide">
            {t('communities.visibility.unlisted')}
          </span>
        )}
        {channel.myStatus === 'pending' && (
          <span className="text-[10px] uppercase tracking-wide text-amber">
            {t('communities.requested')}
          </span>
        )}
        {channel.myStatus === 'invited' && (
          <span className="text-[10px] uppercase tracking-wide text-gold">
            {t('communities.invited')}
          </span>
        )}
      </button>
    </li>
  )
}
