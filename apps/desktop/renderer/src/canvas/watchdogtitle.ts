import type { Watchdog } from '../types'
import { useWatchdogCountdown } from './watchdogcountdown'
import { useNativeTitle } from './nativetitle'
import { appDogTitle } from './appdog'

export const watchdogStateWords = (dog: Watchdog) => dog.disabled ? `disabled: ${dog.disabled}` : dog.state

/** One identity source; visible aliases and destination/click capabilities do
 * not change what the same known watchdog says on hover. */
export function watchdogTitle(dog: Watchdog, countdown?: string): string {
  const gone = dog.spent || dog.state === 'spent'
  // an app event watchdog names its app, panel and event (user 2026-10-27)
  const kind = dog.kind === 'app_listener' ? appDogTitle(dog) : dog.kind
  const title = `${dog.once ? 'one-shot dog' : 'watchdog'} "${dog.name}" (${kind}) — ${gone ? 'no longer exists' : watchdogStateWords(dog)}; ${dog.once ? 'fires once' : 'continuous'}`
  return countdown ? `${title} · ${countdown}` : title
}

/** Coordinator interpretation (2026-10-21) of the user's 06:53Z approval:
 * a meaningful next-check countdown belongs to the canonical state tooltip,
 * on every known-dog surface. This is not a separate user ruling. */
export function useWatchdogTitle(dog: Watchdog | undefined, handle = '', gone = false): string {
  const countdown = useWatchdogCountdown(dog)
  return dog ? watchdogTitle(dog, countdown)
    : `watchdog "${handle}" — kind and mode unknown${gone ? '; no longer exists' : ''}`
}

export function useWatchdogTooltip(dog: Watchdog | undefined, handle = '', gone = false) {
  return useNativeTitle(useWatchdogTitle(dog, handle, gone), dog?.id ?? handle)
}
