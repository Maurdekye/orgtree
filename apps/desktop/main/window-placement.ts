import fs from 'node:fs'
import path from 'node:path'

export type Bounds = { x: number; y: number; width: number; height: number }
export type Placement = { bounds: Bounds; maximized: boolean }

function validBounds(value: unknown): value is Bounds {
  if (!value || typeof value !== 'object') return false
  const b = value as Bounds
  return [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0
}

/** Preserve a saved rectangle exactly on its monitor; recover it onto a current
 * work area when a display has gone away or its available area has changed. */
export function fitWindow(bounds: Bounds, areas: Bounds[]): Bounds {
  const intersection = (a: Bounds) => Math.max(0, Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x))
    * Math.max(0, Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y))
  const area = areas.reduce<Bounds | undefined>((best, a) => !best || intersection(a) > intersection(best) ? a : best, undefined)
  if (!area) return bounds
  const width = Math.min(Math.max(640, bounds.width), area.width)
  const height = Math.min(Math.max(480, bounds.height), area.height)
  return { x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)), width, height }
}

export class WindowPlacement {
  private value: Placement | undefined
  constructor(private file: string) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Placement
      if (validBounds(saved.bounds) && typeof saved.maximized === 'boolean') this.value = saved
    } catch { /* First launch or damaged state uses the normal default window. */ }
  }
  restore(areas: Bounds[]): Placement | undefined {
    return this.value && { bounds: fitWindow(this.value.bounds, areas), maximized: this.value.maximized }
  }
  capture(window: { isDestroyed(): boolean; isMinimized(): boolean; isMaximized(): boolean; getNormalBounds(): Bounds }): void {
    // Minimized window coordinates/state are not the user's desired next view.
    if (window.isDestroyed() || window.isMinimized()) return
    const bounds = window.getNormalBounds()
    if (!validBounds(bounds)) return
    const next = { bounds, maximized: window.isMaximized() }
    if (JSON.stringify(next) === JSON.stringify(this.value)) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = this.file + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 })
    fs.renameSync(temp, this.file)
    this.value = next
  }
}
