import type { ChannelAccess } from '@gathernet/shared'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { communityChatStore, useCommunityChat } from '../../stores/community-chat.ts'
import { MessageThread } from '../chat/MessageThread.tsx'

const NO_MESSAGES: never[] = []

interface ChannelChatProps {
  channelId: string
  channelName: string
  access: ChannelAccess
}

/**
 * Right-hand channel pane. On mount (and whenever the channel changes) it asks
 * the community store to open the channel — restoring local MLS state,
 * external-joining, or surfacing a "leaders only" lock — then renders the
 * shared message thread once encryption is ready.
 */
export function ChannelChat({ channelId, channelName, access }: ChannelChatProps) {
  const { t } = useTranslation()
  const status = useCommunityChat((s) => s.channels[channelId] ?? 'idle')
  const messages = useCommunityChat((s) => s.messages[channelId] ?? NO_MESSAGES)

  useEffect(() => {
    void communityChatStore.openChannel(channelId)
  }, [channelId])

  const notReadyLabel =
    status === 'pending' ? t('communities.channelPending') : t('communities.channelJoining')

  return (
    <div className="flex flex-col h-[calc(100vh-11rem)] card p-4">
      <div className="flex items-center gap-2 pb-3 border-b border-edge">
        {access === 'leaders' && <span aria-hidden>🔒</span>}
        <h2 className="flex-1 font-medium truncate"># {channelName}</h2>
        <span className="text-xs text-ink-faint" title={t('chat.encrypted')}>
          🔒 {t(`communities.access.${access}`)}
        </span>
      </div>

      {status === 'locked' ? (
        <div className="flex-1 grid place-items-center text-center">
          <div className="space-y-2">
            <p className="text-4xl" aria-hidden>
              🔒
            </p>
            <p className="text-sm text-ink-soft">{t('communities.channelLocked')}</p>
          </div>
        </div>
      ) : (
        <MessageThread
          messages={messages}
          ready={status === 'ready'}
          onSend={(text) => communityChatStore.send(channelId, text)}
          notReadyLabel={notReadyLabel}
        />
      )}
    </div>
  )
}
