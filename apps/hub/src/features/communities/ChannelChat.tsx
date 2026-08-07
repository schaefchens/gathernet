import type { ChannelPinPolicy, Friend } from '@gathernet/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, api } from '../../lib/api.ts'
import { copyMedia } from '../../lib/media.ts'
import { WsRequestError } from '../../lib/ws-client.ts'
import { channelArtifactsStore } from '../../stores/channel-artifacts.ts'
import { communityChatStore, useCommunityChat } from '../../stores/community-chat.ts'
import { channelKey, markRead } from '../../stores/read-state.ts'
import { useSession } from '../../stores/session.ts'
import { MessageThread } from '../chat/MessageThread.tsx'
import { PinnedBar } from './PinnedBar.tsx'

const NO_MESSAGES: never[] = []

interface ChannelChatProps {
  communityId: string
  channelId: string
  pinPolicy: ChannelPinPolicy
  /** whether the current user may post (mods/leaders in announcement channels) */
  canPost: boolean
  /** whether the current user manages this channel (moderator/leader) — drives the
   *  suggestion-approval affordance; authority is still verified client-side */
  isManager: boolean
  /** the current user is muted here (distinct read-only reason) */
  muted: boolean
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
  pinPolicy,
  canPost,
  isManager,
  muted,
  messageTtlDays,
}: ChannelChatProps) {
  const { t } = useTranslation()
  const status = useCommunityChat((s) => s.channels[channelId] ?? 'idle')
  const messages = useCommunityChat((s) => s.messages[channelId] ?? NO_MESSAGES)
  const myAccountId = useSession((s) => s.accountId)
  const queryClient = useQueryClient()
  const threadRef = useRef<HTMLDivElement>(null)
  const [pinError, setPinError] = useState<string | null>(null)
  // Friends list — so the per-message "Connect" affordance is hidden for existing friends.
  const friends = useQuery({
    queryKey: ['friends'],
    queryFn: () => api<{ friends: Friend[] }>('GET', '/api/v1/friends'),
  })
  const friendAccountIds = friends.data?.friends.map((f) => f.accountId)

  // An open channel is a read channel: clear its unread mark as messages arrive.
  const newestSentAt = messages[messages.length - 1]?.sentAt ?? 0
  useEffect(() => {
    if (newestSentAt) markRead(channelKey(channelId), newestSentAt)
  }, [channelId, newestSentAt])

  /**
   * A send refused with `not_a_member` means this account was removed while the view was
   * stale (e.g. a roll-call sweep). Refetch so the UI stops showing a composer it can't use,
   * and drop the channel's local MLS state — rejoining needs a fresh external join anyway.
   * The error is re-thrown so the composer can tell the user what happened.
   */
  const withMembershipCheck = async <T,>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (err) {
      if (err instanceof WsRequestError && err.code === 'not_a_member') {
        void communityChatStore.forgetChannel(channelId)
        void queryClient.invalidateQueries({ queryKey: ['community', communityId] })
      }
      throw err
    }
  }

  /** Build a pin snapshot from a channel message and post it (a suggestion under
   *  moderators policy; the pinned bar reflects its status once it round-trips). A
   *  message's attachment is copied to a pin-owned blob so the pin survives the
   *  original message's deletion/TTL. */
  const pinMessage = (message: (typeof messages)[number], expiresAt: number | null) => {
    setPinError(null)
    void (async () => {
      const media = message.media ? await copyMedia(message.media).catch(() => message.media) : null
      await channelArtifactsStore.pin(
        communityId,
        channelId,
        {
          v: 1,
          kind: 'pin',
          ...(message.text ? { text: message.text } : {}),
          ...(media ? { media } : {}),
          ...(message.id ? { originalMessageId: message.id } : {}),
        },
        expiresAt,
      )
      await channelArtifactsStore.load(communityId, channelId, pinPolicy)
    })().catch((err: unknown) => {
      console.error('pin failed', err)
      setPinError(err instanceof ApiError ? err.message : String(err))
    })
  }

  /** Best-effort scroll to a pinned message's source (if it's still in view). */
  const jumpTo = (messageId: string) => {
    const el = threadRef.current?.querySelector(`[data-mid="${CSS.escape(messageId)}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

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
    <div className="flex min-h-0 flex-1 flex-col">
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
          {pinError && (
            <div className="mt-3 rounded-md border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger">
              {t('pins.pinFailed')}: {pinError}
            </div>
          )}
          <div ref={threadRef} className="flex flex-1 flex-col min-h-0">
            <MessageThread
              messages={messages}
              ready={status === 'ready'}
              onSend={(text, replyTo, once) =>
                withMembershipCheck(() => communityChatStore.send(channelId, text, replyTo, once))
              }
              onSendMedia={(file, caption, replyTo, once) =>
                communityChatStore.sendMedia(channelId, file, caption, replyTo, once)
              }
              onSendVoice={(blob, durationMs, replyTo, once) =>
                communityChatStore.sendVoice(channelId, blob, durationMs, replyTo, once)
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
              onConsume={(targetId) => void communityChatStore.consumeViewOnce(channelId, targetId)}
              onPin={pinMessage}
              onReport={(message, reason, note) =>
                communityChatStore.reportMessage(communityId, channelId, message, reason, note)
              }
              onModRemove={
                isManager
                  ? (message) =>
                      communityChatStore.removeMessageAsModerator(
                        communityId,
                        channelId,
                        message.seq,
                      )
                  : undefined
              }
              onConnect={(message, intro) =>
                communityChatStore.sendConnectRequest(message.senderAccountId, intro)
              }
              friendAccountIds={friendAccountIds}
              threaded
              myAccountId={myAccountId ?? undefined}
              notReadyLabel={
                status === 'rotation_pending'
                  ? t('communities.channelRotationPending')
                  : notReadyLabel
              }
              topSlot={
                <PinnedBar
                  communityId={communityId}
                  channelId={channelId}
                  pinPolicy={pinPolicy}
                  isManager={isManager}
                  canCreate={status !== 'untrusted'}
                  myAccountId={myAccountId ?? null}
                  onJump={jumpTo}
                />
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
          </div>
        </>
      )}
    </div>
  )
}
