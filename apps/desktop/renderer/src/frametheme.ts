import { desktop } from './desktop'
import { FRAME_THEME_COLORS, frameColor, frameThemeCss } from '../../../../packages/contracts/frame-theme'
import type { FrameTheme, FrameThemeColor } from '../../../../packages/contracts/frame-theme'

/** The colors HTML presentations and app panels receive (USER 2026-10-27
 *  m4e1fae02a0ca, m164909566caf): the app's own root tokens, resolved after
 *  every override (the light-contrast accent partners, a custom color, the
 *  rainbow's moving accent). Pages get them as CSS variables; see
 *  packages/contracts/frame-theme.ts for the names they read. */
const SOURCE: Record<FrameThemeColor, string> = {
  accent: '--accent', accentHover: '--accent-hover', accentSoft: '--accent-soft', accentText: '--accent-ink',
  bg: '--bg', sidebar: '--side', card: '--panel', hover: '--panel-2', input: '--input',
  text: '--ink', textStrong: '--ink-strong', textDim: '--dim', border: '--line', borderSoft: '--line-soft',
  success: '--ok', danger: '--bad', warning: '--warn',
}
const LIGHT = ['contrast-light', 'contrast-solarized-light']
const CHANGES = ['orgtree:visual-theme-changed', 'orgtree:contrast-changed']
/** The rainbow repaints its accent every frame without an event; pages follow it at this rate. */
const RAINBOW_MS = 250

export interface FrameThemeSheet { theme: FrameTheme; css: string }

let probe: HTMLElement | null = null
/** A token's value as one concrete color: the probe's computed color resolves
 *  color-mix() and relative colors the same way the app's own paint does. */
function resolve(value: string): string | null {
  if (!probe?.isConnected) {
    probe = document.createElement('span')
    probe.hidden = true
    probe.setAttribute('aria-hidden', 'true')
    ;(document.body ?? document.documentElement).appendChild(probe)
  }
  probe.style.color = ''
  probe.style.color = value
  return probe.style.color ? frameColor(getComputedStyle(probe).color) : null
}

export function currentFrameTheme(): FrameTheme {
  const root = document.documentElement, style = getComputedStyle(root), colors: FrameTheme['colors'] = {}
  for (const name of FRAME_THEME_COLORS) {
    const value = style.getPropertyValue(SOURCE[name]).trim()
    const color = value ? resolve(value) : null
    if (color) colors[name] = color
  }
  return { colorScheme: LIGHT.some(name => root.classList.contains(name)) ? 'light' : 'dark', colors }
}

const read = (): FrameThemeSheet => {
  const theme = currentFrameTheme()
  return { theme, css: frameThemeCss(theme) }
}

const listeners = new Set<(sheet: FrameThemeSheet) => void>()
let latest: FrameThemeSheet | null = null
let cycling: ReturnType<typeof setInterval> | undefined

function check(): void {
  const rainbow = document.documentElement.classList.contains('rainbow-theme')
  if (rainbow && cycling === undefined) cycling = setInterval(check, RAINBOW_MS)
  else if (!rainbow && cycling !== undefined) { clearInterval(cycling); cycling = undefined }
  const next = read()
  if (latest && next.css === latest.css) return
  latest = next
  for (const listener of [...listeners]) {
    try { listener(next) } catch { /* one surface must not stop the others */ }
  }
}

/** The colors a page built now starts with. */
export function frameTheme(): FrameThemeSheet {
  return listeners.size && latest ? latest : read()
}

/** Calls `listener` after each change of the colors; never at subscription. */
export function watchFrameTheme(listener: (sheet: FrameThemeSheet) => void): () => void {
  if (!listeners.size) {
    for (const type of CHANGES) window.addEventListener(type, check)
    latest = null
    check()
  }
  listeners.add(listener)
  return () => {
    if (!listeners.delete(listener) || listeners.size) return
    for (const type of CHANGES) window.removeEventListener(type, check)
    if (cycling !== undefined) { clearInterval(cycling); cycling = undefined }
  }
}

/** HTML presentation windows ("Open in a new window") have no app bridge;
 *  native injects these colors into them (main/frametheme.ts). */
export function startFrameThemeSync(): () => void {
  const bridge = desktop()
  if (!bridge?.setFrameTheme) return () => {}
  const push = (sheet: FrameThemeSheet) => {
    try { void bridge.setFrameTheme(sheet.theme).catch(() => {}) } catch { /* old/unavailable bridge */ }
  }
  const stop = watchFrameTheme(push)
  push(frameTheme())
  return stop
}
