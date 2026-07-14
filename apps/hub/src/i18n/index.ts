import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import de from './locales/de.json'
import en from './locales/en.json'

export const resources = {
  en: { translation: en },
  de: { translation: de },
} as const

declare module 'i18next' {
  interface CustomTypeOptions {
    resources: (typeof resources)['en']
  }
}

const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('gn.lang') : null
const detected =
  typeof navigator !== 'undefined' && navigator.language.startsWith('de') ? 'de' : 'en'

i18n.use(initReactI18next).init({
  resources,
  lng: stored ?? detected,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export function setLanguage(lang: 'en' | 'de'): void {
  localStorage.setItem('gn.lang', lang)
  void i18n.changeLanguage(lang)
}

export default i18n
