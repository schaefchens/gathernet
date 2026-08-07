import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReportReason } from '../../lib/reports.ts'
import type { StoredMessage } from '../../lib/storage.ts'
import { buildThreadIndex } from '../../lib/thread-index.ts'
import { WsRequestError } from '../../lib/ws-client.ts'
import { Composer } from './Composer.tsx'
import { MessageBubble } from './MessageBubble.tsx'
import { ThreadView } from './ThreadView.tsx'

/** True when a send failed because this account is no longer a member of the channel — the
 *  important case: the view was stale and the message would otherwise vanish silently. */
function isNotAMemberError(err: unknown): boolean {
  return err instanceof WsRequestError && err.code === 'not_a_member'
}

/** Local calendar day, used to decide where a date divider belongs. */
function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

interface MessageThreadProps {
  messages: StoredMessage[]
  /** true once encryption is set up and the composer may send */
  ready: boolean
  onSend: (text: string, replyTo?: string, once?: boolean) => Promise<void>
  /** send an encrypted attachment (image/file) with an optional caption */
  onSendMedia?: (file: File, caption?: string, replyTo?: string, once?: boolean) => Promise<void>
  /** send an encrypted recorded voice note */
  onSendVoice?: (blob: Blob, durationMs: number, replyTo?: string, once?: boolean) => Promise<void>
  /** toggle a reaction on a message (by its v2 id) */
  onReact?: (targetId: string, emoji: string, remove: boolean) => void
  /** edit one of my own messages (new text) */
  onEdit?: (targetId: string, text: string) => void
  /** delete one of my own messages for everyone (needs the mailbox seq too) */
  onDelete?: (targetId: string, seq: number) => void
  /** recipient opened a view-once message → destroy it locally + tell author/own devices */
  onConsume?: (targetId: string) => void
  /** pin/suggest this message as a channel artifact (channels only) */
  onPin?: (message: StoredMessage, expiresAt: number | null) => void
  /** report a message to the channel's moderators (channels only) */
  onReport?:
    | ((message: StoredMessage, reason: ReportReason, note?: string) => Promise<void>)
    | undefined
  /** moderator removes any member's message directly (channels only) */
  onModRemove?: ((message: StoredMessage) => Promise<void>) | undefined
  /** send a directed connect (friend) request to a message's sender (channels only) */
  onConnect?: ((message: StoredMessage, intro: string) => Promise<void>) | undefined
  /** accountIds already friends with the viewer — connect is hidden for them */
  friendAccountIds?: string[] | undefined
  /** channels only: group replies into threads — the timeline shows top-level messages
   *  with a "N replies" chip; replies live in the thread view. */
  threaded?: boolean | undefined
  /** the current account id — to show which reactions are mine + toggle correctly */
  myAccountId?: string | undefined
  /** shown in the body while `ready` is false */
  notReadyLabel?: string
  /** hide the composer entirely (e.g. announcement channels — read-only) */
  readOnly?: boolean
  /** replaces the composer with this hint when `readOnly` */
  readOnlyLabel?: string
}

/**
 * The scrollable decrypted-message list plus the send composer, shared by DM chats and
 * community channels. In `threaded` mode (channels) replies are grouped into threads: the
 * timeline shows only top-level messages with a reply-count chip that opens the ThreadView;
 * in flat mode (DMs) replies render inline with a quote. The parent owns the header, the
 * message data, and the send/react handlers.
 */
export function MessageThread({
  messages,
  ready,
  onSend,
  onSendMedia,
  onSendVoice,
  onReact,
  onEdit,
  onDelete,
  onConsume,
  onPin,
  onReport,
  onModRemove,
  onConnect,
  friendAccountIds,
  threaded,
  myAccountId,
  notReadyLabel,
  readOnly,
  readOnlyLabel,
}: MessageThreadProps) {
  const { t } = useTranslation()
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  /** last send failure, shown above the composer — a silently dropped message is worse than
   *  an error (a removed member would otherwise type into the void) */
  const [sendError, setSendError] = useState<string | null>(null)
  /** open thread's root message id (threaded channels only) */
  const [openThreadRoot, setOpenThreadRoot] = useState<string | null>(null)
  const composerRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** whether the user is scrolled near the bottom — so new messages autoscroll but we
   *  don't yank them down while they're reading history. */
  const atBottomRef = useRef(true)
  const supportsViewOnce = !!onConsume
  const friendSet = useMemo(() => new Set(friendAccountIds ?? []), [friendAccountIds])

  const byId = useMemo(() => {
    const m = new Map<string, StoredMessage>()
    for (const msg of messages) if (msg.id) m.set(msg.id, msg)
    return m
  }, [messages])

  // Thread index (channels only): powers the timeline filtering, chips, and thread view.
  const threadIndex = useMemo(
    () => (threaded ? buildThreadIndex(messages) : null),
    [threaded, messages],
  )
  // In threaded mode the timeline shows only top-level messages (replies live in threads).
  const timeline = threadIndex ? threadIndex.topLevel : messages

  // Autoscroll to the newest message when the timeline grows — but only if the user is
  // already at the bottom (don't interrupt scrolling back through history). Keyed on the
  // last message's seq so it also fires when messages load in after mount.
  const lastSeq = timeline[timeline.length - 1]?.seq ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on the newest seq
  useEffect(() => {
    if (atBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lastSeq])

  // Focus the composer when a reply is started, so you can type immediately.
  useEffect(() => {
    if (replyingTo) composerRef.current?.focus()
  }, [replyingTo])

  /** Phrase a send failure. A silently dropped message is worse than an error — a
   *  removed member would otherwise type into the void. */
  const reportSendError = (err: unknown) => {
    console.error('send failed', err)
    setSendError(
      isNotAMemberError(err)
        ? t('chat.sendFailedNotMember')
        : err instanceof Error
          ? err.message
          : String(err),
    )
  }

  const replyPreview = replyingTo ? byId.get(replyingTo) : null

  // Reply affordance: in a threaded channel it opens the thread; in a flat DM it sets the
  // inline reply target.
  const openThreadFor = (message: StoredMessage) => {
    const root = (message.id && threadIndex?.rootId.get(message.id)) || message.id
    if (root) setOpenThreadRoot(root)
  }
  const onReply = threaded
    ? openThreadFor
    : (message: StoredMessage) => setReplyingTo(message.id ?? null)

  return (
    <>
      {/* The parchment page. Everything inside it inherits the warm, dark-on-light
          palette from the .parchment scope in app.css. */}
      <div
        ref={listRef}
        className="parchment flex flex-1 flex-col overflow-y-auto rounded-lg px-3 py-4"
        onScroll={() => {
          const el = listRef.current
          if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {/* `mt-auto` sits the conversation on the bottom edge of the page when it is
            shorter than the canvas, the way a chat should read. Done on the inner
            wrapper rather than with justify-end, which breaks scrolling once the
            content overflows. */}
        <div className="mt-auto space-y-2">
          {!ready && (
            <p className="text-center text-sm text-amber py-8">
              {notReadyLabel ?? t('chat.settingUp')}
            </p>
          )}
          {ready && timeline.length === 0 && (
            <p className="text-center text-sm text-ink-faint py-8">{t('chat.noMessages')}</p>
          )}
          {timeline.map((message, i) => {
            const prev = timeline[i - 1]
            const showSender =
              !message.outgoing &&
              !!message.senderName &&
              prev?.senderAccountId !== message.senderAccountId
            const replyCount =
              threadIndex && message.id ? (threadIndex.descendantCount.get(message.id) ?? 0) : 0
            const newDay = !prev || dayKey(prev.sentAt) !== dayKey(message.sentAt)
            return (
              <div key={message.seq} className="space-y-2">
                {newDay && (
                  <p className="rule-orn py-2">
                    {new Date(message.sentAt).toLocaleDateString(undefined, {
                      day: 'numeric',
                      month: 'long',
                    })}
                  </p>
                )}
                <MessageBubble
                  message={message}
                  quoted={!threaded && message.replyTo ? byId.get(message.replyTo) : null}
                  showSender={showSender}
                  myAccountId={myAccountId}
                  onReact={onReact}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onConsume={onConsume}
                  onPin={onPin}
                  onReport={onReport}
                  onModRemove={onModRemove}
                  onConnect={onConnect}
                  isFriend={friendSet.has(message.senderAccountId)}
                  onReply={onReply}
                  replyCount={replyCount}
                  onOpenThread={threaded ? openThreadFor : undefined}
                />
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>
      </div>

      {readOnly ? (
        <p className="pt-3 border-t border-edge text-center text-xs text-ink-faint">
          {readOnlyLabel ?? t('chat.readOnly')}
        </p>
      ) : (
        <Composer
          ready={ready}
          placeholder={t('chat.placeholder')}
          inputRef={composerRef}
          autoFocus
          error={sendError}
          onError={reportSendError}
          supportsViewOnce={supportsViewOnce}
          replyStrip={
            replyPreview ? (
              <div className="flex items-center gap-2 mb-2 text-xs text-ink-soft">
                <span className="flex-1 min-w-0 truncate border-l-2 border-indigo-soft/60 pl-2">
                  {t('chat.replyingTo')}: {replyPreview.text || t('chat.attachment')}
                </span>
                <button
                  type="button"
                  className="text-ink-faint hover:text-ink"
                  onClick={() => setReplyingTo(null)}
                  aria-label={t('common.cancel')}
                >
                  ✕
                </button>
              </div>
            ) : null
          }
          onSend={async (text, once) => {
            setSendError(null)
            const replyTo = replyingTo ?? undefined
            await onSend(text, replyTo, once)
            setReplyingTo(null)
          }}
          onSendMedia={
            onSendMedia
              ? async (file, caption, once) => {
                  setSendError(null)
                  await onSendMedia(file, caption, replyingTo ?? undefined, once)
                  setReplyingTo(null)
                }
              : undefined
          }
          onSendVoice={
            onSendVoice
              ? async (blob, durationMs, once) => {
                  setSendError(null)
                  await onSendVoice(blob, durationMs, replyingTo ?? undefined, once)
                  setReplyingTo(null)
                }
              : undefined
          }
        />
      )}

      {threaded && threadIndex && openThreadRoot && (
        <ThreadView
          rootId={openThreadRoot}
          messages={messages}
          index={threadIndex}
          ready={ready}
          onClose={() => setOpenThreadRoot(null)}
          onSend={onSend}
          onSendMedia={
            onSendMedia
              ? (file, caption, replyTo, once) => onSendMedia(file, caption, replyTo, once)
              : undefined
          }
          onSendVoice={
            onSendVoice
              ? (blob, durationMs, replyTo, once) => onSendVoice(blob, durationMs, replyTo, once)
              : undefined
          }
          myAccountId={myAccountId}
          friendAccountIds={friendAccountIds}
          onReact={onReact}
          onEdit={onEdit}
          onDelete={onDelete}
          onConsume={onConsume}
          onPin={onPin}
          onReport={onReport}
          onModRemove={onModRemove}
          onConnect={onConnect}
        />
      )}
    </>
  )
}
