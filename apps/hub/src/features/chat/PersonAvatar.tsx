import type { FriendStatus } from '../../stores/presence.ts'

const SIZE_CLASS = {
  sm: 'h-8 w-8 text-[10px]',
  md: 'h-11 w-11 text-sm',
  lg: 'h-16 w-16 text-base',
} as const

/** Jewel-tone fields, matched by `tintIndex` to the sender-name tints in app.css. */
const FIELD = [
  'radial-gradient(circle at 35% 25%, #6d2130, #3a0f18)',
  'radial-gradient(circle at 35% 25%, #2f5c2a, #14290f)',
  'radial-gradient(circle at 35% 25%, #3b3080, #1a1240)',
  'radial-gradient(circle at 35% 25%, #6d2a5e, #33122c)',
] as const

const DOT: Record<FriendStatus, string> = {
  online: 'bg-olive',
  away: 'bg-amber',
  offline: 'bg-ink-faint',
}

/** Stable per-account tint so a person keeps the same colour everywhere. */
export function tintIndex(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return h % FIELD.length
}

function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase()
  return (parts[0] ?? '').slice(0, 2).toUpperCase() || '?'
}

/**
 * Monogram avatar for a person. There are no server-hosted profile pictures by
 * design, so identity is carried by a stable jewel tone plus the monogram.
 */
export function PersonAvatar({
  accountId,
  label,
  size = 'md',
  status,
}: {
  accountId: string
  label: string
  size?: keyof typeof SIZE_CLASS
  /** renders a presence dot on the ring when provided */
  status?: FriendStatus | undefined
}) {
  return (
    <span className={`relative shrink-0 ${SIZE_CLASS[size]}`}>
      <span
        className={`${SIZE_CLASS[size]} seal uppercase`}
        style={{ backgroundImage: FIELD[tintIndex(accountId)] }}
        aria-hidden
      >
        {initials(label)}
      </span>
      {/* Decorative: the row spells the status out in text, so the dot must not
          repeat it to a screen reader. */}
      {status && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-night ${DOT[status]}`}
          aria-hidden
        />
      )}
    </span>
  )
}
