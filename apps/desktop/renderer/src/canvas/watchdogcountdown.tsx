import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { Watchdog } from '../types'

const POLL_FLOOR_S = 15
const CHECKING_GRACE_MS = 3_000
const PERIODIC = new Set<Watchdog['kind']>(['file', 'command', 'process'])

let second = Math.floor(Date.now() / 1_000)
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Map<() => void, { read: () => string | undefined; snapshot: string | undefined }>()

function tick() {
  const next = Math.floor(Date.now() / 1_000)
  if (next === second) return
  second = next
  for (const [listener, entry] of [...listeners]) {
    const snapshot = entry.read()
    if (snapshot === entry.snapshot) continue
    entry.snapshot = snapshot
    listener()
  }
}

function subscribe(listener: () => void, read: () => string | undefined) {
  listeners.set(listener, { read, snapshot: read() })
  if (!timer) {
    second = Math.floor(Date.now() / 1_000)
    timer = setInterval(tick, 1_000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

const noSubscribe = () => () => {}

function timestamp(value?: string): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Current engines publish the persisted next check; overdue clocks stay
 *  checking until new engine evidence arrives. Old snapshots retain fallback. */
export function watchdogCountdownText(dog: Watchdog, nowMs: number): string | undefined {
  if (!PERIODIC.has(dog.kind) || dog.state !== 'armed' || dog.spent
      || !Number.isFinite(dog.interval_s) || dog.interval_s <= 0) return undefined

  const persisted=timestamp(dog.next_check_at)
  const lastCheck = timestamp(dog.last_check)
  if (persisted===undefined && lastCheck===undefined) return undefined

  let nextDue:number,checking:boolean
  if(persisted!==undefined){
    const quiet=dog.fire_mode==='silence'?timestamp(dog.next_silence_at):undefined
    nextDue=quiet===undefined?persisted:Math.min(persisted,quiet)
    checking=nowMs>=nextDue
  }else{
    // Compatibility for a legacy snapshot only. Current engines publish the
    // durable deadline and must never roll an overdue clock forward locally.

  const intervalMs = Math.max(POLL_FLOOR_S, dog.interval_s) * 1_000
  const elapsed = nowMs - lastCheck!
  const completedPeriods = Math.max(0, Math.floor(elapsed / intervalMs))
  const mostRecentIntervalDue = lastCheck! + completedPeriods * intervalMs
  nextDue = lastCheck! + (completedPeriods + 1) * intervalMs
  checking = completedPeriods > 0 && nowMs - mostRecentIntervalDue <= CHECKING_GRACE_MS

  if (dog.fire_mode === 'silence' && Number.isFinite(dog.quiet_period_s)
      && (dog.quiet_period_s ?? -1) >= 0) {
    const silenceSince = timestamp(dog.silence_since) ?? timestamp(dog.at)
    if (silenceSince !== undefined) {
      const silenceDue = silenceSince + dog.quiet_period_s! * 1_000
      // A quiet deadline later than the last actual check can shorten the
      // engine's wait. Ignore an already-consumed deadline after its grace;
      // the next real feed update supplies the new silence baseline.
      if (silenceDue > lastCheck! && silenceDue < nextDue) {
        if (silenceDue > nowMs) nextDue = silenceDue
        else if (nowMs - silenceDue <= CHECKING_GRACE_MS) checking = true
      }
    }
  }

  }
  if (checking) return 'checking…'
  const seconds = Math.max(1, Math.ceil((nextDue - nowMs) / 1_000))
  const remainingMs = Math.max(0, nextDue - nowMs)
  if (remainingMs >= 86_400_000) {
    const days = Math.floor(remainingMs / 86_400_000)
    const hours = Math.floor((remainingMs % 86_400_000) / 3_600_000)
    return `next check in ${days}d ${hours}h`
  }
  if (remainingMs >= 3_600_000) {
    const hours = Math.floor(remainingMs / 3_600_000)
    const minutes = Math.floor((remainingMs % 3_600_000) / 60_000)
    return `next check in ${hours}h ${minutes}m`
  }
  return `next check in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function useWatchdogCountdown(dog: Watchdog): string | undefined {
  const shouldTick = PERIODIC.has(dog.kind) && dog.state === 'armed' && !dog.spent
    && Number.isFinite(dog.interval_s) && dog.interval_s > 0
    && (timestamp(dog.next_check_at) !== undefined || timestamp(dog.last_check) !== undefined)
  const read = () => watchdogCountdownText(dog, Date.now())
  const subscribeDog = (listener: () => void) => subscribe(listener, read)
  return useSyncExternalStore(shouldTick ? subscribeDog : noSubscribe, read, read)
}

/** A tiny row-local subscriber. It lets list chips update their own tooltip
 *  without ticking or re-rendering the surrounding canvas. */
export function WatchdogCountdown({ dog, compact = false }: { dog: Watchdog; compact?: boolean }) {
  const text = useWatchdogCountdown(dog)
  if (!text) return null
  return <span className={compact ? 'wd-next-check compact' : 'wd-next-check'} title={text}>{text}</span>
}

/** Updates the existing chip's native tooltip without changing its compact
 *  geometry or subscribing the surrounding canvas to the clock. */
export function WatchdogCountdownTitle({ dog, title, children }: {
  dog: Watchdog
  title: string
  children: ReactNode
}) {
  const text = useWatchdogCountdown(dog)
  return <span title={text ? `${title} · ${text}` : title}>{children}</span>
}
