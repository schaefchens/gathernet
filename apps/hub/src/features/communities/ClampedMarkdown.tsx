import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Markdown } from '../../lib/markdown.tsx'

/**
 * Renders a markdown description clamped to a few lines with a Show more/less
 * toggle. Overflow is measured once against the collapsed height so the toggle
 * only appears when the content is actually longer than the clamp.
 */
export function ClampedMarkdown({ text, className }: { text: string; className?: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure overflow when `text` changes the rendered height (dependency is the DOM, not a value read here).
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setOverflowing(el.scrollHeight - el.clientHeight > 4)
  }, [text])

  return (
    <div>
      <div ref={ref} className={`${className ?? ''} ${expanded ? '' : 'max-h-20 overflow-hidden'}`}>
        <Markdown text={text} />
      </div>
      {(overflowing || expanded) && (
        <button
          type="button"
          className="mt-0.5 text-xs text-gold hover:underline"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? t('common.showLess') : t('common.showMore')}
        </button>
      )}
    </div>
  )
}
