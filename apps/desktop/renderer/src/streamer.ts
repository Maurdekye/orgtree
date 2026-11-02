import { useSyncExternalStore } from 'react'
import { desktop } from './desktop'
import { getAccountRegistry } from './api'
import { appValueNow, watchAppFeed } from './appfeed'
import { installStreamerBoundary, type StreamerBoundary } from './streamer-boundary'
import { rememberScreenValues, screenKnownReady, screenKnownValues, watchScreenKnown } from './streamer-known'

const KEY = 'orgtree-streamer-mode'
const EVENT = 'orgtree:streamer-mode'
const listeners = new Set<() => void>(), boundaries = new Map<Document, StreamerBoundary>()
let enabled = false, ready = false, accountReady = false, error = '', started = false, revision = 0
let snapshot = { enabled, ready, error }
function publish() {
  snapshot = { enabled, ready, error }
  for (const boundary of boundaries.values()) boundary.update(enabled || !ready, screenKnownValues(), ready && accountReady && screenKnownReady())
  for (const listener of listeners) listener()
}
function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }
export function useStreamerMode() { return useSyncExternalStore(subscribe, () => snapshot) }
export function protectStreamerDocument(doc: Document) {
  const existing = boundaries.get(doc)
  if (existing) return () => {}
  const boundary = installStreamerBoundary(doc, () => { void setStreamerMode(false) }); boundaries.set(doc, boundary)
  boundary.update(enabled || !ready, screenKnownValues(), ready && accountReady && screenKnownReady())
  return () => { boundary.dispose(); boundaries.delete(doc) }
}
function accept(on: boolean) {
  revision++; enabled = on; ready = true; error = ''; publish()
  if (on && !accountReady) void getAccountRegistry().then(value => {
    rememberScreenValues({ accounts: value.accounts, host_identity: value.host_identity })
    accountReady = true; publish()
  }).catch(() => { error = 'Streamer mode is hiding content because account identities could not be loaded.'; publish() })
}
export async function setStreamerMode(on: boolean) {
  const bridge = desktop(), attempt = ++revision
  // Enabling masks immediately. Disabling waits for the authoritative save.
  if (on) { enabled = true; publish() }
  try {
    if (bridge) {
      const value = await bridge.setPreferences({ streamerMode: on })
      if (revision === attempt) accept(value.streamerMode === true)
    } else {
      localStorage.setItem(KEY, on ? 'on' : 'off')
      window.dispatchEvent(new Event(EVENT))
    }
  } catch {
    if (revision === attempt) { error = 'Could not save Streamer mode. Protection remains on; try again.'; enabled = true; publish() }
  }
}
/** Before React mounts. Unreadable native preferences stay covered, never assumed off. */
export function startStreamerMode() {
  if (started) return () => {}
  started = true
  const stopDocument = protectStreamerDocument(document), bridge = desktop()
  const stopKnown = watchScreenKnown(publish)
  const feed = () => { const value = appValueNow<unknown>('accounts'); if (value) { rememberScreenValues({ accounts: value }); accountReady = true; publish() } }
  const stopFeed = watchAppFeed(feed)
  let alive = true
  let stopPreference: () => void
  if (bridge) {
    stopPreference = bridge.onEvent(e => { if (alive && e.type === 'preferences') accept((e.data as { streamerMode?: boolean }).streamerMode === true) })
    const before = revision
    void bridge.getPreferences().then(p => { if (alive && before === revision) accept(p.streamerMode === true) })
      .catch(() => { if (alive && before === revision) { error = 'Streamer mode preferences could not be loaded. Content remains hidden.'; publish() } })
  } else {
    const read = () => { try { accept(localStorage.getItem(KEY) === 'on') } catch { enabled = true; ready = false; publish() } }
    const storage = (e: StorageEvent) => { if (!e.key || e.key === KEY) read() }
    window.addEventListener('storage', storage); window.addEventListener(EVENT, read); read()
    stopPreference = () => { window.removeEventListener('storage', storage); window.removeEventListener(EVENT, read) }
  }
  return () => { alive = false; stopPreference(); stopFeed(); stopKnown(); stopDocument(); started = false }
}
