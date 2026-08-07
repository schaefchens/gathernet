import type { CommunityChannel } from '@gathernet/shared'
import { useTranslation } from 'react-i18next'
import { ClampedMarkdown } from './ClampedMarkdown.tsx'

/** Literal i18n keys — the typed t() needs them spelled out. */
const KIND_KEY = {
  small: 'communities.channelKind.small',
  large: 'communities.channelKind.large',
  broadcast: 'communities.channelKind.broadcast',
} as const

const TTL_KEY = 'communities.ttlSummary'

/**
 * What this channel is and who can do what in it, revealed by tapping the header.
 *
 * Kept out of the way by default: on a phone this used to be a permanent block of
 * title, description, and badges above the conversation, which is exactly the
 * space the conversation needs. It matters when you are deciding whether to post
 * something sensitive, and that is a deliberate moment, so it earns a tap.
 */
export function ChannelInfo({
  channel,
  title,
  description,
  communityDescription,
}: {
  channel: CommunityChannel
  title: string
  description?: string | undefined
  communityDescription?: string | undefined
}) {
  const { t } = useTranslation()
  const kind =
    channel.encryptionMode === 'mls'
      ? 'small'
      : channel.postPolicy === 'moderators'
        ? 'broadcast'
        : 'large'

  // Keyed by what each fact is about — two settings can read identically
  // ("All members" is both an access level and a member-list setting).
  const facts: { id: string; name: string; label: string }[] = [
    { id: 'kind', name: t('communities.channelKind.label'), label: t(KIND_KEY[kind]) },
    {
      id: 'access',
      name: t('communities.access.label'),
      label: t(`communities.access.${channel.access}`),
    },
    {
      id: 'join',
      name: t('communities.joinPolicy.label'),
      label: t(`communities.joinPolicy.${channel.joinPolicy}`),
    },
    {
      id: 'post',
      name: t('communities.postPolicy.label'),
      label: t(`communities.postPolicy.${channel.postPolicy}`),
    },
    {
      id: 'roster',
      name: t('communities.memberList.label'),
      label: t(`communities.memberList.${channel.memberListVisibility}`),
    },
    { id: 'ttl', name: '', label: t(TTL_KEY, { count: channel.messageTtlDays }) },
  ]

  return (
    <div className="card shrink-0 space-y-2 p-3">
      <h2 className="font-display text-lg text-ink">{title}</h2>
      {description && (
        <ClampedMarkdown text={description} className="text-xs text-ink-soft [&_p]:mb-1" />
      )}
      {communityDescription && (
        <ClampedMarkdown
          text={communityDescription}
          className="text-xs text-ink-faint [&_p]:mb-1"
        />
      )}
      <ul className="flex flex-wrap gap-1.5">
        {facts.map((fact) => (
          <li
            key={fact.id}
            className="rounded-full border border-edge px-2 py-0.5 text-[11px] text-ink-soft"
          >
            {fact.name && <span className="text-ink-faint">{fact.name}: </span>}
            {fact.label}
          </li>
        ))}
      </ul>
    </div>
  )
}
