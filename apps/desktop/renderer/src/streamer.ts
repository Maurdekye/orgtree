import { useSyncExternalStore } from 'react'
import { desktop } from './desktop'
import { installStreamerBoundary, type StreamerBoundary, type StreamerConfig } from './streamer-boundary'
import { DEFAULT_STREAMER_TYPES, STREAMER_COVER_PREF, STREAMER_TYPE_PREF, streamerCoverFrom, streamerTypesFrom, type StreamerType, type StreamerTypes } from '../../../../packages/contracts/streamer'

const KEY = 'orgtree-streamer-mode'
const TYPES_KEY = 'orgtree-streamer-types'
const EVENT = 'orgtree:streamer-mode'
const listeners = new Set<() => void>(), boundaries = new Map<Document, StreamerBoundary>()
let enabled = false, ready = false, error = '', started = false, revision = 0
// Settings > Streamer mode: which of the six types are hidden, and the cover over opaque surfaces (USER maad1c88abeba)
let types: StreamerTypes = { ...DEFAULT_STREAMER_TYPES }, cover = true, orgNames: readonly string[] = []
// `auto`: the OBS automation (not the user) turned the mode on; `autoSetting`: Display's switch (absent = on).
let auto = false, autoSetting = true, autoApp = ''
let snapshot = { enabled, ready, error, auto, autoSetting, types, cover }
export const autoNote = (app: string) => `turned on because ${app || 'OBS'} is running`
const prefsAuto = (p: unknown) => { const v = (p ?? {}) as { streamerMode?: boolean; streamerAuto?: boolean; streamerAutoActive?: boolean; streamerAutoApp?: string }; return { app: typeof v.streamerAutoApp === 'string' ? v.streamerAutoApp : '', on: v.streamerMode === true, auto: v.streamerMode === true && v.streamerAutoActive === true, setting: v.streamerAuto !== false } }
const config = (): StreamerConfig => ({ types, cover, orgNames, ready, note: enabled && auto ? autoNote(autoApp) : '' })
function publish() {
  snapshot = { enabled, ready, error, auto, autoSetting, types, cover }
  for (const boundary of boundaries.values()) boundary.update(enabled || !ready, config())
  for (const listener of listeners) listener()
}
function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }
export function useStreamerMode() { return useSyncExternalStore(subscribe, () => snapshot) }
export function protectStreamerDocument(doc: Document) {
  const existing = boundaries.get(doc)
  if (existing) return () => {}
  const boundary = installStreamerBoundary(doc, () => { void setStreamerMode(false) }); boundaries.set(doc, boundary)
  boundary.update(enabled || !ready, config())
  return () => { boundary.dispose(); boundaries.delete(doc) }
}
function accept(on: boolean, prefs?: unknown) {
  revision++; enabled = on; ready = true; error = ''
  if (prefs !== undefined) { const p = prefsAuto(prefs); auto = p.auto; autoSetting = p.setting; autoApp = p.app; types = streamerTypesFrom(prefs); cover = streamerCoverFrom(prefs) }
  if (!on) auto = false
  publish()
}
/** The OTHER orgs of this install (the current org excluded by the caller); refreshed live as orgs are added or renamed. */
export function setStreamerOrgs(names: readonly string[]) {
  const next = [...new Set(names.map(n => n.trim()).filter(n => n.length >= 3))].sort()
  if (next.length === orgNames.length && next.every((n, i) => n === orgNames[i])) return
  orgNames = next; publish()
}
/** Settings > Streamer mode: one switch per type. Applies live to every window through the preferences broadcast. */
export async function setStreamerType(type: StreamerType, on: boolean) {
  const bridge = desktop(), key = STREAMER_TYPE_PREF[type], before = types
  types = { ...types, [type]: on }; publish()
  try {
    if (bridge) { const value = await bridge.setPreferences({ [key]: on } as never); types = streamerTypesFrom(value); publish() }
    else { localStorage.setItem(TYPES_KEY, JSON.stringify(types)); window.dispatchEvent(new Event(EVENT)) }
  } catch { types = before; publish() }
}
export async function setStreamerCover(on: boolean) {
  const bridge = desktop(), before = cover
  cover = on; publish()
  try {
    if (bridge) { const value = await bridge.setPreferences({ [STREAMER_COVER_PREF]: on } as never); cover = streamerCoverFrom(value); publish() }
    else { localStorage.setItem(TYPES_KEY + '-cover', on ? 'on' : 'off'); window.dispatchEvent(new Event(EVENT)) }
  } catch { cover = before; publish() }
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
  let alive = true
  let stopPreference: () => void
  if (bridge) {
    stopPreference = bridge.onEvent(e => { if (alive && e.type === 'preferences') accept((e.data as { streamerMode?: boolean }).streamerMode === true, e.data) })
    const before = revision
    void bridge.getPreferences().then(p => { if (alive && before === revision) accept(p.streamerMode === true, p) })
      .catch(() => { if (alive && before === revision) { error = 'Streamer mode preferences could not be loaded. Content remains hidden.'; publish() } })
  } else {
    const read = () => {
      try {
        try { types = streamerTypesFrom(JSON.parse(localStorage.getItem(TYPES_KEY) ?? '{}')) } catch { types = { ...DEFAULT_STREAMER_TYPES } }
        cover = localStorage.getItem(TYPES_KEY + '-cover') !== 'off'
        accept(localStorage.getItem(KEY) === 'on')
      } catch { enabled = true; ready = false; publish() } }
    const storage = (e: StorageEvent) => { if (!e.key || e.key === KEY) read() }
    window.addEventListener('storage', storage); window.addEventListener(EVENT, read); read()
    stopPreference = () => { window.removeEventListener('storage', storage); window.removeEventListener(EVENT, read) }
  }
  return () => { alive = false; stopPreference(); stopDocument(); started = false }
}
