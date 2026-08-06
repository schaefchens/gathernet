import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReportReason } from '../../lib/reports.ts'
import type { StoredMessage } from '../../lib/storage.ts'
import { MediaAttachment } from './MediaAttachment.tsx'
import { PersonAvatar, tintIndex } from './PersonAvatar.tsx'

/** Quick-reaction palette — prayer-first, a small deliberate set (not a full picker). */
const REACTIONS = ['🙏', '❤️', '👍', '😀', '😢', '🎉']

const HOUR_MS = 3_600_000
/** Pin-duration choices; `ms: null` = pinned forever. Labels are literal i18n keys. */
const PIN_DURATIONS = [
  { key: 'pins.durationForever', ms: null },
  { key: 'pins.duration1h', ms: HOUR_MS },
  { key: 'pins.duration1d', ms: 24 * HOUR_MS },
  { key: 'pins.duration1w', ms: 7 * 24 * HOUR_MS },
] as const

const REPORT_REASONS: {
  reason: ReportReason
  key:
    | 'chat.reportReasonSpam'
    | 'chat.reportReasonAbuse'
    | 'chat.reportReasonInappropriate'
    | 'chat.reportReasonSafety'
    | 'chat.reportReasonOther'
}[] = [
  { reason: 'spam', key: 'chat.reportReasonSpam' },
  { reason: 'abuse', key: 'chat.reportReasonAbuse' },
  { reason: 'inappropriate', key: 'chat.reportReasonInappropriate' },
  { reason: 'safety', key: 'chat.reportReasonSafety' },
  { reason: 'other', key: 'chat.reportReasonOther' },
]

/** First grapheme of an input string (so a multi-codepoint emoji stays intact). */
function firstEmoji(s: string): string | null {
  const trimmed = s.trim()
  if (!trimmed) return null
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      trimmed,
    )) {
      return segment
    }
  }
  return [...trimmed][0] ?? null
}

export interface MessageBubbleProps {
  message: StoredMessage
  /** the message this one replies to (resolved) — shows a quote preview */
  quoted?: StoredMessage | null | undefined
  /** show the sender label above the bubble (start of a run, incoming channel) */
  showSender: boolean
  myAccountId?: string | undefined
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
  /** already a friend → hide the connect affordance */
  isFriend?: boolean | undefined
  /** reply affordance — in a flat channel this opens the thread; in a thread it targets
   *  this message. Absent → no reply button. */
  onReply?: ((message: StoredMessage) => void) | undefined
  /** thread-chip: replies beneath this message (flat channel only). 0 → no chip. */
  replyCount?: number | undefined
  /** open this message's thread (the chip; and reply in a flat channel). */
  onOpenThread?: ((message: StoredMessage) => void) | undefined
  /** thread nesting: undefined = flat channel bubble (right-align outgoing); a number =
   *  rendered inside a thread at this indent depth (always left-aligned). */
  threadDepth?: number | undefined
  /** when nesting is capped, the name of the message this one actually replied to. */
  flattenedParentName?: string | undefined
}

/**
 * One decrypted message: the bubble, its reactions, the hover action row, and the inline
 * pickers (react / pin / edit / report / connect / mod-remove). Self-contained interaction
 * state so it can be reused in the flat channel list and in the nested thread view.
 */
export function MessageBubble({
  message,
  quoted,
  showSender,
  myAccountId,
  onReact,
  onEdit,
  onDelete,
  onConsume,
  onPin,
  onReport,
  onModRemove,
  onConnect,
  isFriend,
  onReply,
  replyCount = 0,
  onOpenThread,
  threadDepth,
  flattenedParentName,
}: MessageBubbleProps) {
  const { t } = useTranslation()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [pinning, setPinning] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [reportOpen, setReportOpen] = useState(false)
  const [reportReason, setReportReason] = useState<ReportReason>('inappropriate')
  const [reportNote, setReportNote] = useState('')
  const [reportBusy, setReportBusy] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)
  const [modRemoveConfirm, setModRemoveConfirm] = useState(false)
  const [modRemoveBusy, setModRemoveBusy] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [connectDraft, setConnectDraft] = useState('')
  const [connectBusy, setConnectBusy] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connectSent, setConnectSent] = useState(false)
  const [rev, setRev] = useState<StoredMessage | null>(null)

  const inThread = threadDepth !== undefined
  const spent = !!message.viewOnceOpened
  const shown = rev ?? message
  const needsReveal = !!message.once && !message.outgoing && !spent && !rev
  const canAct = !!message.id && !!onReact && !message.deletedAt && !spent && !needsReveal
  const canEdit = !!message.id && message.outgoing && !message.deletedAt && !message.once && !spent
  const reactions = Object.entries(message.reactions ?? {})

  const applyReactionEmoji = (emoji: string) => {
    if (!message.id) return
    const mine = message.reactions?.[emoji]?.includes(myAccountId ?? '') ?? false
    onReact?.(message.id, emoji, mine)
    setPickerOpen(false)
    setCustomOpen(false)
  }

  const submitReport = async () => {
    if (!onReport) return
    setReportBusy(true)
    setReportError(null)
    try {
      await onReport(message, reportReason, reportNote.trim() || undefined)
      setReportOpen(false)
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err)
      setReportError(code === 'no_moderators' ? t('chat.reportNoMods') : code)
    } finally {
      setReportBusy(false)
    }
  }

  const submitConnect = async () => {
    if (!onConnect) return
    setConnectBusy(true)
    setConnectError(null)
    try {
      await onConnect(message, connectDraft.trim())
      setConnectSent(true)
      setConnectOpen(false)
      setConnectDraft('')
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err)
      const map: Record<string, string> = {
        already_friends: t('connect.errAlready'),
        request_exists: t('connect.errPending'),
        not_connectable: t('connect.errNotConnectable'),
        no_recipients: t('connect.errNoRecipients'),
      }
      setConnectError(map[code] ?? code)
    } finally {
      setConnectBusy(false)
    }
  }

  const alignEnd = !inThread && message.outgoing
  const nested = threadDepth !== undefined && threadDepth > 0
  // Incoming messages sit beside an avatar gutter; the avatar itself only appears on
  // the first message of a run, so a burst from one person reads as one block.
  const showAvatar = !message.outgoing && !nested
  return (
    <div
      data-mid={message.id}
      className={`group flex gap-2 max-w-[85%] ${alignEnd ? 'ml-auto flex-row-reverse' : ''} ${
        nested ? 'border-l border-edge/60 pl-2' : ''
      }`}
      style={nested ? { marginInlineStart: `${threadDepth * 0.75}rem` } : undefined}
    >
      {showAvatar && (
        <span className="w-8 shrink-0 pt-4">
          {showSender && (
            <PersonAvatar
              accountId={message.senderAccountId}
              label={message.senderName || '?'}
              size="sm"
            />
          )}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {flattenedParentName && (
          <p className="mb-0.5 ml-1 text-[11px] text-ink-faint">
            ↳ {t('chat.replyingToName', { name: flattenedParentName })}
          </p>
        )}
        {showSender && (
          <p
            className={`mb-0.5 ml-1 text-[11px] font-display text-sm font-semibold tint-${tintIndex(
              message.senderAccountId,
            )}`}
          >
            {message.senderName}
          </p>
        )}
        <div
          className={`bubble ${
            message.outgoing ? 'bubble-own' : nested ? 'bubble-nested' : 'bubble-in'
          }`}
        >
          {message.deletedAt ? (
            <p className="italic text-ink-faint">
              {t(message.removedByModerator ? 'chat.removedByModerator' : 'chat.deleted')}
            </p>
          ) : spent && !rev ? (
            <p className="italic text-ink-faint">
              👁 {message.outgoing ? t('chat.viewOnceSeen') : t('chat.viewOnceOpened')}
            </p>
          ) : needsReveal ? (
            <button
              type="button"
              className="flex items-center gap-2 text-sm text-indigo-soft hover:text-ink"
              onClick={() => {
                if (!message.id) return
                setRev(message)
                onConsume?.(message.id)
              }}
            >
              👁 {t('chat.viewOnceTap')}
            </button>
          ) : editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const text = editDraft.trim()
                if (text && message.id) onEdit?.(message.id, text)
                setEditing(false)
              }}
            >
              {/* biome-ignore lint/a11y/noAutofocus: focus the edit field on open */}
              <input
                autoFocus
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
                className="text-sm w-full"
              />
            </form>
          ) : (
            <>
              {quoted && (
                <div className="mb-1 border-l-2 border-indigo-soft/60 pl-2 text-xs text-ink-faint truncate">
                  {quoted.once ? `👁 ${t('chat.viewOnce')}` : quoted.text || t('chat.attachment')}
                </div>
              )}
              {shown.media && (
                <div className="mb-1">
                  <MediaAttachment media={shown.media} />
                </div>
              )}
              {shown.text && <p className="whitespace-pre-wrap break-words">{shown.text}</p>}
              {message.once && (
                <p className="text-[10px] text-indigo-soft/80 mt-1">
                  👁 {message.outgoing ? t('chat.viewOnce') : t('chat.viewOnceViewing')}
                </p>
              )}
            </>
          )}
          <p className="text-[10px] text-ink-faint text-right mt-1">
            {message.editedAt && !message.deletedAt && `${t('chat.edited')} · `}
            {new Date(message.sentAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        </div>

        {/* Thread chip — replies beneath this message (flat channel only). */}
        {!inThread && replyCount > 0 && (
          <div className={`mt-0.5 ${alignEnd ? 'text-right' : ''}`}>
            <button
              type="button"
              className="text-xs text-indigo-soft hover:text-ink"
              onClick={() => onOpenThread?.(message)}
            >
              💬 {t('chat.replies', { count: replyCount })}
            </button>
          </div>
        )}

        {/* Reaction pills */}
        {reactions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {reactions.map(([emoji, actors]) => {
              const mine = !!myAccountId && actors.includes(myAccountId)
              return (
                <button
                  key={emoji}
                  type="button"
                  disabled={!canAct}
                  onClick={() => message.id && onReact?.(message.id, emoji, mine)}
                  className={`text-xs rounded-full border px-1.5 py-0.5 ${
                    mine ? 'border-indigo-soft bg-indigo/20' : 'border-edge bg-overlay/40'
                  }`}
                >
                  {emoji} {actors.length}
                </button>
              )
            })}
          </div>
        )}

        {/* Hover actions */}
        {canAct && (
          <div
            className={`flex gap-2 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity ${
              alignEnd ? 'justify-end' : ''
            }`}
          >
            <button
              type="button"
              className="text-xs text-ink-faint hover:text-ink"
              onClick={() => {
                setPickerOpen((v) => !v)
                setCustomOpen(false)
              }}
            >
              {t('chat.react')}
            </button>
            {onReply && (
              <button
                type="button"
                className="text-xs text-ink-faint hover:text-ink"
                onClick={() => onReply(message)}
              >
                {t('chat.reply')}
              </button>
            )}
            {onPin && !message.once && (
              <button
                type="button"
                className="text-xs text-ink-faint hover:text-ink"
                onClick={() => setPinning((v) => !v)}
              >
                {t('chat.pin')}
              </button>
            )}
            {canEdit && onEdit && (
              <button
                type="button"
                className="text-xs text-ink-faint hover:text-ink"
                onClick={() => {
                  setEditing(true)
                  setEditDraft(message.text)
                }}
              >
                {t('chat.edit')}
              </button>
            )}
            {canEdit && onDelete && (
              <button
                type="button"
                className="text-xs text-danger/80 hover:text-danger"
                onClick={() => message.id && onDelete(message.id, message.seq)}
              >
                {t('chat.delete')}
              </button>
            )}
            {onReport && !message.outgoing && (
              <button
                type="button"
                className="text-xs text-ink-faint hover:text-danger"
                onClick={() => {
                  setReportOpen(true)
                  setReportReason('inappropriate')
                  setReportNote('')
                  setReportError(null)
                }}
              >
                {t('chat.report')}
              </button>
            )}
            {onModRemove && !message.outgoing && (
              <button
                type="button"
                className="text-xs text-danger/80 hover:text-danger"
                onClick={() => setModRemoveConfirm(true)}
              >
                {t('chat.modRemove')}
              </button>
            )}
            {onConnect && !message.outgoing && !isFriend && !connectSent && (
              <button
                type="button"
                className="text-xs text-indigo-soft hover:text-ink"
                onClick={() => {
                  setConnectOpen(true)
                  setConnectDraft('')
                  setConnectError(null)
                }}
              >
                {t('connect.connect')}
              </button>
            )}
          </div>
        )}

        {modRemoveConfirm && onModRemove && (
          <div
            className={`mt-1 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1 ${
              alignEnd ? 'justify-end' : ''
            }`}
          >
            <span className="text-[11px] text-ink-soft">{t('chat.modRemoveConfirm')}</span>
            <button
              type="button"
              className="btn-danger text-xs px-2 py-0.5"
              disabled={modRemoveBusy}
              onClick={async () => {
                setModRemoveBusy(true)
                try {
                  await onModRemove(message)
                  setModRemoveConfirm(false)
                } catch (err) {
                  console.error('moderator removal failed', err)
                } finally {
                  setModRemoveBusy(false)
                }
              }}
            >
              {t('chat.modRemove')}
            </button>
            <button
              type="button"
              className="text-xs text-ink-faint hover:text-ink"
              disabled={modRemoveBusy}
              onClick={() => setModRemoveConfirm(false)}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}
        {pickerOpen && (
          <div className={`flex items-center gap-1 mt-1 ${alignEnd ? 'justify-end' : ''}`}>
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="text-base hover:scale-125 transition-transform"
                onClick={() => applyReactionEmoji(emoji)}
              >
                {emoji}
              </button>
            ))}
            {customOpen ? (
              <input
                // biome-ignore lint/a11y/noAutofocus: focus is required to open the native emoji picker
                autoFocus
                className="w-14 text-base px-1 py-0.5"
                placeholder="🙂"
                aria-label={t('chat.moreEmoji')}
                onChange={(e) => {
                  const emoji = firstEmoji(e.target.value)
                  if (emoji) applyReactionEmoji(emoji)
                }}
              />
            ) : (
              <button
                type="button"
                className="text-base text-ink-faint hover:text-ink px-1"
                title={t('chat.moreEmoji')}
                onClick={() => setCustomOpen(true)}
              >
                ＋
              </button>
            )}
          </div>
        )}
        {onPin && pinning && (
          <div className={`flex items-center gap-1 mt-1 ${alignEnd ? 'justify-end' : ''}`}>
            <span className="text-[11px] text-ink-faint">{t('pins.pinFor')}</span>
            {PIN_DURATIONS.map((d) => (
              <button
                key={d.key}
                type="button"
                className="text-xs rounded-full border border-edge bg-overlay/40 px-1.5 py-0.5 hover:border-indigo-soft"
                onClick={() => {
                  onPin(message, d.ms === null ? null : Date.now() + d.ms)
                  setPinning(false)
                }}
              >
                {t(d.key)}
              </button>
            ))}
          </div>
        )}
        {reportOpen && onReport && (
          <div className="mt-1 space-y-2 rounded-md border border-edge bg-overlay/60 p-2">
            <p className="text-[11px] font-medium text-ink-soft">{t('chat.reportReasonTitle')}</p>
            <select
              className="w-full bg-overlay border border-edge rounded-md px-2 py-1 text-sm"
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value as ReportReason)}
            >
              {REPORT_REASONS.map((r) => (
                <option key={r.reason} value={r.reason}>
                  {t(r.key)}
                </option>
              ))}
            </select>
            <input
              value={reportNote}
              onChange={(e) => setReportNote(e.target.value)}
              placeholder={t('chat.reportNote')}
              className="w-full text-sm"
            />
            {reportError && <p className="text-[11px] text-danger">{reportError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-gold text-xs px-3"
                disabled={reportBusy}
                onClick={() => void submitReport()}
              >
                {t('chat.reportSubmit')}
              </button>
              <button
                type="button"
                className="btn-quiet text-xs px-3"
                disabled={reportBusy}
                onClick={() => setReportOpen(false)}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
        {connectOpen && onConnect && (
          <div className="mt-1 space-y-2 rounded-md border border-edge bg-overlay/60 p-2">
            <p className="text-[11px] font-medium text-ink-soft">
              {t('connect.title', { name: message.senderName || t('connect.thisPerson') })}
            </p>
            <textarea
              value={connectDraft}
              onChange={(e) => setConnectDraft(e.target.value)}
              placeholder={t('connect.messagePlaceholder')}
              rows={2}
              className="w-full text-sm"
            />
            {connectError && <p className="text-[11px] text-danger">{connectError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-gold text-xs px-3"
                disabled={connectBusy || !connectDraft.trim()}
                onClick={() => void submitConnect()}
              >
                {t('connect.send')}
              </button>
              <button
                type="button"
                className="btn-quiet text-xs px-3"
                disabled={connectBusy}
                onClick={() => setConnectOpen(false)}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
