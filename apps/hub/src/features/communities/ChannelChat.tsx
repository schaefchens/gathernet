import type { ChannelAccess, ChannelPostPolicy } from '@gathernet/shared'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { communityChatStore, useCommunityChat } from '../../stores/community-chat.ts'
import { useSession } from '../../stores/session.ts'
import { MessageThread } from '../chat/MessageThread.tsx'
import { ClampedMarkdown } from './ClampedMarkdown.tsx'
import { CommunityAvatar } from './CommunityAvatar.tsx'

const NO_MESSAGES: never[] = []

interface ChannelChatProps {
  communityId: string
  channelId: string
  title: string
  emoji?: string | undefined
  avatarMediaId: string | null
  access: ChannelAccess
  postPolicy: ChannelPostPolicy
  /** whether the current user may post (mods/leaders in announcement channels) */
  canPost: boolean
  /** the current user is muted here (distinct read-only reason) */
  muted: boolean
  description?: string | undefined
  messageTtlDays: number
}

/**
 * Right-hand channel pane for an ACTIVE channel. On mount (and whenever the
 * channel changes) it opens the channel — restoring local MLS state,
 * external-joining, or surfacing a "leaders only" lock — and prunes locally
 * held messages past the channel's disappearing-messages TTL, then renders the
 * shared message thread once encryption is ready.
 */
export function ChannelChat({
  communityId,
  channelId,
  title,
  emoji,
  avatarMediaId,
  access,
  postPolicy,
  canPost,
  muted,
  description,
  messageTtlDays,
}: ChannelChatProps) {
  const { t } = useTranslation()
  const status = useCommunityChat((s) => s.channels[channelId] ?? 'idle')
  const messages = useCommunityChat((s) => s.messages[channelId] ?? NO_MESSAGES)
  const myAccountId = useSession((s) => s.accountId)

  useEffect(() => {
    void (async () => {
      await communityChatStore.openChannel(channelId)
      // Capability overlay: after the engine has caught up, verify every MLS leaf
      // holds a valid membership cap (a server-injected member → channel untrusted).
      await communityChatStore.verifyChannelTrust(communityId, channelId)
    })()
    void communityChatStore.pruneChannelLocal(channelId, messageTtlDays)
  }, [communityId, channelId, messageTtlDays])

  const notReadyLabel =
    status === 'pending' ? t('communities.channelPending') : t('communities.channelJoining')

  return (
    <div className="flex flex-col h-[calc(100vh-11rem)] card p-4">
      <div className="pb-3 border-b border-edge">
        <div className="flex items-center gap-2">
          {avatarMediaId ? (
            <CommunityAvatar
              communityId={communityId}
              mediaId={avatarMediaId}
              label={emoji ?? title}
              size="md"
            />
          ) : (
            <span
              className="h-8 w-8 shrink-0 grid place-items-center rounded-md bg-overlay"
              aria-hidden
            >
              {emoji ?? (access === 'leaders' ? '🔒' : '#')}
            </span>
          )}
          <h2 className="flex-1 font-medium truncate">{title}</h2>
          {postPolicy === 'moderators' && (
            <span className="text-xs text-ink-faint" title={t('communities.postPolicy.moderators')}>
              📢
            </span>
          )}
          <span className="text-xs text-ink-faint" title={t('chat.encrypted')}>
            🔒 {t(`communities.access.${access}`)}
          </span>
        </div>
        {description && (
          <ClampedMarkdown
            text={description}
            className="mt-1 text-xs text-ink-soft [&_p]:mb-1 [&_a]:break-words"
          />
        )}
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
        <>
          {status === 'untrusted' && (
            <div className="mt-3 rounded-md border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">
              {t('communities.channelUntrusted')}
            </div>
          )}
          {status === 'rotation_pending' && (
            <div className="mt-3 rounded-md border border-gold/50 bg-gold/10 px-3 py-2 text-sm text-gold">
              {t('communities.channelRotationPending')}
            </div>
          )}
          <MessageThread
            messages={messages}
            ready={status === 'ready'}
            onSend={(text, replyTo) => communityChatStore.send(channelId, text, replyTo)}
            onSendMedia={(file, caption, replyTo) =>
              communityChatStore.sendMedia(channelId, file, caption, replyTo)
            }
            onSendVoice={(blob, durationMs, replyTo) =>
              communityChatStore.sendVoice(channelId, blob, durationMs, replyTo)
            }
            onReact={(targetId, emoji, remove) =>
              communityChatStore.react(channelId, targetId, emoji, remove)
            }
            onEdit={(targetId, text) =>
              void communityChatStore.editMessage(channelId, targetId, text)
            }
            onDelete={(targetId, seq) =>
              void communityChatStore.deleteMessage(channelId, targetId, seq)
            }
            myAccountId={myAccountId ?? undefined}
            notReadyLabel={
              status === 'rotation_pending'
                ? t('communities.channelRotationPending')
                : notReadyLabel
            }
            readOnly={!canPost || status === 'untrusted'}
            readOnlyLabel={
              status === 'untrusted'
                ? t('communities.channelUntrustedHint')
                : muted
                  ? t('communities.mutedHint')
                  : t('communities.readOnlyHint')
            }
          />
        </>
      )}
    </div>
  )
}
