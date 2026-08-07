import { type ReactNode, type RefObject, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AttachIcon, EyeIcon, SendIcon } from '../../components/icons.tsx'
import { VoiceRecorder } from './VoiceRecorder.tsx'

interface ComposerProps {
  /** false while encryption is still being set up — everything is disabled */
  ready: boolean
  placeholder: string
  onSend: (text: string, once: boolean) => Promise<void>
  onSendMedia?:
    | ((file: File, caption: string | undefined, once: boolean) => Promise<void>)
    | undefined
  onSendVoice?: ((blob: Blob, durationMs: number, once: boolean) => Promise<void>) | undefined
  /** offer the view-once toggle (channels/DMs that support consuming) */
  supportsViewOnce?: boolean
  /** "replying to X" strip, rendered above the input row */
  replyStrip?: ReactNode
  /** last failure, surfaced by the parent which knows how to phrase it */
  error?: string | null | undefined
  onError?: ((err: unknown) => void) | undefined
  autoFocus?: boolean
  inputRef?: RefObject<HTMLInputElement | null> | undefined
}

/**
 * The message composer: attachments, voice, view-once, the pill input, and the
 * gold send button.
 *
 * Shared by the main conversation and the thread panel. A thread used to get a
 * cut-down input with no attachments or voice, which was both confusing and
 * arbitrary — a reply is a message. The parent still owns sending, so error
 * phrasing and the reply target stay where the context is.
 */
export function Composer({
  ready,
  placeholder,
  onSend,
  onSendMedia,
  onSendVoice,
  supportsViewOnce,
  replyStrip,
  error,
  onError,
  autoFocus,
  inputRef,
}: ComposerProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [viewOnce, setViewOnce] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const send = async () => {
    const text = draft.trim()
    if (!text || !ready || sending) return
    setSending(true)
    setDraft('')
    const once = viewOnce
    setViewOnce(false)
    try {
      await onSend(text, once)
    } catch (err) {
      // Put the text back so nothing is lost, and let the parent phrase the failure.
      setDraft(text)
      setViewOnce(once)
      onError?.(err)
    } finally {
      setSending(false)
    }
  }

  const pickFile = async (file: File | undefined) => {
    if (!file || !onSendMedia) return
    const caption = draft.trim() || undefined
    const once = viewOnce
    setDraft('')
    setViewOnce(false)
    try {
      await onSendMedia(file, caption, once)
    } catch (err) {
      onError?.(err)
    }
  }

  const sendVoiceNote = async (blob: Blob, durationMs: number) => {
    if (!onSendVoice) return
    const once = viewOnce
    setViewOnce(false)
    try {
      await onSendVoice(blob, durationMs, once)
    } catch (err) {
      onError?.(err)
    }
  }

  return (
    <div className="border-t border-edge pt-3">
      {error && (
        <p className="mb-2 rounded-md border border-danger/50 bg-danger/10 px-2 py-1 text-xs text-danger">
          {error}
        </p>
      )}
      {replyStrip}
      <form
        className="flex items-center gap-2"
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
              className="btn-icon"
              disabled={!ready}
              title={t('chat.attach')}
              aria-label={t('chat.attach')}
              onClick={() => fileInputRef.current?.click()}
            >
              <AttachIcon />
            </button>
          </>
        )}
        {onSendVoice && (
          <VoiceRecorder disabled={!ready} onRecorded={(b, d) => void sendVoiceNote(b, d)} />
        )}
        {supportsViewOnce && (
          <button
            type="button"
            className="btn-icon"
            disabled={!ready}
            aria-pressed={viewOnce}
            title={t('chat.viewOnce')}
            aria-label={t('chat.viewOnce')}
            style={
              viewOnce
                ? { color: '#16110a', backgroundColor: 'var(--color-gold-bright)' }
                : undefined
            }
            onClick={() => setViewOnce((v) => !v)}
          >
            <EyeIcon />
          </button>
        )}
        <input
          ref={inputRef}
          className="composer-field"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={ready ? placeholder : t('chat.cannotSend')}
          disabled={!ready}
          autoFocus={autoFocus}
        />
        <button
          type="submit"
          className="btn-send"
          aria-label={t('chat.send')}
          title={t('chat.send')}
          disabled={!ready || !draft.trim() || sending}
        >
          <SendIcon />
        </button>
      </form>
    </div>
  )
}
