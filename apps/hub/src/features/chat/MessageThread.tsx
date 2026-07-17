import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StoredMessage } from '../../lib/storage.ts'

interface MessageThreadProps {
  messages: StoredMessage[]
  /** true once encryption is set up and the composer may send */
  ready: boolean
  onSend: (text: string) => Promise<void>
  /** shown in the body while `ready` is false */
  notReadyLabel?: string
}

/**
 * The scrollable decrypted-message list plus the send composer, shared by DM
 * chats and community channels. The parent owns the header and the message
 * data; this component owns only the draft/sending UI state.
 */
export function MessageThread({ messages, ready, onSend, notReadyLabel }: MessageThreadProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const send = async () => {
    const text = draft.trim()
    if (!text || !ready || sending) return
    setSending(true)
    setDraft('')
    try {
      await onSend(text)
    } catch (err) {
      console.error('send failed', err)
      setDraft(text)
    } finally {
      setSending(false)
    }
  }

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
        {messages.map((message) => (
          <div
            key={message.seq}
            className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
              message.outgoing
                ? 'ml-auto bg-indigo/30 border border-indigo/40'
                : 'bg-raised border border-edge'
            }`}
          >
            <p className="whitespace-pre-wrap break-words">{message.text}</p>
            <p className="text-[10px] text-ink-faint text-right mt-1">
              {new Date(message.sentAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        className="flex gap-2 pt-3 border-t border-edge"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={ready ? t('chat.placeholder') : t('chat.cannotSend')}
          disabled={!ready}
          autoFocus
        />
        <button type="submit" className="btn-gold" disabled={!ready || !draft.trim() || sending}>
          {t('chat.send')}
        </button>
      </form>
    </>
  )
}
