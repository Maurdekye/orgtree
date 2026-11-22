import { useSyncExternalStore } from 'react'

// Serving engine OS from GET /api/host (`std::env::consts::OS`, e.g. 'windows', 'linux', 'macos').
// Remains null (unknown) when /api/host has not succeeded yet or when an older engine omits `os` —
// never substituted with the local desktop OS.
let hostOs: string | null = null
let hostOsEpoch = 0
const listeners = new Set<() => void>()

export function currentHostOsEpoch(): number {
  return hostOsEpoch
}

export function noteHostOs(os: string | null | undefined, expectedEpoch?: number): void {
  if (expectedEpoch !== undefined && expectedEpoch !== hostOsEpoch) return
  const next = typeof os === 'string' && os ? os : null
  if (next === hostOs) return
  hostOs = next
  for (const listener of listeners) listener()
}

export function clearHostOs(): void {
  hostOsEpoch++
  noteHostOs(null)
}

export function currentHostOs(): string | null {
  return hostOs
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useHostOs(): string | null {
  return useSyncExternalStore(subscribe, currentHostOs, currentHostOs)
}

export function useIsWindowsHost(): boolean {
  return useHostOs() === 'windows'
}

/** True only when the serving engine is KNOWN to be non-Windows. Unknown (`null`)
 *  keeps the existing Windows/default wording until `/api/host` identifies the OS. */
export function useIsNonWindowsHost(): boolean {
  const os = useHostOs()
  return os !== null && os !== 'windows'
}

export interface HostLoadContext {
  signal: AbortSignal
  isCurrent: () => boolean
  target: string | null
}

export interface HostRefresher {
  loadInitial: (target?: string | null) => Promise<void>
  onReconnect: (target?: string | null) => Promise<void>
  onRecovered: (target?: string | null) => Promise<void>
  hasFailed: () => boolean
}

/** Target-aware /api/host loader that never coalesces across target switches,
 *  discards stale results, and retries after transport recovery even when an
 *  earlier read already succeeded. */
export function createHostRefresher(
  load: (ctx: HostLoadContext) => Promise<void>,
): HostRefresher {
  let failed = false
  let seq = 0
  let currentStartEpoch = currentHostOsEpoch()
  let osAtCurrentStart: string | null = currentHostOs()
  let latestApplied: { seq: number; epoch: number; os: string | null } | null = null
  let inFlight: {
    seq: number
    target: string | null | undefined
    controller: AbortController
    promise: Promise<void>
  } | null = null

  const start = (target: string | null | undefined, force: boolean): Promise<void> => {
    if (!force && inFlight && inFlight.target === target) return inFlight.promise
    if (inFlight) inFlight.controller.abort()
    const mySeq = ++seq
    const controller = new AbortController()
    currentStartEpoch = currentHostOsEpoch()
    osAtCurrentStart = currentHostOs()
    latestApplied = null
    const promise = load({
      signal: controller.signal,
      isCurrent: () => mySeq === seq,
      target: target ?? null,
    })
      .then(() => {
        if (mySeq === seq) {
          failed = false
          latestApplied = { seq: mySeq, epoch: currentHostOsEpoch(), os: currentHostOs() }
          return
        }
        // A superseded request settled after a target switch / reconnect: restore
        // the newer target's recorded OS (or cleared unknown state) in case a
        // caller wrote host OS without checking `isCurrent()` or epoch.
        if (latestApplied && latestApplied.seq === seq) {
          if (latestApplied.epoch === currentHostOsEpoch()) noteHostOs(latestApplied.os)
        } else if (currentHostOsEpoch() === currentStartEpoch) {
          noteHostOs(osAtCurrentStart)
        }
      })
      .catch(() => {
        if (mySeq === seq) {
          failed = true
          latestApplied = null
        }
      })
      .finally(() => {
        if (inFlight?.seq === mySeq) inFlight = null
      })
    inFlight = { seq: mySeq, target, controller, promise }
    return promise
  }

  return {
    loadInitial: (target) => start(target, false),
    onReconnect: (target) => start(target, true),
    onRecovered: (target) => start(target, false),
    hasFailed: () => failed,
  }
}
