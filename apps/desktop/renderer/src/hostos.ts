import { useSyncExternalStore } from 'react'

// Serving engine OS from GET /api/host (`std::env::consts::OS`, e.g. 'windows', 'linux', 'macos').
// Remains null (unknown) when /api/host has not succeeded yet or when an older engine omits `os` —
// never substituted with the local desktop OS.
let hostOs: string | null = null
const listeners = new Set<() => void>()

export function noteHostOs(os: string | null | undefined): void {
  const next = typeof os === 'string' && os ? os : null
  if (next === hostOs) return
  hostOs = next
  for (const listener of listeners) listener()
}

export function clearHostOs(): void {
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

export interface HostRefresher {
  loadInitial: () => Promise<void>
  onReconnect: () => Promise<void>
  onRecovered: () => Promise<void>
  hasFailed: () => boolean
}

/** Deduplicated /api/host loader that tracks failed initial boots and retries
 *  after reconnect or transport recovery without double-fetching in parallel. */
export function createHostRefresher(load: () => Promise<void>): HostRefresher {
  let failed = false
  let inFlight: Promise<void> | null = null
  const run = (): Promise<void> => {
    if (inFlight) return inFlight
    const p = load()
      .then(() => { failed = false })
      .catch(() => { failed = true })
      .finally(() => { if (inFlight === p) inFlight = null })
    inFlight = p
    return p
  }
  return {
    loadInitial: run,
    onReconnect: run,
    onRecovered: () => (failed ? run() : Promise.resolve()),
    hasFailed: () => failed,
  }
}
