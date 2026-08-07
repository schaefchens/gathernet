import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronIcon } from './icons.tsx'

/**
 * The one-line bar at the top of a screen: where you came from, what you are
 * looking at, and what you can do about it.
 *
 * Replaces the app-wide mobile header. A logo and an online-status control on
 * every screen cost a whole band of vertical space and told you nothing you
 * needed on that screen; a title, the primary action, and an overflow menu do.
 */
export function PageHeader({
  backTo,
  avatar,
  title,
  subtitle,
  meta,
  actions,
  onToggle,
  expanded,
}: {
  /** shows a back affordance pointing here */
  backTo?: string
  /** leading avatar or seal */
  avatar?: ReactNode
  title: ReactNode
  /** second line — presence, channel count, whatever identifies the thing */
  subtitle?: ReactNode
  /** right-aligned status, e.g. the encryption note */
  meta?: ReactNode
  /** right-aligned controls, typically buttons and the overflow menu */
  actions?: ReactNode
  /** makes the title area a disclosure for a details panel below the bar */
  onToggle?: (() => void) | undefined
  expanded?: boolean | undefined
}) {
  const { t } = useTranslation()

  // Carries its own inset and spans its container: `main` pads nothing, so the rule
  // under the bar reaches both window edges here exactly as it does on a conversation
  // screen, and every screen's bar is the same height.
  return (
    <div className="flex items-center gap-3 border-b border-edge px-4 pt-3 pb-3">
      {backTo && (
        <Link
          to={backTo}
          className="shrink-0 text-ink-soft hover:text-gold-bright"
          aria-label={t('common.back')}
        >
          ←
        </Link>
      )}
      {avatar}
      <div className="min-w-0 flex-1">
        <h1 className="truncate font-display text-2xl text-gold-bright leading-tight">{title}</h1>
        {subtitle && <div className="truncate text-xs text-ink-faint">{subtitle}</div>}
      </div>
      {/* A distinct control rather than wrapping the title: a button named after the
          thing it is about would be indistinguishable from the item in the sidebar. */}
      {onToggle && (
        <button
          type="button"
          className="shrink-0 rounded px-1 py-1 text-ink-soft hover:text-gold-bright"
          aria-label={t('common.details')}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <ChevronIcon
            size={16}
            className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </button>
      )}
      {meta && <div className="hidden shrink-0 sm:block">{meta}</div>}
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
