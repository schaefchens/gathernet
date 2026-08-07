import { Link } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreIcon } from './icons.tsx'

export interface MenuItem {
  label: string
  /** navigate somewhere */
  to?: string
  /** or run something */
  onSelect?: () => void
  danger?: boolean
}

/**
 * The "…" overflow menu in a screen's top bar. Holds the actions that matter
 * occasionally, so the bar itself can stay one line high — which is the whole
 * point on a phone, where a permanent logo-and-status header was eating the top
 * of every screen.
 */
export function MenuButton({
  items,
  footer,
  label,
}: {
  items: MenuItem[]
  /** rendered under a divider — e.g. the presence control on mobile */
  footer?: ReactNode
  label?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (items.length === 0 && !footer) return null

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        className="rounded-md px-1.5 py-1.5 text-ink-soft hover:text-gold-bright"
        aria-label={label ?? t('nav.more')}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreIcon size={20} />
      </button>

      {open && (
        // Only mounted while open, so its items never collide with the same action
        // offered elsewhere on the screen.
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-lg border border-edge bg-raised py-1 shadow-lg shadow-black/50"
        >
          {items.map((item) =>
            item.to ? (
              <Link
                key={item.label}
                to={item.to}
                role="menuitem"
                className="block px-3 py-2 text-sm text-ink hover:bg-selected hover:text-gold-bright"
                onClick={() => setOpen(false)}
              >
                {item.label}
              </Link>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`block w-full px-3 py-2 text-left text-sm hover:bg-selected ${
                  item.danger ? 'text-danger' : 'text-ink hover:text-gold-bright'
                }`}
                onClick={() => {
                  setOpen(false)
                  item.onSelect?.()
                }}
              >
                {item.label}
              </button>
            ),
          )}
          {footer && <div className="mt-1 border-t border-edge px-3 py-2">{footer}</div>}
        </div>
      )}
    </div>
  )
}
