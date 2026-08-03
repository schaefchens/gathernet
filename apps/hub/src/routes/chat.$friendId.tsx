import type { Friend } from '@gathernet/shared'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { MessageThread } from '../features/chat/MessageThread.tsx'
import { api } from '../lib/api.ts'
import { chatStore, useChat } from '../stores/chat.ts'
import { usePresence } from '../stores/presence.ts'
import { useSession } from '../stores/session.ts'

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
  const myAccountId = useSession((s) => s.accountId)
  const groupId = group?.groupId ?? ''

  const friends = useQuery({
    queryKey: ['friends'],
    queryFn: () => api<{ friends: Friend[] }>('GET', '/api/v1/friends'),
  })
  const friend = friends.data?.friends.find((f) => f.accountId === friendId)

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

      <MessageThread
        messages={messages}
        ready={!!group?.ready}
        onSend={(text, replyTo, once) => chatStore.send(groupId, text, replyTo, once)}
        onSendMedia={(file, caption, replyTo, once) =>
          chatStore.sendMedia(groupId, file, caption, replyTo, once)
        }
        onSendVoice={(blob, durationMs, replyTo, once) =>
          chatStore.sendVoice(groupId, blob, durationMs, replyTo, once)
        }
        onReact={(targetId, emoji, remove) => chatStore.react(groupId, targetId, emoji, remove)}
        onEdit={(targetId, text) => void chatStore.editMessage(groupId, targetId, text)}
        onDelete={(targetId, seq) => void chatStore.deleteMessage(groupId, targetId, seq)}
        onConsume={(targetId) => void chatStore.consumeViewOnce(groupId, targetId)}
        myAccountId={myAccountId ?? undefined}
      />
    </div>
  )
}
