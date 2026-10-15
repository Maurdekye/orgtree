/* Canvas background preference (user 2026-10-15; contracts/canvas-background.ts).
 *
 * A native desktop preference like EPIC Mode's bit beside it (epic/pref.ts),
 * because the renderer's own per-origin storage does not reliably survive a
 * relaunch: the main process stores it and broadcasts every write to every
 * window, so picking a background anywhere repaints every canvas. In a plain
 * browser the same object lives in localStorage instead.
 *
 * Absent reads as the original dot grid at full strength (the resolver in
 * the contracts module owns that), so an older shell whose policy rejects
 * the key simply never stores it and keeps the shipped background. Writes
 * stay sparse — only intensities the user actually moved are stored — so a
 * later change to a default still reaches untouched themes. */
import { useSyncExternalStore } from 'react'
import { desktop } from './desktop'
import { CANVAS_BACKGROUNDS, resolveCanvasBackground, sanitizeCanvasBackground } from '../../../../packages/contracts/canvas-background'
import type { CanvasBackgroundPreference, CanvasBackgroundTheme, ResolvedCanvasBackground } from '../../../../packages/contracts/canvas-background'

export const CANVAS_BG_KEY = 'orgtree-canvas-background'
const STORED = 'orgtree:canvas-bg-stored'

const rawOf = (prefs: unknown): CanvasBackgroundPreference | null =>
  sanitizeCanvasBackground(
    prefs && typeof prefs === 'object'
      ? (prefs as { canvasBackground?: unknown }).canvasBackground
      : undefined)

function readLocalRaw(): CanvasBackgroundPreference | null {
  try { return sanitizeCanvasBackground(JSON.parse(localStorage.getItem(CANVAS_BG_KEY) || 'null')) }
  catch { return null }
}

/** Follow the stored preference in its sparse stored shape (null = absent):
 *  `accept` runs with the current value and again on every change,
 *  whichever window made it. */
export function watchCanvasBackgroundRaw(accept: (pref: CanvasBackgroundPreference | null) => void): () => void {
  const bridge = desktop()
  if (!bridge) {
    const storage = (e: StorageEvent) => { if (e.key === CANVAS_BG_KEY || e.key === null) accept(readLocalRaw()) }
    accept(readLocalRaw())
    window.addEventListener('storage', storage)
    window.addEventListener(STORED, storage as EventListener)
    return () => { window.removeEventListener('storage', storage); window.removeEventListener(STORED, storage as EventListener) }
  }
  let alive = true, revision = 0
  const stop = bridge.onEvent(e => {
    if (alive && e.type === 'preferences') { revision++; accept(rawOf(e.data)) }
  })
  const initial = revision
  void bridge.getPreferences()
    .then(p => { if (alive && revision === initial) accept(rawOf(p)) })
    .catch(() => {})
  return () => { alive = false; stop() }
}

/** Follow the stored preference resolved (defaults filled in). */
export function watchCanvasBackground(accept: (value: ResolvedCanvasBackground) => void): () => void {
  return watchCanvasBackgroundRaw(pref => accept(resolveCanvasBackground(pref)))
}

async function persist(pref: CanvasBackgroundPreference): Promise<void> {
  const bridge = desktop()
  if (bridge) { await bridge.setPreferences({ canvasBackground: pref }); return }
  try { localStorage.setItem(CANVAS_BG_KEY, JSON.stringify(pref)) } catch { /* private mode */ }
  window.dispatchEvent(new Event(STORED))
}

/* One shared subscription per document (as epic/pref.ts): the canvas layer
 * and the Display picker read the same value without each opening its own
 * native subscription. `shown` is what React draws — the stored value, or a
 * choice whose save is still in flight; `shownPref` is its sparse twin, the
 * object a save would write. */
const keyOf = (r: ResolvedCanvasBackground): string =>
  r.theme + '|' + CANVAS_BACKGROUNDS.map(t => r.intensities[t]).join(',')
let storedPref: CanvasBackgroundPreference | null = null
let shownPref: CanvasBackgroundPreference | null = null
let shown: ResolvedCanvasBackground = resolveCanvasBackground(null)
let stopShared: (() => void) | null = null
const subs = new Set<() => void>()
const notify = () => { for (const s of [...subs]) s() }
const show = (pref: CanvasBackgroundPreference | null) => {
  shownPref = pref
  const next = resolveCanvasBackground(pref)
  if (keyOf(next) !== keyOf(shown)) { shown = next; notify() }
}

function subscribe(fn: () => void): () => void {
  subs.add(fn)
  if (!stopShared) stopShared = watchCanvasBackgroundRaw(pref => { storedPref = pref; show(pref) })
  return () => {
    subs.delete(fn)
    if (!subs.size && stopShared) { stopShared(); stopShared = null }
  }
}

const FALLBACK: ResolvedCanvasBackground = resolveCanvasBackground(null)

/** The canvas background for React. The dot grid until the stored value has
 *  been read — which is also what an untouched install always gets. */
export const useCanvasBackground = (): ResolvedCanvasBackground =>
  useSyncExternalStore(subscribe, () => shown, () => FALLBACK)

/* Writes. The intensity slider emits throughout a drag; like the custom
 * theme colour (themes.tsx), only the settled value crosses the bridge —
 * the optimistic `shown` already repainted the canvas, so the preview is
 * live while the IPC stays at one write per drag. A failed write puts the
 * canvas back to what is really stored. */
let pending: CanvasBackgroundPreference | null = null
let saveTimer: ReturnType<typeof setTimeout> | undefined

export function flushCanvasBackground(): Promise<void> {
  clearTimeout(saveTimer)
  const pref = pending
  pending = null
  if (!pref) return Promise.resolve()
  return persist(pref).catch(() => show(storedPref))
}

function choose(pref: CanvasBackgroundPreference, debounce: boolean): void {
  show(pref)
  pending = pref
  clearTimeout(saveTimer)
  if (debounce) saveTimer = setTimeout(() => { void flushCanvasBackground() }, 250)
  else void flushCanvasBackground()
}

export function setCanvasBackgroundTheme(theme: CanvasBackgroundTheme): void {
  choose({ theme, intensities: shownPref?.intensities }, false)
}

export function setCanvasBackgroundIntensity(theme: CanvasBackgroundTheme, value: number): void {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : shown.intensities[theme]
  choose({
    theme: shown.theme,
    intensities: { ...shownPref?.intensities, [theme]: clamped },
  }, true)
}
