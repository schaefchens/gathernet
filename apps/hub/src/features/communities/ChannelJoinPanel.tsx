import type { CommunityChannel } from '@gathernet/shared'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type ChannelStatus, communityChatStore } from '../../stores/community-chat.ts'

interface ChannelJoinPanelProps {
  communityId: string
  channel: CommunityChannel
  title: string
  emoji?: string | undefined
  /** invalidate the community query so the directory picks up the new status */
  onChanged: () => void
}

/**
 * Right-pane affordance for a channel the caller hasn't joined yet. Renders the
 * correct call-to-action for the channel's join policy and the caller's current
 * status (open join / request-to-join / awaiting approval / invited).
 */
export function ChannelJoinPanel({
  communityId,
  channel,
  title,
  emoji,
  onChanged,
}: ChannelJoinPanelProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [locked, setLocked] = useState(false)

  const act = async () => {
    setBusy(true)
    let status: ChannelStatus
    try {
      status = await communityChatStore.joinChannel(communityId, channel.channelId)
    } finally {
      setBusy(false)
    }
    if (status === 'locked') {
      setLocked(true)
      return
    }
    // 'ready' (open/invite accepted) or 'pending' (request) — refetch either way.
    onChanged()
  }

  return (
    <div className="card grid place-items-center h-[calc(100vh-11rem)] text-center">
      <div className="max-w-sm space-y-4">
        <p className="text-4xl" aria-hidden>
          {locked ? '🔒' : (emoji ?? '💬')}
        </p>
        <h2 className="font-display text-2xl">{title}</h2>

        {locked ? (
          <p className="text-sm text-ink-soft">{t('communities.channelLocked')}</p>
        ) : channel.myStatus === 'pending' ? (
          <div className="space-y-1">
            <p className="font-medium text-amber">{t('communities.waitingApproval')}</p>
            <p className="text-sm text-ink-soft">{t('communities.waitingApprovalHint')}</p>
          </div>
        ) : channel.myStatus === 'invited' ? (
          <>
            <p className="text-sm text-ink-soft">{t('communities.youreInvited')}</p>
            <button type="button" className="btn-gold" disabled={busy} onClick={() => void act()}>
              {t('communities.acceptInvite')}
            </button>
          </>
        ) : channel.joinPolicy === 'request' ? (
          <>
            <p className="text-sm text-ink-soft">{t('communities.requestToJoinHint')}</p>
            <button type="button" className="btn-gold" disabled={busy} onClick={() => void act()}>
              {t('communities.requestToJoin')}
            </button>
          </>
        ) : (
          <button type="button" className="btn-gold" disabled={busy} onClick={() => void act()}>
            {t('communities.join')}
          </button>
        )}
      </div>
    </div>
  )
}
