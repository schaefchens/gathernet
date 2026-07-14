import { useTranslation } from 'react-i18next'
import { type SelfStatus, usePresence } from '../../stores/presence.ts'

const DOT: Record<SelfStatus, string> = {
  online: 'bg-olive',
  away: 'bg-amber',
  invisible: 'bg-ink-faint',
}

export function PresenceSelector() {
  const { t } = useTranslation()
  const self = usePresence((s) => s.self)
  const setSelf = usePresence((s) => s.setSelf)

  return (
    <label className="flex items-center gap-2 text-sm text-ink-soft">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${DOT[self]}`} />
      <select
        value={self}
        onChange={(e) => void setSelf(e.target.value as SelfStatus)}
        className="bg-transparent border-none p-0 pr-5 text-sm text-ink-soft focus:outline-none w-auto"
      >
        <option value="online">{t('friends.presence.online')}</option>
        <option value="away">{t('friends.presence.away')}</option>
        <option value="invisible">{t('friends.presence.invisible')}</option>
      </select>
    </label>
  )
}
