import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StoredMessage } from '../../lib/storage.ts'
import { MediaAttachment } from './MediaAttachment.tsx'
import { VoiceRecorder } from './VoiceRecorder.tsx'

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
  onPin?: (message: StoredMessage) => void
  /** the current account id — to show which reactions are mine + toggle correctly */
  myAccountId?: string | undefined
  /** shown in the body while `ready` is false */
  notReadyLabel?: string
  /** hide the composer entirely (e.g. announcement channels — read-only) */
  readOnly?: boolean
  /** replaces the composer with this hint when `readOnly` */
  readOnlyLabel?: string
}

/** Quick-reaction palette — prayer-first, a small deliberate set (not a full picker). */
const REACTIONS = ['🙏', '❤️', '👍', '😀', '😢', '🎉']

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

/**
 * The scrollable decrypted-message list plus the send composer, shared by DM
 * chats and community channels. Renders replies + reactions and offers a per-message
 * react/reply affordance; the parent owns the header, the message data, and the
 * send/react handlers.
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
  myAccountId,
  notReadyLabel,
  readOnly,
  readOnlyLabel,
}: MessageThreadProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const [customFor, setCustomFor] = useState<string | null>(null)
  const [editingFor, setEditingFor] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [viewOnce, setViewOnce] = useState(false)
  // Content captured at reveal time so a view-once message can be shown for this
  // one session even though its persisted copy is destroyed immediately on open.
  const [revealed, setRevealed] = useState<Record<string, StoredMessage>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const supportsViewOnce = !!onConsume

  const revealViewOnce = (message: StoredMessage) => {
    if (!message.id) return
    setRevealed((r) => ({ ...r, [message.id as string]: message }))
    onConsume?.(message.id)
  }

  const pickFile = async (file: File | undefined) => {
    if (!file || !onSendMedia) return
    const caption = draft.trim() || undefined
    const once = viewOnce
    setDraft('')
    setViewOnce(false)
    try {
      await onSendMedia(file, caption, replyingTo ?? undefined, once)
      setReplyingTo(null)
    } catch (err) {
      console.error('media send failed', err)
    }
  }

  const sendVoiceNote = async (blob: Blob, durationMs: number) => {
    if (!onSendVoice) return
    const replyTo = replyingTo ?? undefined
    const once = viewOnce
    setReplyingTo(null)
    setViewOnce(false)
    try {
      await onSendVoice(blob, durationMs, replyTo, once)
    } catch (err) {
      console.error('voice send failed', err)
    }
  }

  const applyReactionEmoji = (messageId: string, emoji: string) => {
    const mine = messages
      .find((m) => m.id === messageId)
      ?.reactions?.[emoji]?.includes(myAccountId ?? '')
    onReact?.(messageId, emoji, mine ?? false)
    setPickerFor(null)
    setCustomFor(null)
  }
  const bottomRef = useRef<HTMLDivElement>(null)

  const byId = useMemo(() => {
    const m = new Map<string, StoredMessage>()
    for (const msg of messages) if (msg.id) m.set(msg.id, msg)
    return m
  }, [messages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const send = async () => {
    const text = draft.trim()
    if (!text || !ready || sending) return
    setSending(true)
    setDraft('')
    const replyTo = replyingTo ?? undefined
    const once = viewOnce
    setReplyingTo(null)
    setViewOnce(false)
    try {
      await onSend(text, replyTo, once)
    } catch (err) {
      console.error('send failed', err)
      setDraft(text)
      setViewOnce(once)
    } finally {
      setSending(false)
    }
  }

  const replyPreview = replyingTo ? byId.get(replyingTo) : null

  return (
    <>
      <div className="flex-1 overflow-y-auto py-4 space-y-2">
        {!ready && (
          <p className="text-center text-sm text-amber py-8">
            {notReadyLabel ?? t('chat.settingUp')}
          </p>
        )}
        {ready && messages.length === 0 && (
          <p className="text-center text-sm text-ink-faint py-8">{t('chat.noMessages')}</p>
        )}
        {messages.map((message) => {
          const quoted = message.replyTo ? byId.get(message.replyTo) : null
          const reactions = Object.entries(message.reactions ?? {})
          const spent = !!message.viewOnceOpened
          // A revealed view-once: display the content captured at open time (its
          // persisted copy is already a tombstone).
          const rev = message.id ? revealed[message.id] : undefined
          const shown = rev ?? message
          // Incoming, view-once, not yet opened → gate behind a tap-to-open placeholder.
          const needsReveal = !!message.once && !message.outgoing && !spent && !rev
          const canAct = !!message.id && !!onReact && !message.deletedAt && !spent && !needsReveal
          const canEdit =
            !!message.id && message.outgoing && !message.deletedAt && !message.once && !spent
          return (
            <div
              key={message.seq}
              data-mid={message.id}
              className={`group max-w-[80%] ${message.outgoing ? 'ml-auto' : ''}`}
            >
              <div
                className={`rounded-lg px-3 py-2 text-sm ${
                  message.outgoing
                    ? 'bg-indigo/30 border border-indigo/40'
                    : 'bg-raised border border-edge'
                }`}
              >
                {message.deletedAt ? (
                  <p className="italic text-ink-faint">{t('chat.deleted')}</p>
                ) : spent && !rev ? (
                  // Persisted tombstone with no in-session reveal snapshot → the
                  // content is gone (a reload, another device, or the author's copy
                  // after the recipient opened it).
                  <p className="italic text-ink-faint">
                    👁 {message.outgoing ? t('chat.viewOnceSeen') : t('chat.viewOnceOpened')}
                  </p>
                ) : needsReveal ? (
                  <button
                    type="button"
                    className="flex items-center gap-2 text-sm text-indigo-soft hover:text-ink"
                    onClick={() => revealViewOnce(message)}
                  >
                    👁 {t('chat.viewOnceTap')}
                  </button>
                ) : editingFor === message.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      const text = editDraft.trim()
                      if (text && message.id) onEdit?.(message.id, text)
                      setEditingFor(null)
                    }}
                  >
                    {/* biome-ignore lint/a11y/noAutofocus: focus the edit field on open */}
                    <input
                      autoFocus
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => e.key === 'Escape' && setEditingFor(null)}
                      className="text-sm w-full"
                    />
                  </form>
                ) : (
                  <>
                    {quoted && (
                      <div className="mb-1 border-l-2 border-indigo-soft/60 pl-2 text-xs text-ink-faint truncate">
                        {quoted.once
                          ? `👁 ${t('chat.viewOnce')}`
                          : quoted.text || t('chat.attachment')}
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

              {/* Hover actions: react + reply */}
              {canAct && (
                <div
                  className={`flex gap-2 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity ${
                    message.outgoing ? 'justify-end' : ''
                  }`}
                >
                  <button
                    type="button"
                    className="text-xs text-ink-faint hover:text-ink"
                    onClick={() => {
                      setPickerFor(pickerFor === message.id ? null : (message.id ?? null))
                      setCustomFor(null)
                    }}
                  >
                    {t('chat.react')}
                  </button>
                  <button
                    type="button"
                    className="text-xs text-ink-faint hover:text-ink"
                    onClick={() => setReplyingTo(message.id ?? null)}
                  >
                    {t('chat.reply')}
                  </button>
                  {onPin && !message.once && (
                    <button
                      type="button"
                      className="text-xs text-ink-faint hover:text-ink"
                      onClick={() => onPin(message)}
                    >
                      {t('chat.pin')}
                    </button>
                  )}
                  {canEdit && onEdit && (
                    <button
                      type="button"
                      className="text-xs text-ink-faint hover:text-ink"
                      onClick={() => {
                        setEditingFor(message.id ?? null)
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
                </div>
              )}
              {pickerFor === message.id && (
                <div
                  className={`flex items-center gap-1 mt-1 ${message.outgoing ? 'justify-end' : ''}`}
                >
                  {REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="text-base hover:scale-125 transition-transform"
                      onClick={() => message.id && applyReactionEmoji(message.id, emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                  {customFor === message.id ? (
                    <input
                      // biome-ignore lint/a11y/noAutofocus: focus is required to open the native emoji picker
                      autoFocus
                      className="w-14 text-base px-1 py-0.5"
                      placeholder="🙂"
                      aria-label={t('chat.moreEmoji')}
                      onChange={(e) => {
                        const emoji = firstEmoji(e.target.value)
                        if (emoji && message.id) applyReactionEmoji(message.id, emoji)
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="text-base text-ink-faint hover:text-ink px-1"
                      title={t('chat.moreEmoji')}
                      onClick={() => setCustomFor(message.id ?? null)}
                    >
                      ＋
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {readOnly ? (
        <p className="pt-3 border-t border-edge text-center text-xs text-ink-faint">
          {readOnlyLabel ?? t('chat.readOnly')}
        </p>
      ) : (
        <div className="pt-3 border-t border-edge">
          {replyPreview && (
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
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
          >
            {onSendMedia && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    void pickFile(e.target.files?.[0])
                    e.target.value = '' // allow re-picking the same file
                  }}
                />
                <button
                  type="button"
                  className="btn-quiet px-3"
                  disabled={!ready}
                  title={t('chat.attach')}
                  aria-label={t('chat.attach')}
                  onClick={() => fileInputRef.current?.click()}
                >
                  📎
                </button>
              </>
            )}
            {onSendVoice && (
              <VoiceRecorder disabled={!ready} onRecorded={(b, d) => void sendVoiceNote(b, d)} />
            )}
            {supportsViewOnce && (
              <button
                type="button"
                className={`px-3 ${viewOnce ? 'btn-gold' : 'btn-quiet'}`}
                disabled={!ready}
                aria-pressed={viewOnce}
                title={t('chat.viewOnce')}
                aria-label={t('chat.viewOnce')}
                onClick={() => setViewOnce((v) => !v)}
              >
                👁
              </button>
            )}
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={ready ? t('chat.placeholder') : t('chat.cannotSend')}
              disabled={!ready}
              autoFocus
            />
            <button
              type="submit"
              className="btn-gold"
              disabled={!ready || !draft.trim() || sending}
            >
              {t('chat.send')}
            </button>
          </form>
        </div>
      )}
    </>
  )
}
