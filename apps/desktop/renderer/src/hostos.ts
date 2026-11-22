import { useSyncExternalStore } from 'react'
import { desktopPlatform } from './desktop'

// Serving engine OS from GET /api/host (`std::env::consts::OS`, e.g. 'windows', 'linux', 'macos').
// Null until the first /api/host response arrives; falls back to the local desktop OS so
// subcomponents never trigger extra /api/host fetches on mount.
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

function fallbackHostOs(): string {
  const p = desktopPlatform()
  if (p === 'win32') return 'windows'
  if (p === 'darwin') return 'macos'
  return p
}

export function currentHostOs(): string {
  return hostOs ?? fallbackHostOs()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useHostOs(): string {
  return useSyncExternalStore(subscribe, currentHostOs, currentHostOs)
}

export function useIsWindowsHost(): boolean {
  return useHostOs() === 'windows'
}
