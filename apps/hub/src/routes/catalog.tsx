import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { CatalogIcon } from '../components/icons.tsx'
import { PageHeader } from '../components/PageHeader.tsx'

export const Route = createFileRoute('/catalog')({ component: CatalogScreen })

/**
 * The launcher surface for apps, games, books and videos.
 *
 * A placeholder for now: the navigation slot exists so the shape of the product is
 * visible, but nothing here is built yet and the screen says so rather than
 * implying an empty catalogue.
 */
function CatalogScreen() {
  const { t } = useTranslation()

  return (
    <div className="space-y-4">
      <PageHeader backTo="/" title={t('catalog.title')} />
      <div className="card grid min-h-[50vh] place-items-center text-center">
        <div className="max-w-sm space-y-3">
          <span className="seal mx-auto h-14 w-14" aria-hidden>
            <CatalogIcon size={26} />
          </span>
          <p className="font-display text-xl text-ink-soft">{t('catalog.soon')}</p>
          <p className="text-sm text-ink-faint">{t('catalog.soonBody')}</p>
        </div>
      </div>
    </div>
  )
}
