import type { ActivitySource } from './activity'
import { HeatField, HEAT_FLUX, type HeatPoint } from './heatfield'
import { epicCanvasNow, type EpicWire } from './tap'

/** One low-resolution world-space field beneath the existing card DOM.
 * Its parent owns the camera transform, so camera motion never moves heat
 * between cells. One offscreen texture upload/blit per simulation frame. */
export class SoundHeatmap {
  private canvas: HTMLCanvasElement
  private texture: HTMLCanvasElement
  private space: HTMLElement | null = null
  private field: HeatField | null = null
  private sources: readonly ActivitySource[] = []
  private positions = new Map<string, HeatPoint>()
  private timer = 0
  private last = 0
  private dead = false
  private reduced: MediaQueryList | null = null
  private observer: MutationObserver
  private pulses: { wire: EpicWire; start: number; reverse: boolean }[] = []
  private transport: SVGSVGElement
  private dots: SVGCircleElement[] = []
  constructor(private doc: Document) {
    this.canvas = doc.createElement('canvas')
    this.canvas.className = 'epic-heatmap'
    this.canvas.setAttribute('aria-hidden', 'true')
    this.canvas.style.cssText = 'position:absolute;pointer-events:none;z-index:0;opacity:0.22;image-rendering:auto'
    this.texture = doc.createElement('canvas')
    this.transport = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    this.transport.classList.add('epic-transport')
    this.transport.setAttribute('aria-hidden', 'true')
    this.transport.style.cssText = 'position:absolute;pointer-events:none;z-index:0;opacity:0.45;overflow:visible'
    try { this.reduced = doc.defaultView?.matchMedia('(prefers-reduced-motion: reduce)') ?? null } catch { /* older host */ }
    this.reduced?.addEventListener?.('change', this.motion)
    // Finds a newly mounted/replaced canvas without installing anything off.
    this.observer = new doc.defaultView!.MutationObserver(() => { if (!this.canvas.isConnected || this.reduced?.matches) this.wake() })
    this.observer.observe(doc.body, { childList: true, subtree: true })
  }
  update(sources: readonly ActivitySource[]): void { this.sources = sources; this.wake() }
  impulse(id: string): void {
    if (this.dead || this.reduced?.matches) return
    if (!this.positions.has(id) || !this.canvas.isConnected) this.layout()
    const p = this.positions.get(id)
    if (p) { this.field?.impulse(p); this.wake() }
  }
  clear(): void {
    this.sources = []; this.positions.clear(); this.field = null
    this.pulses = []
    this.dots.forEach(dot => dot.setAttribute('visibility', 'hidden'))
    this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.last = 0
  }
  stop(): void {
    this.dead = true
    this.doc.defaultView?.clearTimeout(this.timer)
    this.observer.disconnect()
    this.reduced?.removeEventListener?.('change', this.motion)
    this.canvas.remove(); this.transport.remove(); this.clear()
  }
  private motion = () => { this.pulses = []; this.field = null; this.wake() }
  /** Short transport pulse along an actual rendered link, never a guessed line. */
  pulse(id: string, other?: string): void {
    if (this.dead || this.reduced?.matches || this.pulses.length >= 24) return
    const wire = epicCanvasNow()?.wires.find(w => w.key === id || (other && w.key === other))
    if (!wire || (wire.frac !== undefined && wire.frac < 1)) return
    this.pulses.push({ wire, start: performance.now(), reverse: wire.key !== id })
    this.wake()
  }
  private wake(): void {
    if (this.dead || this.timer) return
    this.timer = this.doc.defaultView!.setTimeout(this.tick, 1000 / 15)
  }
  private layout(): void {
    const space = this.doc.querySelector<HTMLElement>('.viewport .space')
    if (!space || space.closest('.canvas-world-hidden')) { this.canvas.remove(); this.transport.remove(); this.space = null; return }
    if (space !== this.space) {
      this.space = space; this.field = null; space.prepend(this.canvas, this.transport)
    }
    this.positions.clear()
    let minX = 0, minY = 0, maxX = Math.max(512, parseFloat(space.style.width) || 0), maxY = Math.max(512, parseFloat(space.style.height) || 0)
    const include = (x: number, y: number, w: number, h: number) => {
      minX = Math.min(minX, x - 64); minY = Math.min(minY, y - 64)
      maxX = Math.max(maxX, x + w + 64); maxY = Math.max(maxY, y + h + 64)
    }
    // The full world layout owns both sources and domain. Camera virtualization
    // must never resize/resample the field as edge cards mount or disappear.
    const geometry = epicCanvasNow()
    for (const [id, p] of geometry?.positions ?? []) {
      const size = geometry!.size(id)
      this.positions.set(id, { x: p.x + size.w / 2, y: p.y + size.h / 2 })
      include(p.x, p.y, size.w, size.h)
    }
    for (const card of space.querySelectorAll<HTMLElement>('[data-first-use-agent], .sq[data-copy-agent-name]')) {
      const match = /translate\(\s*([-\d.]+)px,\s*([-\d.]+)px\)/.exec(card.style.transform)
      if (!match) continue
      const x = Number(match[1]), y = Number(match[2])
      const w = parseFloat(card.style.width) || 200, h = parseFloat(card.style.height) || 100
      this.positions.set((card.dataset.firstUseAgent ?? card.dataset.copyAgentName)!, { x: x + w / 2, y: y + h / 2 })
      const id = (card.dataset.firstUseAgent ?? card.dataset.copyAgentName)!
      // DOM-only hosts retain their fallback; mounted dimensions cannot change
      // the domain of cards already covered by the complete canvas geometry.
      if (!geometry?.positions.has(id)) include(x, y, w, h)
    }
    // Quantise the domain so small drag/spring movements do not regrid it.
    minX = Math.floor(minX / 512) * 512; minY = Math.floor(minY / 512) * 512
    maxX = Math.ceil(maxX / 512) * 512; maxY = Math.ceil(maxY / 512) * 512
    const w = maxX - minX, h = maxY - minY
    if (!this.field || this.field.x !== minX || this.field.y !== minY || this.field.width !== w || this.field.height !== h) {
      const field = new HeatField(minX, minY, w, h)
      if (this.field) field.resample(this.field)
      this.field = field
      this.canvas.width = this.texture.width = field.cols
      this.canvas.height = this.texture.height = field.rows
      Object.assign(this.canvas.style, { left: `${minX}px`, top: `${minY}px`, width: `${w}px`, height: `${h}px` })
      Object.assign(this.transport.style, { left: `${minX}px`, top: `${minY}px`, width: `${w}px`, height: `${h}px` })
      this.transport.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`)
    }
  }
  private tick = (): void => {
    this.timer = 0
    if (this.dead) return
    this.layout()
    if (!this.space || !this.field) { this.last = 0; return }
    const points: HeatPoint[] = []
    for (const s of this.sources) {
      const p = this.positions.get(s.id)
      if (p) points.push({ ...p, flux: HEAT_FLUX * (s.layer ? 1 : 0.6) })
    }
    const now = performance.now()
    if (this.reduced?.matches) this.field.equilibrium(points)
    else this.field.advance(this.last ? (now - this.last) / 1000 : 1 / 15, points)
    this.last = now
    if (!points.length && this.field.peak <= 0.001) this.field.values.fill(0)
    this.paint()
    if (!this.reduced?.matches && (points.length || this.field.peak > 0.001 || this.pulses.length)) this.wake()
  }
  private paint(): void {
    const field = this.field!, g = this.texture.getContext('2d'), output = this.canvas.getContext('2d')
    if (!g || !output) return
    const pixels = g.createImageData(field.cols, field.rows)
    for (let i = 0; i < field.values.length; i++) {
      const t = field.values[i]!, p = i * 4
      pixels.data[p] = 255; pixels.data[p + 1] = Math.round(40 + 180 * t)
      pixels.data[p + 2] = Math.round(15 + 35 * t); pixels.data[p + 3] = Math.round(255 * (1 - Math.exp(-18 * t)))
    }
    g.putImageData(pixels, 0, 0)
    output.clearRect(0, 0, field.cols, field.rows)
    output.drawImage(this.texture, 0, 0)
    const now = performance.now()
    this.pulses = this.pulses.filter(p => now - p.start < 500)
    this.dots.forEach(dot => dot.setAttribute('visibility', 'hidden'))
    for (const [i, pulse] of this.pulses.entries()) {
      const t = Math.max(0, Math.min(1, (now - pulse.start) / 500)), u = pulse.reverse ? 1 - t : t
      const pts = pulse.wire.seg.pts, a = pts[0]!, b = pts[pts.length - 1]!
      const v = 1 - u
      const x = pts.length === 2 ? a.x + (b.x - a.x) * u : v ** 3 * a.x + 3 * v * v * u * pts[1]!.x + 3 * v * u * u * pts[2]!.x + u ** 3 * b.x
      const y = pts.length === 2 ? a.y + (b.y - a.y) * u : v ** 3 * a.y + 3 * v * v * u * pts[1]!.y + 3 * v * u * u * pts[2]!.y + u ** 3 * b.y
      let dot = this.dots[i]
      if (!dot) {
        dot = this.doc.createElementNS('http://www.w3.org/2000/svg', 'circle')
        dot.setAttribute('fill', '#ffd79b'); dot.setAttribute('r', '5')
        this.transport.append(dot); this.dots.push(dot)
      }
      dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(y))
      dot.setAttribute('opacity', String(Math.sin(Math.PI * t))); dot.setAttribute('visibility', 'visible')
    }
  }
}
