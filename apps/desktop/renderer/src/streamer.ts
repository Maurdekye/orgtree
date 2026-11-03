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
// `auto`: the OBS automation (not the user) turned the mode on; `autoSetting`: Display's switch (absent = on).
let auto = false, autoSetting = true, autoApp = ''
let snapshot = { enabled, ready, error, auto, autoSetting }
export const autoNote = (app: string) => `turned on because ${app || 'OBS'} is running`
const prefsAuto = (p: unknown) => { const v = (p ?? {}) as { streamerMode?: boolean; streamerAuto?: boolean; streamerAutoActive?: boolean; streamerAutoApp?: string }; return { app: typeof v.streamerAutoApp === 'string' ? v.streamerAutoApp : '', on: v.streamerMode === true, auto: v.streamerMode === true && v.streamerAutoActive === true, setting: v.streamerAuto !== false } }
function publish() {
  snapshot = { enabled, ready, error, auto, autoSetting }
  for (const boundary of boundaries.values()) boundary.update(enabled || !ready, screenKnownValues(), ready && accountReady && screenKnownReady(), enabled && auto ? autoNote(autoApp) : '')
  for (const listener of listeners) listener()
}
function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }
export function useStreamerMode() { return useSyncExternalStore(subscribe, () => snapshot) }
export function protectStreamerDocument(doc: Document) {
  const existing = boundaries.get(doc)
  if (existing) return () => {}
  const boundary = installStreamerBoundary(doc, () => { void setStreamerMode(false) }); boundaries.set(doc, boundary)
  boundary.update(enabled || !ready, screenKnownValues(), ready && accountReady && screenKnownReady(), enabled && auto ? autoNote(autoApp) : '')
  return () => { boundary.dispose(); boundaries.delete(doc) }
}
function accept(on: boolean, prefs?: unknown) {
  revision++; enabled = on; ready = true; error = ''
  if (prefs !== undefined) { const p = prefsAuto(prefs); auto = p.auto; autoSetting = p.setting; autoApp = p.app }
  if (!on) auto = false
  publish()
  if (on && !accountReady) void getAccountRegistry().then(value => {
    rememberScreenValues({ accounts: value.accounts, host_identity: value.host_identity })
    accountReady = true; publish()
  }).catch(() => { error = 'Streamer mode is hiding content because account identities could not be loaded.'; publish() })
}
/** Display › "Turn on automatically while OBS is running" (desktop app only: a
 *  browser tab cannot see the machine's processes). */
export async function setStreamerAuto(on: boolean) {
  const bridge = desktop(); if (!bridge) return
  autoSetting = on; publish()
  try { const value = await bridge.setPreferences({ streamerAuto: on }); autoSetting = value.streamerAuto !== false }
  catch { autoSetting = !on }
  publish()
}
export async function setStreamerMode(on: boolean) {
  const bridge = desktop(), attempt = ++revision
  // Enabling masks immediately. Disabling waits for the authoritative save.
  if (on) { enabled = true; publish() }
  try {
    if (bridge) {
      const value = await bridge.setPreferences({ streamerMode: on })
      if (revision === attempt) accept(value.streamerMode === true, value)
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
    stopPreference = bridge.onEvent(e => { if (alive && e.type === 'preferences') accept((e.data as { streamerMode?: boolean }).streamerMode === true, e.data) })
    const before = revision
    void bridge.getPreferences().then(p => { if (alive && before === revision) accept(p.streamerMode === true, p) })
      .catch(() => { if (alive && before === revision) { error = 'Streamer mode preferences could not be loaded. Content remains hidden.'; publish() } })
  } else {
    const read = () => { try { accept(localStorage.getItem(KEY) === 'on') } catch { enabled = true; ready = false; publish() } }
    const storage = (e: StorageEvent) => { if (!e.key || e.key === KEY) read() }
    window.addEventListener('storage', storage); window.addEventListener(EVENT, read); read()
    stopPreference = () => { window.removeEventListener('storage', storage); window.removeEventListener(EVENT, read) }
  }
  return () => { alive = false; stopPreference(); stopFeed(); stopKnown(); stopDocument(); started = false }
}
