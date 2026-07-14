import type { Friend } from '@gathernet/shared'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api.ts'
import { chatStore, useChat } from '../stores/chat.ts'
import { usePresence } from '../stores/presence.ts'

export const Route = createFileRoute('/chat/$friendId')({ component: ChatScreen })

const NO_MESSAGES: never[] = []

function ChatScreen() {
  const { friendId } = Route.useParams()
  const { t } = useTranslation()
  const group = useChat((s) => s.groups[friendId])
  const messages = useChat((s) =>
    group ? (s.messages[group.groupId] ?? NO_MESSAGES) : NO_MESSAGES,
  )
  const status = usePresence((s) => s.statuses[friendId] ?? 'offline')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const friends = useQuery({
    queryKey: ['friends'],
    queryFn: () => api<{ friends: Friend[] }>('GET', '/api/v1/friends'),
  })
  const friend = friends.data?.friends.find((f) => f.accountId === friendId)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const send = async () => {
    const text = draft.trim()
    if (!text || !group?.ready || sending) return
    setSending(true)
    setDraft('')
    try {
      await chatStore.send(group.groupId, text)
    } catch (err) {
      console.error('send failed', err)
      setDraft(text)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8.5rem)]">
      <div className="flex items-center gap-3 pb-3 border-b border-edge">
        <Link to="/" className="text-ink-soft hover:text-ink" aria-label={t('common.back')}>
          ←
        </Link>
        <div className="flex-1">
          <h1 className="font-medium">{friend?.displayName ?? '…'}</h1>
          <p className="text-xs text-ink-faint">{t(`friends.presence.${status}`)}</p>
        </div>
        <p className="text-xs text-ink-faint" title={t('chat.encrypted')}>
          🔒 {t('chat.encrypted')}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto py-4 space-y-2">
        {!group?.ready && (
          <p className="text-center text-sm text-amber py-8">{t('chat.settingUp')}</p>
        )}
        {group?.ready && messages.length === 0 && (
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
          placeholder={group?.ready ? t('chat.placeholder') : t('chat.cannotSend')}
          disabled={!group?.ready}
          autoFocus
        />
        <button
          type="submit"
          className="btn-gold"
          disabled={!group?.ready || !draft.trim() || sending}
        >
          {t('chat.send')}
        </button>
      </form>
    </div>
  )
}
