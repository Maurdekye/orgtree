import { desktop } from './desktop'
import type { DesktopPreferences } from '../../../../packages/contracts'

export type RainbowPreference = NonNullable<DesktopPreferences['rainbowTheme']>
export const RAINBOW_OFF: RainbowPreference = { revealed: false, enabled: false, epoch: 0 }
const KEY = 'orgtree-rainbow-theme'
const STORED = 'orgtree:rainbow-stored'
export const CYCLE_MS = 20_000

export function colorHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2
  const h = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, d ? d / (1 - Math.abs(2 * l - 1)) : 0, l]
}

export function hslColor(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l)
  return '#' + [0, 8, 4].map(n => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0')
  }).join('')
}

/** Native pickers expose color, not their internal slider. Tiny reversals and
 * achromatic updates do not count. A reversal must travel 60 degrees before
 * it counts; six such turns must fit in a four-second window. */
export function hueGesture() {
  let extreme: number | null = null, direction = 0, previousAt = 0
  let turns: number[] = []
  return (color: string, now: number): boolean => {
    const [h, s, l] = colorHsl(color)
    if (s < .02 || l < .01 || l > .99 || now - previousAt > 4_000) {
      extreme = null; direction = 0; turns = []
    }
    previousAt = now
    if (s < .02 || l < .01 || l > .99) return false
    if (extreme === null) { extreme = h; return false }
    // Linear hue-slider position: crossing its red endpoints is a large
    // movement, not a circular shortcut through zero degrees.
    const delta = h - extreme
    if (!direction) {
      if (Math.abs(delta) >= 60) { direction = Math.sign(delta); extreme = h }
      return false
    }
    if (Math.sign(delta) === direction) extreme = h
    else if (Math.abs(delta) >= 60) {
      direction = Math.sign(delta); extreme = h
      turns = [...turns.filter(at => now - at <= 4_000), now]
    }
    return turns.length >= 6
  }
}

function preference(value: unknown): RainbowPreference {
  const p = value as Partial<RainbowPreference> | null
  return p && typeof p.revealed === 'boolean' && typeof p.enabled === 'boolean'
    && typeof p.epoch === 'number' && Number.isSafeInteger(p.epoch) && p.epoch >= 0
    ? { revealed: p.revealed, enabled: p.revealed && p.enabled, epoch: p.epoch } : RAINBOW_OFF
}

export function watchRainbow(accept: (p: RainbowPreference) => void): () => void {
  const bridge = desktop()
  if (!bridge) {
    const read = () => { let p: unknown; try { p = JSON.parse(localStorage.getItem(KEY) || 'null') } catch { /* defaults */ } accept(preference(p)) }
    const storage = (e: StorageEvent) => { if (e.key === KEY || e.key === null) read() }
    read(); window.addEventListener('storage', storage); window.addEventListener(STORED, read)
    return () => { window.removeEventListener('storage', storage); window.removeEventListener(STORED, read) }
  }
  let alive = true, revision = 0
  const stop = bridge.onEvent(e => {
    if (alive && e.type === 'preferences') { revision++; accept(preference((e.data as DesktopPreferences).rainbowTheme)) }
  })
  const initial = revision
  void bridge.getPreferences().then(p => { if (alive && revision === initial) accept(preference(p.rainbowTheme)) }).catch(() => {})
  return () => { alive = false; stop() }
}

export async function saveRainbow(p: RainbowPreference): Promise<void> {
  const bridge = desktop()
  if (bridge) await bridge.setPreferences({ rainbowTheme: p })
  else { localStorage.setItem(KEY, JSON.stringify(p)); window.dispatchEvent(new Event(STORED)) }
}

let mode = RAINBOW_OFF
let stopAnimation: (() => void) | undefined
const popouts = new Map<Window, (() => void) | undefined>()
let animatePopout: ((view: Window) => () => void) | undefined

/** A visible popout must keep animating even when its opener is minimized and
 * Chromium suspends that document's animation frames. All use the same epoch. */
export function followRainbowWindow(view: Window): () => void {
  popouts.set(view, animatePopout?.(view))
  return () => { popouts.get(view)?.(); popouts.delete(view) }
}

export function stopRainbow(): void {
  animatePopout = undefined
  for (const [view, stop] of popouts) { stop?.(); popouts.set(view, undefined) }
  stopAnimation?.(); stopAnimation = undefined
  document.documentElement.classList.remove('rainbow-theme')
}

/** Called once after static theme tokens are painted, never from a frame. */
export function applyRainbow(theme: string): void {
  if (!mode.enabled || !theme.startsWith('custom:')) return
  const root = document.documentElement, style = root.style
  const [h, s, l] = colorHsl(theme.slice(7))
  const originals = style.cssText
  root.classList.add('rainbow-theme')
  const accent = 'var(--rainbow-accent)'
  for (const prefix of ['--accent', '--org-accent']) {
    style.setProperty(prefix, accent)
    style.setProperty(`${prefix}-hover`, `color-mix(in srgb, ${accent} 75%, white)`)
    style.setProperty(`${prefix}-soft`, `color-mix(in srgb, ${accent} 16%, transparent)`)
  }
  // Relative RGB clamps the saved-color luminance rule to white or black.
  const ink = 'calc((140 - r * .299 - g * .587 - b * .114) * 1000)'
  style.setProperty('--rainbow-ink', `rgb(from ${accent} ${ink} ${ink} ${ink})`)
  style.setProperty('--accent-ink', 'var(--rainbow-ink)')
  const animate = (view: Window) => {
    const motion = view.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0, last = -Infinity
    const paint = () => {
      const elapsed = motion.matches ? 0 : ((Date.now() - mode.epoch) % CYCLE_MS + CYCLE_MS) % CYCLE_MS
      // This is the only style write per frame. No preferences, IPC, events or React.
      view.document.documentElement.style.setProperty('--rainbow-accent', hslColor((h + elapsed / CYCLE_MS * 360) % 360, s, l))
    }
    const tick = (now: number) => {
      if (now - last >= 1_000 / 30) { last = now; paint() }
      frame = view.requestAnimationFrame(tick)
    }
    const restart = () => { view.cancelAnimationFrame(frame); paint(); if (!motion.matches) frame = view.requestAnimationFrame(tick) }
    motion.addEventListener('change', restart)
    restart()
    return () => { view.cancelAnimationFrame(frame); motion.removeEventListener('change', restart) }
  }
  animatePopout = animate
  for (const [view, stop] of popouts) { stop?.(); popouts.set(view, animate(view)) }
  const stop = animate(window)
  stopAnimation = () => {
    stop()
    // Only restore our tokens: contrast and other preferences can change meanwhile.
    const before = document.createElement('div').style; before.cssText = originals
    for (const key of ['--accent', '--accent-hover', '--accent-soft', '--accent-ink', '--org-accent', '--org-accent-hover', '--org-accent-soft']) style.setProperty(key, before.getPropertyValue(key))
    style.removeProperty('--rainbow-accent'); style.removeProperty('--rainbow-ink')
  }
}

export function startRainbowSync(repaint: () => void): () => void {
  const stop = watchRainbow(p => { mode = p; repaint() })
  return () => { stop(); stopRainbow() }
}
