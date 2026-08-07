import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * A destructive action that asks first, inline.
 *
 * Replaces `window.confirm`: the native dialog is an unstyled OS box dropped into
 * the middle of the app, it can't be translated, and on a PWA it reads as a
 * browser interruption rather than part of the product. Arming happens in place —
 * the button becomes the question, so nothing jumps and nothing is modal.
 */
export function ConfirmButton({
  label,
  question,
  confirmLabel,
  className = 'btn-quiet text-xs px-2 py-1',
  disabled,
  onConfirm,
}: {
  /** the resting label, e.g. "Revoke" */
  label: ReactNode
  /** what the user is agreeing to, e.g. "Revoke Chrome on Mac?" */
  question: string
  /** the confirming label; defaults to `label` */
  confirmLabel?: ReactNode
  className?: string
  disabled?: boolean
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  const [armed, setArmed] = useState(false)

  if (!armed) {
    return (
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => setArmed(true)}
      >
        {label}
      </button>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1">
      <span className="text-[11px] text-ink-soft">{question}</span>
      <button
        type="button"
        className="btn-danger text-xs px-2 py-0.5"
        disabled={disabled}
        onClick={() => {
          setArmed(false)
          onConfirm()
        }}
      >
        {confirmLabel ?? label}
      </button>
      <button
        type="button"
        className="text-xs text-ink-faint hover:text-ink"
        onClick={() => setArmed(false)}
      >
        {t('common.cancel')}
      </button>
    </span>
  )
}
