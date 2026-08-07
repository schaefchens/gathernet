import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReportReason } from '../../lib/reports.ts'
import type { StoredMessage } from '../../lib/storage.ts'
import type { ThreadIndex } from '../../lib/thread-index.ts'
import { Composer } from './Composer.tsx'
import { MessageBubble } from './MessageBubble.tsx'

/** How deep replies visually nest before flattening (with a "↳ replying to X" marker). */
const DEPTH_CAP = 3

interface ThreadRow {
  message: StoredMessage
  /** visual indent depth (0 = root), capped at DEPTH_CAP */
  depth: number
  /** set when this reply's true depth exceeds the cap — the name it actually replied to */
  flattenedParentName?: string
}

/** Pre-order walk of the thread tree rooted at `rootId`, capping visual depth. */
function flattenThread(
  rootId: string,
  index: ThreadIndex,
  byId: Map<string, StoredMessage>,
): ThreadRow[] {
  const rows: ThreadRow[] = []
  const root = byId.get(rootId)
  if (!root) return rows
  rows.push({ message: root, depth: 0 })
  const walk = (parentId: string, trueDepth: number, parentName: string) => {
    for (const child of index.childrenByParent.get(parentId) ?? []) {
      const capped = Math.min(trueDepth, DEPTH_CAP)
      const row: ThreadRow = { message: child, depth: capped }
      if (trueDepth > DEPTH_CAP) row.flattenedParentName = parentName
      rows.push(row)
      if (child.id) {
        walk(child.id, trueDepth + 1, child.senderName || child.senderAccountId.slice(0, 6))
      }
    }
  }
  walk(rootId, 1, root.senderName || root.senderAccountId.slice(0, 6))
  return rows
}

export interface ThreadViewProps {
  rootId: string
  messages: StoredMessage[]
  index: ThreadIndex
  ready: boolean
  onClose: () => void
  onSend: (text: string, replyTo?: string, once?: boolean) => Promise<void>
  /** attachments + voice, so a thread reply is a full message like any other */
  onSendMedia?:
    | ((file: File, caption: string | undefined, replyTo: string, once: boolean) => Promise<void>)
    | undefined
  onSendVoice?:
    | ((blob: Blob, durationMs: number, replyTo: string, once: boolean) => Promise<void>)
    | undefined
  myAccountId?: string | undefined
  friendAccountIds?: string[] | undefined
  onReact?: ((targetId: string, emoji: string, remove: boolean) => void) | undefined
  onEdit?: ((targetId: string, text: string) => void) | undefined
  onDelete?: ((targetId: string, seq: number) => void) | undefined
  onConsume?: ((targetId: string) => void) | undefined
  onPin?: ((message: StoredMessage, expiresAt: number | null) => void) | undefined
  onReport?:
    | ((message: StoredMessage, reason: ReportReason, note?: string) => Promise<void>)
    | undefined
  onModRemove?: ((message: StoredMessage) => Promise<void>) | undefined
  onConnect?: ((message: StoredMessage, intro: string) => Promise<void>) | undefined
}

/**
 * The thread view: a message and its reply subtree, nested up to DEPTH_CAP (deeper replies
 * flatten with a lineage marker). Opens as a right-side drawer on desktop / full-screen on
 * mobile. Replying here targets the specific message tapped, defaulting to the thread root
 * (so the thread stays shallow unless someone deliberately replies to a reply).
 */
export function ThreadView({
  rootId,
  messages,
  index,
  ready,
  onClose,
  onSend,
  onSendMedia,
  onSendVoice,
  myAccountId,
  friendAccountIds,
  onReact,
  onEdit,
  onDelete,
  onConsume,
  onPin,
  onReport,
  onModRemove,
  onConnect,
}: ThreadViewProps) {
  const { t } = useTranslation()
  const friendSet = useMemo(() => new Set(friendAccountIds ?? []), [friendAccountIds])
  const byId = useMemo(() => {
    const m = new Map<string, StoredMessage>()
    for (const msg of messages) if (msg.id) m.set(msg.id, msg)
    return m
  }, [messages])
  const rows = useMemo(() => flattenThread(rootId, index, byId), [rootId, index, byId])

  // Reply target within the thread — defaults to the root.
  const [replyTargetId, setReplyTargetId] = useState(rootId)
  const [sendError, setSendError] = useState<string | null>(null)
  const replyTarget = byId.get(replyTargetId)
  const detachedRoot = index.detached.has(rootId)
  const inputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Focus the reply input on open and whenever the reply target changes, so you can type
  // straight away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on the reply target
  useEffect(() => {
    inputRef.current?.focus()
  }, [replyTargetId])

  // Keep the newest reply in view as the thread grows.
  const lastSeq = rows[rows.length - 1]?.message.seq ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on the newest seq
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lastSeq])

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss */}
      <div className="flex-1 hidden md:block" onClick={onClose} />
      <div className="w-full md:max-w-md bg-raised border-l border-edge h-full flex flex-col shadow-xl">
        <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
          <h2 className="flex-1 font-medium">{t('chat.thread')}</h2>
          <button
            type="button"
            className="text-ink-faint hover:text-ink"
            aria-label={t('common.cancel')}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {detachedRoot && (
            <p className="text-center text-[11px] text-ink-faint italic">
              {t('chat.originalUnavailable')}
            </p>
          )}
          {rows.map((row) => (
            <MessageBubble
              key={row.message.seq}
              message={row.message}
              showSender={!row.message.outgoing && !!row.message.senderName}
              threadDepth={row.depth}
              flattenedParentName={row.flattenedParentName}
              myAccountId={myAccountId}
              isFriend={friendSet.has(row.message.senderAccountId)}
              onReact={onReact}
              onEdit={onEdit}
              onDelete={onDelete}
              onConsume={onConsume}
              onPin={onPin}
              onReport={onReport}
              onModRemove={onModRemove}
              onConnect={onConnect}
              onReply={(m) => setReplyTargetId(m.id ?? rootId)}
            />
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="px-4 pb-3">
          {/* The same composer as the conversation: a reply is a message, so it gets
              attachments and voice too, not a cut-down input. */}
          <Composer
            ready={ready}
            placeholder={t('chat.threadReplyPlaceholder')}
            inputRef={inputRef}
            autoFocus
            error={sendError}
            onError={(err) => {
              console.error('thread reply failed', err)
              setSendError(err instanceof Error ? err.message : String(err))
            }}
            supportsViewOnce={!!onConsume}
            replyStrip={
              replyTarget && replyTargetId !== rootId ? (
                <div className="flex items-center gap-2 mb-2 text-xs text-ink-soft">
                  <span className="flex-1 min-w-0 truncate border-l-2 border-indigo-soft/60 pl-2">
                    {t('chat.replyingTo')}: {replyTarget.text || t('chat.attachment')}
                  </span>
                  <button
                    type="button"
                    className="text-ink-faint hover:text-ink"
                    aria-label={t('common.cancel')}
                    onClick={() => setReplyTargetId(rootId)}
                  >
                    ✕
                  </button>
                </div>
              ) : null
            }
            onSend={async (text, once) => {
              setSendError(null)
              await onSend(text, replyTargetId, once)
              setReplyTargetId(rootId) // back to root after sending
            }}
            onSendMedia={
              onSendMedia
                ? async (file, caption, once) => {
                    setSendError(null)
                    await onSendMedia(file, caption, replyTargetId, once)
                    setReplyTargetId(rootId)
                  }
                : undefined
            }
            onSendVoice={
              onSendVoice
                ? async (blob, durationMs, once) => {
                    setSendError(null)
                    await onSendVoice(blob, durationMs, replyTargetId, once)
                    setReplyTargetId(rootId)
                  }
                : undefined
            }
          />
        </div>
      </div>
    </div>
  )
}
