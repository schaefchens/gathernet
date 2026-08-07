import { useCallback, useSyncExternalStore } from 'react'

/**
 * Subscribe to a CSS media query.
 *
 * Used where a `hidden md:block` class isn't enough — the conversation list must
 * exist once in the DOM, not twice with one copy hidden, so that it isn't queried,
 * decrypted, and rendered twice on every viewport.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** True at Tailwind's `md` breakpoint and up — where the rail + sidebar appear. */
export const DESKTOP_QUERY = '(min-width: 48rem)'

/**
 * True on pointer devices. A touch screen never fires hover, so anything revealed
 * by `:hover` alone is simply unreachable there and needs an explicit control.
 */
export const HOVER_QUERY = '(hover: hover)'
