import type { AppScope, PublicationCard } from '@gathernet/shared'
import { useTranslation } from 'react-i18next'

/**
 * i18n keys per scope. 'friends:invite' can't be a raw key segment (':' is the
 * i18next namespace separator), so scopes map to explicit literal keys.
 */
export const SCOPE_LINE_KEYS = {
  identity: 'apps.scopes.identity',
  storage: 'apps.scopes.storage',
  rooms: 'apps.scopes.rooms',
  'friends:invite': 'apps.scopes.friendsInvite',
} as const satisfies Record<AppScope, string>

export const SCOPE_CHIP_KEYS = {
  identity: 'apps.chips.identity',
  storage: 'apps.chips.storage',
  rooms: 'apps.chips.rooms',
  'friends:invite': 'apps.chips.friendsInvite',
} as const satisfies Record<AppScope, string>

export function AppIcon({ name, iconUrl }: { name: string; iconUrl: string | null }) {
  if (iconUrl) {
    return <img src={iconUrl} alt="" className="w-12 h-12 rounded-lg object-cover" />
  }
  return (
    <div className="w-12 h-12 rounded-lg bg-overlay grid place-items-center font-display text-2xl text-gold">
      {name.charAt(0).toUpperCase() || '?'}
    </div>
  )
}

interface ConsentCardProps {
  app: PublicationCard
  scopes: AppScope[]
  busy?: boolean
  error?: string | null
  onApprove(): void
  onDeny(): void
}

/** Consent screen shared by the /authorize popup and /apps/connect. */
export function ConsentCard({ app, scopes, busy, error, onApprove, onDeny }: ConsentCardProps) {
  const { t } = useTranslation()

  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-3">
        <AppIcon name={app.name} iconUrl={app.iconUrl} />
        <div>
          <h2 className="font-display text-2xl">{app.name}</h2>
          {app.description && <p className="text-sm text-ink-soft">{app.description}</p>}
        </div>
      </div>
      <p className="text-sm text-ink-soft">{t('apps.requestedAccess', { name: app.name })}</p>
      <ul className="space-y-2">
        {scopes.map((scope) => (
          <li key={scope} className="bg-overlay rounded-md px-3 py-2">
            <p className="text-xs font-medium text-gold">{t(SCOPE_CHIP_KEYS[scope])}</p>
            <p className="text-sm text-ink-soft">{t(SCOPE_LINE_KEYS[scope])}</p>
          </li>
        ))}
      </ul>
      {error && <p className="text-sm text-danger text-center">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className="btn-quiet flex-1" disabled={busy} onClick={onDeny}>
          {t('apps.deny')}
        </button>
        <button type="button" className="btn-gold flex-1" disabled={busy} onClick={onApprove}>
          {busy ? t('common.loading') : t('apps.approve')}
        </button>
      </div>
    </div>
  )
}
