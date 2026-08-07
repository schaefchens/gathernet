import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldIcon } from '../../components/icons.tsx'
import { ApiError } from '../../lib/api.ts'
import { loadCrypto } from '../../lib/mls.ts'
import { useSession } from '../../stores/session.ts'

type Step =
  | { kind: 'choice' }
  | { kind: 'create-name' }
  | { kind: 'create-phrase'; displayName: string; phrase: string }
  | { kind: 'create-confirm'; displayName: string; phrase: string; wordIndex: number }
  | { kind: 'create-password'; displayName: string; phrase: string }
  | { kind: 'restore-phrase' }
  | { kind: 'restore-password'; phrase: string }
  | { kind: 'busy'; message: string }
  | { kind: 'error'; message: string; retry: Step }

function defaultDeviceName(): string {
  const ua = navigator.userAgent
  const browser = ua.includes('Firefox') ? 'Firefox' : ua.includes('Chrome') ? 'Chrome' : 'Browser'
  const platform = ua.includes('Mac') ? 'Mac' : ua.includes('Windows') ? 'Windows' : 'Device'
  return `${browser} on ${platform}`
}

export function WelcomeFlow() {
  const [step, setStep] = useState<Step>({ kind: 'choice' })
  const { t } = useTranslation()
  const createAccount = useSession((s) => s.createAccount)
  const restore = useSession((s) => s.restore)

  const runCreate = async (
    displayName: string,
    phrase: string,
    password: string,
    deviceName: string,
  ) => {
    setStep({ kind: 'busy', message: t('create.creating') })
    try {
      await createAccount({ displayName, deviceName, password, phrase })
    } catch (err) {
      setStep({
        kind: 'error',
        message: err instanceof ApiError ? err.code : t('common.error'),
        retry: { kind: 'create-password', displayName, phrase },
      })
    }
  }

  const runRestore = async (phrase: string, password: string, deviceName: string) => {
    setStep({ kind: 'busy', message: t('restore.restoring') })
    try {
      await restore({ phrase, deviceName, password })
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 404 ? t('restore.notFound') : t('common.error')
      setStep({ kind: 'error', message, retry: { kind: 'restore-phrase' } })
    }
  }

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-md">
        {step.kind === 'choice' && (
          <div className="text-center space-y-6">
            <h1 className="font-display text-5xl text-gold">{t('welcome.title')}</h1>
            <p className="text-ink-soft">{t('welcome.tagline')}</p>
            <div className="space-y-3">
              <button
                type="button"
                className="btn-gold w-full"
                onClick={async () => {
                  const crypto = await loadCrypto()
                  setStep({ kind: 'create-name' })
                  void crypto // preloaded for the next steps
                }}
              >
                {t('welcome.create')}
              </button>
              <button
                type="button"
                className="btn-quiet w-full"
                onClick={() => setStep({ kind: 'restore-phrase' })}
              >
                {t('welcome.restore')}
              </button>
            </div>
            <p className="text-xs text-ink-faint">{t('welcome.privacyNote')}</p>
          </div>
        )}

        {step.kind === 'create-name' && (
          <NameStep
            onBack={() => setStep({ kind: 'choice' })}
            onNext={async (displayName) => {
              const crypto = await loadCrypto()
              setStep({ kind: 'create-phrase', displayName, phrase: crypto.generateMnemonic() })
            }}
          />
        )}

        {step.kind === 'create-phrase' && (
          <PhraseStep
            phrase={step.phrase}
            onBack={() => setStep({ kind: 'create-name' })}
            onNext={() =>
              setStep({
                kind: 'create-confirm',
                displayName: step.displayName,
                phrase: step.phrase,
                wordIndex: Math.floor(Math.random() * 12),
              })
            }
          />
        )}

        {step.kind === 'create-confirm' && (
          <ConfirmStep
            phrase={step.phrase}
            wordIndex={step.wordIndex}
            onBack={() =>
              setStep({ kind: 'create-phrase', displayName: step.displayName, phrase: step.phrase })
            }
            onNext={() =>
              setStep({
                kind: 'create-password',
                displayName: step.displayName,
                phrase: step.phrase,
              })
            }
          />
        )}

        {step.kind === 'create-password' && (
          <PasswordStep
            title={t('create.unlockTitle')}
            onBack={() =>
              setStep({ kind: 'create-phrase', displayName: step.displayName, phrase: step.phrase })
            }
            onNext={(password, deviceName) =>
              void runCreate(step.displayName, step.phrase, password, deviceName)
            }
          />
        )}

        {step.kind === 'restore-phrase' && (
          <RestorePhraseStep
            onBack={() => setStep({ kind: 'choice' })}
            onNext={(phrase) => setStep({ kind: 'restore-password', phrase })}
          />
        )}

        {step.kind === 'restore-password' && (
          <PasswordStep
            title={t('create.unlockTitle')}
            onBack={() => setStep({ kind: 'restore-phrase' })}
            onNext={(password, deviceName) => void runRestore(step.phrase, password, deviceName)}
          />
        )}

        {step.kind === 'busy' && (
          <div className="text-center text-ink-soft animate-pulse py-16">{step.message}</div>
        )}

        {step.kind === 'error' && (
          <div className="card text-center space-y-4">
            <p className="text-danger">{step.message}</p>
            <button type="button" className="btn-quiet" onClick={() => setStep(step.retry)}>
              {t('common.retry')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function NameStep(props: { onBack(): void; onNext(name: string): void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  return (
    <form
      className="card space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) props.onNext(name.trim())
      }}
    >
      <h2 className="font-display text-2xl">{t('create.nameTitle')}</h2>
      <p className="text-sm text-ink-soft">{t('create.nameHint')}</p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('create.namePlaceholder')}
        maxLength={64}
        autoFocus
      />
      <StepButtons onBack={props.onBack} nextDisabled={!name.trim()} />
    </form>
  )
}

/**
 * The highest-stakes screen in the product: these twelve words ARE the account,
 * and nobody — including us — can reset them.
 *
 * Two deliberate choices. The words start blurred behind a reveal, because the
 * screen may be shared, projected, or overlooked and the phrase should not be
 * exposed the instant the step opens. And there is NO copy button: putting a
 * recovery phrase on the system clipboard hands it to every clipboard manager,
 * sync service, and app that reads it. Paper is the recommended medium, so the
 * screen says so instead of offering a convenient way to do the wrong thing.
 */
function PhraseStep(props: { phrase: string; onBack(): void; onNext(): void }) {
  const { t } = useTranslation()
  const words = useMemo(() => props.phrase.split(' '), [props.phrase])
  const [revealed, setRevealed] = useState(false)

  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-3">
        <span className="seal h-11 w-11" aria-hidden>
          <ShieldIcon size={22} />
        </span>
        <h2 className="font-display text-2xl text-gold-bright">{t('create.phraseTitle')}</h2>
      </div>

      <p className="banner-alert text-xs leading-relaxed">{t('create.phraseWarning')}</p>

      <div className="relative">
        <ol
          className={`grid grid-cols-3 gap-2 select-none transition-[filter] ${
            revealed ? '' : 'blur-sm'
          }`}
          aria-label="recovery phrase"
        >
          {words.map((word, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static per-render word list
            <li key={`${i}-${word}`} className="phrase-word">
              <span className="text-ink-faint mr-1">{i + 1}.</span>
              {word}
            </li>
          ))}
        </ol>
        {!revealed && (
          <button
            type="button"
            className="absolute inset-0 grid place-items-center rounded-md bg-overlay/70"
            onClick={() => setRevealed(true)}
          >
            <span className="space-y-1 text-center">
              <span className="block font-medium text-gold-bright">{t('create.phraseReveal')}</span>
              <span className="block text-xs text-ink-soft">{t('create.phraseRevealHint')}</span>
            </span>
          </button>
        )}
      </div>

      <p className="text-xs text-ink-faint leading-relaxed">{t('create.phraseNoCopy')}</p>

      <StepButtons
        onBack={props.onBack}
        nextLabel={t('create.phraseWritten')}
        onNext={props.onNext}
      />
    </div>
  )
}

function ConfirmStep(props: { phrase: string; wordIndex: number; onBack(): void; onNext(): void }) {
  const { t } = useTranslation()
  const [word, setWord] = useState('')
  const [error, setError] = useState(false)
  const expected = props.phrase.split(' ')[props.wordIndex]
  return (
    <form
      className="card space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (word.trim().toLowerCase() === expected) {
          props.onNext()
        } else {
          setError(true)
        }
      }}
    >
      <h2 className="font-display text-2xl">{t('create.confirmTitle')}</h2>
      <p className="text-sm text-ink-soft">
        {t('create.confirmHint', { index: props.wordIndex + 1 })}
      </p>
      <input
        value={word}
        onChange={(e) => {
          setWord(e.target.value)
          setError(false)
        }}
        autoFocus
        autoCapitalize="none"
        autoComplete="off"
      />
      {error && <p className="text-sm text-danger">{t('create.confirmError')}</p>}
      <StepButtons onBack={props.onBack} nextDisabled={!word.trim()} />
    </form>
  )
}

function RestorePhraseStep(props: { onBack(): void; onNext(phrase: string): void }) {
  const { t } = useTranslation()
  const [phrase, setPhrase] = useState('')
  const [invalid, setInvalid] = useState(false)
  return (
    <form
      className="card space-y-4"
      onSubmit={async (e) => {
        e.preventDefault()
        const crypto = await loadCrypto()
        const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ')
        if (crypto.validateMnemonic(normalized)) {
          props.onNext(normalized)
        } else {
          setInvalid(true)
        }
      }}
    >
      <h2 className="font-display text-2xl">{t('restore.title')}</h2>
      <p className="text-sm text-ink-soft">{t('restore.hint')}</p>
      <textarea
        value={phrase}
        onChange={(e) => {
          setPhrase(e.target.value)
          setInvalid(false)
        }}
        placeholder={t('restore.placeholder')}
        rows={3}
        autoFocus
        autoCapitalize="none"
        autoComplete="off"
      />
      {invalid && <p className="text-sm text-danger">{t('restore.invalid')}</p>}
      <StepButtons onBack={props.onBack} nextDisabled={!phrase.trim()} />
    </form>
  )
}

function PasswordStep(props: {
  title: string
  onBack(): void
  onNext(password: string, deviceName: string): void
}) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [deviceName, setDeviceName] = useState(defaultDeviceName())
  const tooShort = password.length > 0 && password.length < 8
  const mismatch = repeat.length > 0 && password !== repeat
  const valid = password.length >= 8 && password === repeat && deviceName.trim().length > 0
  return (
    <form
      className="card space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) props.onNext(password, deviceName.trim())
      }}
    >
      <h2 className="font-display text-2xl">{props.title}</h2>
      <p className="text-sm text-ink-soft">{t('create.unlockHint')}</p>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={t('create.unlockPlaceholder')}
        autoFocus
      />
      <input
        type="password"
        value={repeat}
        onChange={(e) => setRepeat(e.target.value)}
        placeholder={t('create.unlockRepeatPlaceholder')}
      />
      {tooShort && <p className="text-sm text-danger">{t('create.unlockTooShort')}</p>}
      {mismatch && <p className="text-sm text-danger">{t('create.unlockMismatch')}</p>}
      <label className="block text-sm text-ink-soft">
        {t('create.deviceNameTitle')}
        <input
          className="mt-1"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          placeholder={t('create.deviceNamePlaceholder')}
          maxLength={64}
        />
      </label>
      <StepButtons onBack={props.onBack} nextDisabled={!valid} />
    </form>
  )
}

function StepButtons(props: {
  onBack(): void
  onNext?(): void
  nextLabel?: string
  nextDisabled?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="flex justify-between pt-2">
      <button type="button" className="btn-quiet" onClick={props.onBack}>
        {t('common.back')}
      </button>
      <button
        type={props.onNext ? 'button' : 'submit'}
        className="btn-gold"
        disabled={props.nextDisabled}
        onClick={props.onNext}
      >
        {props.nextLabel ?? t('common.continue')}
      </button>
    </div>
  )
}
