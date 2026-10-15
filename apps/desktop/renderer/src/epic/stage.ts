/* EPIC Mode — the picture half: one full-window canvas over everything.

   The stage draws every effect itself: particles, shockwave rings, lightning,
   impact words, ice spikes, stop signs, light beams, cracks, coins, paw
   prints. Nothing here touches the app's own DOM except two deliberate,
   self-reverting Web Animations (`shake` on the app root and `pulse` on one
   element), so React's tree is never edited and nothing is left behind.

   ⚠ FRAMES ONLY WHILE SOMETHING IS ALIVE. The loop is requested when an effect
   is added and stops by itself when the last one dies: an idle organization in
   EPIC Mode costs no frames at all. Every collection is capped (PARTICLE_CAP,
   ACTOR_CAP), and past the cap new particles are simply not born, so a flood
   of events degrades into "very busy" rather than into a stalled window. The
   combo meter (`meter`) is one more thing alive: it fades out when its combo
   drops, and then the loop sleeps again.

   The final EPIC Mode combines four takes; the stage is the Opus take's, with
   the crystal ice spike (Argon), the summoning portal (Astra, Argon), the
   watchdog radar (Astra, Argon), the warning sign and the neon rank titles,
   heat and arena of the combo meter (Astra), its count, ranks and stars
   (Wonder Full, Argon) and the button pop (Wonder Full) added — see
   docs/rust-engine/epic-mode-final.md. */

export const PARTICLE_CAP = 2600
export const ACTOR_CAP = 160
/** The canvas's pixel budget (Astra's take): a full-window canvas costs its
 *  size in every frame, so it renders at most 1.5 device pixels per CSS pixel
 *  and 2.5 million pixels in all. The effects are big and soft; the browser
 *  scales the canvas up to the window. */
export const MAX_DPR = 1.5
export const MAX_PIXELS = 2_500_000

export type ParticleKind = 'glow' | 'streak' | 'shard' | 'confetti' | 'snow' | 'coin' | 'paw' | 'smoke' | 'star'

/** what the combo meter shows; null once the combo has dropped */
export interface ComboReading {
  /** events in the current burst, each within the decay window of the last */
  n: number
  /** the rank that many events earn, and its colour */
  rank: string
  color: string
  /** 1 just after an event, falling to 0 as the combo runs out */
  left: number
  /** 0…1: how hot the arena runs (the combo's size, cooling as it runs out) */
  heat: number
}

interface Particle {
  kind: ParticleKind
  x: number; y: number; vx: number; vy: number
  life: number; max: number
  size: number; grow: number
  rot: number; vr: number
  gravity: number; drag: number
  color: string
  alpha: number
}

/** anything that is not a plain particle: rings, bolts, words, beams … */
interface Actor {
  age: number
  life: number
  /** false when finished early */
  step?(dt: number): boolean | void
  draw(g: CanvasRenderingContext2D, k: number, stage: Stage): void
  /** additive ('lighter') or normal compositing */
  blend?: 'lighter' | 'source-over'
  /** drawn after every glow and particle: words must stay readable */
  top?: boolean
}

export interface BurstOptions {
  count?: number
  colors?: string[]
  speed?: [number, number]
  size?: [number, number]
  life?: [number, number]
  gravity?: number
  drag?: number
  kind?: ParticleKind
  /** emission cone: centre angle and spread in radians (default: all round) */
  angle?: number
  spread?: number
  grow?: number
  /** spawn spread around the point (px) */
  jitter?: number
}

const TAU = Math.PI * 2
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo)
const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!
const easeOutBack = (t: number): number => { const c = 1.9; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2 }
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3

export interface Rect { x: number; y: number; w: number; h: number }

export class Stage {
  readonly canvas: HTMLCanvasElement
  private g: CanvasRenderingContext2D | null
  private view: Window
  private parts: Particle[] = []
  private pool: Particle[] = []
  private actors: Actor[] = []
  /** the combo meter: drawn last, alive until its combo drops (see `meter`) */
  private hud: Actor | null = null
  /** the neon title on screen, if any (see `title`) */
  private titled: Actor | null = null
  private rafId = 0
  private last = 0
  private dpr = 1
  private width = 0
  private height = 0
  private sprites = new Map<string, HTMLCanvasElement>()
  /** 0.25…1: how many of the particles asked for are actually born. A frame
   *  that took too long lowers it, quiet frames raise it back, so a flood of
   *  events thins its sparks instead of stalling the window's main thread. */
  private quality = 1
  private resizeObserver: (() => void) | null = null
  private dead = false
  private shakeAnim: Animation | null = null
  /** the element that shakes: the document's root element. Its box IS the
   *  viewport (html is 100% high), so while its transform makes it the
   *  containing block for fixed-position descendants — dialogs, menus, this
   *  stage — they keep exactly their geometry. #root would not: it is only
   *  min-height 100vh, and in a document where #root is not full-window the
   *  fixed layers inside it collapsed for the length of a shake. */
  shakeTarget: () => HTMLElement | null

  constructor(doc: Document, shakeTarget?: () => HTMLElement | null) {
    this.view = doc.defaultView ?? window
    const c = doc.createElement('canvas')
    c.className = 'epic-stage'
    c.setAttribute('aria-hidden', 'true')
    c.dataset.epic = 'stage'
    // inline as well as in epic.css: a popout document gets the opener's
    // sheets copied in later, and the stage must never catch a click meanwhile
    c.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;'
      + 'pointer-events:none;z-index:2147483000'
    this.canvas = c
    let g: CanvasRenderingContext2D | null = null
    try { g = c.getContext('2d') } catch { g = null }
    this.g = g
    this.shakeTarget = shakeTarget ?? (() => doc.documentElement)
    doc.body.appendChild(c)
    const onResize = () => this.resize()
    this.view.addEventListener('resize', onResize)
    this.resizeObserver = () => this.view.removeEventListener('resize', onResize)
    this.resize()
  }

  get particleCount(): number { return this.parts.length }
  get actorCount(): number { return this.actors.length }
  get size(): { w: number; h: number } { return { w: this.width, h: this.height } }

  private resize(): void {
    const v = this.view
    this.width = v.innerWidth || 1
    this.height = v.innerHeight || 1
    this.dpr = Math.min(MAX_DPR, v.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / (this.width * this.height)))
    this.canvas.width = Math.max(1, Math.floor(this.width * this.dpr))
    this.canvas.height = Math.max(1, Math.floor(this.height * this.dpr))
  }

  /** the canvas's backing size in device pixels, for the budget's test */
  get pixels(): number { return this.canvas.width * this.canvas.height }

  destroy(): void {
    if (this.dead) return
    this.dead = true
    if (this.rafId) this.caf(this.rafId)
    this.rafId = 0
    this.resizeObserver?.()
    this.resizeObserver = null
    try { this.shakeAnim?.cancel() } catch { /* gone */ }
    this.shakeAnim = null
    this.unclip?.()
    this.unclip = null
    this.canvas.remove()
    this.parts = []
    this.pool = []
    this.actors = []
    this.hud = null
    this.sprites.clear()
  }

  /* ── the loop ─────────────────────────────────────────────────────── */

  /* each window animates on its OWN frames: an opener that is minimized has
     its frames suspended while its popped-out windows are still on screen */
  private raf(cb: (now: number) => void): number {
    const v = this.view as Window & { requestAnimationFrame?: Window['requestAnimationFrame'] }
    return typeof v.requestAnimationFrame === 'function' ? v.requestAnimationFrame(cb)
      : globalThis.requestAnimationFrame(cb)
  }
  private caf(id: number): void {
    const v = this.view as Window & { cancelAnimationFrame?: Window['cancelAnimationFrame'] }
    if (typeof v.cancelAnimationFrame === 'function') v.cancelAnimationFrame(id)
    else globalThis.cancelAnimationFrame(id)
  }

  private wake(): void {
    if (this.dead || this.rafId || this.ticking) return
    this.last = 0
    this.rafId = this.raf(this.tick)
  }

  /* ⚠ ONE LOOP. Effects spawn from inside a frame (a firework's rocket, a
     comet's trail, a meteor all burst in their `step`), and a spawn calls
     wake(). Were the frame id already cleared then, that wake would request a
     second frame and the end of this frame a third: loops multiply, every
     effect ages several times too fast and the frame cost explodes. So the
     frame in progress counts as scheduled until it has scheduled its own
     successor. */
  private ticking = false
  private tick = (now: number): void => {
    this.rafId = 0
    if (this.dead) return
    this.ticking = true
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 1 / 60
    this.last = now
    const t0 = performance.now()
    try {
      this.update(dt)
      this.draw()
    } finally { this.ticking = false }
    const spent = performance.now() - t0
    this.quality = spent > 12 ? Math.max(0.25, this.quality * 0.85) : Math.min(1, this.quality + 0.01)
    if (this.dead) return
    if (this.parts.length || this.actors.length || this.hud) this.rafId = this.raf(this.tick)
    else this.clear()
  }

  private clear(): void {
    const g = this.g
    if (!g) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  private update(dt: number): void {
    const parts = this.parts
    let w = 0
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!
      p.life -= dt
      if (p.life <= 0) { this.pool.push(p); continue }
      const drag = p.drag ? Math.exp(-p.drag * dt) : 1
      p.vx *= drag; p.vy = p.vy * drag + p.gravity * dt
      if (p.kind === 'snow') p.vx += Math.sin((p.max - p.life) * 3 + p.rot) * 20 * dt
      p.x += p.vx * dt; p.y += p.vy * dt
      p.rot += p.vr * dt
      p.size = Math.max(0, p.size + p.grow * dt)
      parts[w++] = p
    }
    parts.length = w
    const actors = this.actors
    let a = 0
    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i]!
      actor.age += dt
      const alive = actor.step?.(dt) !== false && actor.age < actor.life
      if (alive) actors[a++] = actor
    }
    actors.length = a
    const hud = this.hud
    if (hud) {
      hud.age += dt
      if (hud.step?.(dt) === false) this.hud = null
    }
  }

  private draw(): void {
    const g = this.g
    if (!g) return
    this.clear()
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    for (const actor of this.actors) {
      if (actor.blend === 'lighter' || actor.top) continue
      g.save(); actor.draw(g, Math.min(1, actor.age / actor.life), this); g.restore()
    }
    g.globalCompositeOperation = 'source-over'
    for (const p of this.parts) if (p.kind !== 'glow' && p.kind !== 'streak') this.drawParticle(g, p)
    g.globalCompositeOperation = 'lighter'
    for (const p of this.parts) if (p.kind === 'glow' || p.kind === 'streak') this.drawParticle(g, p)
    for (const actor of this.actors) {
      if (actor.blend !== 'lighter' || actor.top) continue
      g.save(); actor.draw(g, Math.min(1, actor.age / actor.life), this); g.restore()
    }
    g.globalCompositeOperation = 'source-over'
    g.globalAlpha = 1
    // the words (impact words, their names, rank titles, glyphs) go over every
    // glow and particle: a name washed out by a portal's light says nothing
    for (const actor of this.actors) {
      if (!actor.top) continue
      g.save(); actor.draw(g, Math.min(1, actor.age / actor.life), this); g.restore()
    }
    // the combo meter goes over everything else
    if (this.hud) { g.save(); this.hud.draw(g, 0, this); g.restore() }
  }

  /** a soft radial glow, rendered once per colour and stamped thereafter */
  sprite(color: string): HTMLCanvasElement {
    let s = this.sprites.get(color)
    if (s) return s
    s = this.canvas.ownerDocument.createElement('canvas')
    s.width = s.height = 64
    const g = s.getContext('2d')
    if (g) {
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
      grad.addColorStop(0, 'rgba(255,255,255,1)')
      grad.addColorStop(0.22, color)
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = grad
      g.fillRect(0, 0, 64, 64)
    }
    this.sprites.set(color, s)
    return s
  }

  private drawParticle(g: CanvasRenderingContext2D, p: Particle): void {
    const k = p.life / p.max
    const a = Math.max(0, Math.min(1, p.alpha * (k < 0.3 ? k / 0.3 : 1)))
    if (a <= 0.01 || p.size <= 0.1) return
    g.globalAlpha = a
    switch (p.kind) {
      case 'glow': {
        const s = p.size * 2
        g.drawImage(this.sprite(p.color), p.x - s / 2, p.y - s / 2, s, s)
        break
      }
      case 'streak': {
        g.strokeStyle = p.color
        g.lineWidth = Math.max(1, p.size * 0.35)
        g.lineCap = 'round'
        g.beginPath()
        g.moveTo(p.x, p.y)
        g.lineTo(p.x - p.vx * 0.045, p.y - p.vy * 0.045)
        g.stroke()
        break
      }
      case 'shard': {
        g.save(); g.translate(p.x, p.y); g.rotate(p.rot)
        g.fillStyle = p.color
        g.beginPath()
        g.moveTo(0, -p.size); g.lineTo(p.size * 0.35, p.size * 0.5); g.lineTo(-p.size * 0.35, p.size * 0.5)
        g.closePath(); g.fill()
        g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 0.8; g.stroke()
        g.restore()
        break
      }
      case 'confetti': {
        g.save(); g.translate(p.x, p.y); g.rotate(p.rot)
        g.scale(1, Math.cos(p.rot * 2.3))
        g.fillStyle = p.color
        g.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2)
        g.restore()
        break
      }
      case 'star': {
        g.save(); g.translate(p.x, p.y); g.rotate(p.rot)
        g.fillStyle = p.color
        starPath(g, p.size)
        g.fill()
        g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1; g.stroke()
        g.restore()
        break
      }
      case 'snow': {
        g.save(); g.translate(p.x, p.y); g.rotate(p.rot)
        g.strokeStyle = p.color; g.lineWidth = 1.2; g.lineCap = 'round'
        for (let i = 0; i < 6; i++) {
          g.rotate(TAU / 6)
          g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -p.size)
          g.moveTo(0, -p.size * 0.55); g.lineTo(p.size * 0.25, -p.size * 0.8)
          g.moveTo(0, -p.size * 0.55); g.lineTo(-p.size * 0.25, -p.size * 0.8)
          g.stroke()
        }
        g.restore()
        break
      }
      case 'coin': {
        g.save(); g.translate(p.x, p.y)
        const squash = Math.abs(Math.cos(p.rot))
        g.scale(Math.max(0.12, squash), 1)
        g.fillStyle = '#f5c518'
        g.beginPath(); g.arc(0, 0, p.size, 0, TAU); g.fill()
        g.strokeStyle = '#a87b00'; g.lineWidth = 2; g.stroke()
        g.fillStyle = '#fff3a8'
        g.beginPath(); g.arc(-p.size * 0.3, -p.size * 0.3, p.size * 0.28, 0, TAU); g.fill()
        g.restore()
        break
      }
      case 'paw': {
        g.save(); g.translate(p.x, p.y); g.rotate(p.rot)
        g.fillStyle = p.color
        const s = p.size
        g.beginPath(); g.ellipse(0, s * 0.35, s * 0.55, s * 0.45, 0, 0, TAU); g.fill()
        for (const [x, y] of [[-0.55, -0.25], [-0.2, -0.6], [0.2, -0.6], [0.55, -0.25]] as const) {
          g.beginPath(); g.ellipse(x * s, y * s, s * 0.2, s * 0.26, 0, 0, TAU); g.fill()
        }
        g.restore()
        break
      }
      case 'smoke': {
        const s = p.size * 2
        g.globalAlpha = a * 0.5
        g.drawImage(this.sprite(p.color), p.x - s / 2, p.y - s / 2, s, s)
        break
      }
    }
  }

  /* ── spawning ─────────────────────────────────────────────────────── */

  private particle(): Particle | null {
    if (this.parts.length >= PARTICLE_CAP) return null
    const p = this.pool.pop() ?? {
      kind: 'glow', x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 0, size: 0, grow: 0,
      rot: 0, vr: 0, gravity: 0, drag: 0, color: '#fff', alpha: 1,
    } as Particle
    this.parts.push(p)
    return p
  }

  /** a hidden window draws nothing: no frames would show it anyway, and its
   *  effects must not pile up and replay when it is shown again */
  private get idle(): boolean {
    return this.dead || this.canvas.ownerDocument.visibilityState === 'hidden'
  }

  burst(x: number, y: number, o: BurstOptions = {}): void {
    if (this.idle) return
    const count = Math.ceil((o.count ?? 40) * this.quality)
    const colors = o.colors ?? ['#ffd34d', '#ff7a1a', '#ffffff']
    const [s0, s1] = o.speed ?? [120, 520]
    const [z0, z1] = o.size ?? [3, 9]
    const [l0, l1] = o.life ?? [0.5, 1.2]
    for (let i = 0; i < count; i++) {
      const p = this.particle()
      if (!p) break
      const angle = o.angle === undefined ? rand(0, TAU) : o.angle + rand(-(o.spread ?? TAU) / 2, (o.spread ?? TAU) / 2)
      const speed = rand(s0, s1)
      p.kind = o.kind ?? 'glow'
      p.x = x + (o.jitter ? rand(-o.jitter, o.jitter) : 0)
      p.y = y + (o.jitter ? rand(-o.jitter, o.jitter) : 0)
      p.vx = Math.cos(angle) * speed
      p.vy = Math.sin(angle) * speed
      p.max = p.life = rand(l0, l1)
      p.size = rand(z0, z1)
      p.grow = o.grow ?? 0
      p.rot = rand(0, TAU)
      p.vr = rand(-8, 8)
      p.gravity = o.gravity ?? 0
      p.drag = o.drag ?? 1.6
      p.color = pick(colors)
      p.alpha = 1
    }
    this.wake()
  }

  private add(actor: Actor): void {
    if (this.idle || this.actors.length >= ACTOR_CAP) return
    this.actors.push(actor)
    this.wake()
  }

  /** an expanding shockwave ring */
  ring(x: number, y: number, o: { color?: string; radius?: number; width?: number; life?: number; delay?: number } = {}): void {
    const color = o.color ?? '#ffffff'
    const radius = o.radius ?? 140
    const width = o.width ?? 6
    const delay = o.delay ?? 0
    this.add({
      age: -delay, life: (o.life ?? 0.6),
      blend: 'lighter',
      draw(g, k) {
        if (k <= 0) return
        const e = easeOutCubic(k)
        g.globalAlpha = (1 - k) * 0.9
        g.strokeStyle = color
        g.lineWidth = width * (1 - k * 0.7)
        g.beginPath(); g.arc(x, y, 6 + radius * e, 0, TAU); g.stroke()
      },
    })
  }

  /** lightning between two points, re-forking as it flickers */
  bolt(x1: number, y1: number, x2: number, y2: number,
    o: { color?: string; life?: number; width?: number; branches?: number } = {}): void {
    const color = o.color ?? '#9fd8ff'
    const width = o.width ?? 3
    const branches = o.branches ?? 2
    let path = lightning(x1, y1, x2, y2, 5)
    let forks = Array.from({ length: branches }, () => fork(path))
    let since = 0
    this.add({
      age: 0, life: o.life ?? 0.35,
      blend: 'lighter',
      step(dt) {
        since += dt
        if (since > 0.05) { since = 0; path = lightning(x1, y1, x2, y2, 5); forks = Array.from({ length: branches }, () => fork(path)) }
      },
      draw(g, k) {
        const a = k < 0.7 ? 1 : (1 - k) / 0.3
        for (const [w, alpha, stroke] of [[width * 5, 0.18, color], [width * 2, 0.5, color], [width * 0.7, 1, '#ffffff']] as const) {
          g.globalAlpha = alpha * a
          g.strokeStyle = stroke
          g.lineWidth = w
          g.lineJoin = 'round'; g.lineCap = 'round'
          strokePath(g, path)
          for (const f of forks) strokePath(g, f)
        }
      },
    })
  }

  /** a comet travelling from one point to another, sparking as it goes */
  comet(x1: number, y1: number, x2: number, y2: number,
    o: { color?: string; duration?: number; arc?: number; onArrive?: () => void } = {}): void {
    const color = o.color ?? '#ffe066'
    const duration = o.duration ?? 0.45
    const bend = o.arc ?? rand(-0.35, 0.35)
    const mx = (x1 + x2) / 2 - (y2 - y1) * bend
    const my = (y1 + y2) / 2 + (x2 - x1) * bend
    let arrived = false
    const stage = this
    this.add({
      age: 0, life: duration,
      blend: 'lighter',
      step() {
        const k = Math.min(1, this.age / duration)
        const [x, y] = quad(x1, y1, mx, my, x2, y2, k)
        stage.burst(x, y, { count: 2, colors: [color, '#ffffff'], speed: [10, 80], size: [3, 6], life: [0.2, 0.45] })
        if (k >= 1 && !arrived) { arrived = true; o.onArrive?.() }
      },
      draw(g, k) {
        const [x, y] = quad(x1, y1, mx, my, x2, y2, k)
        const s = 26
        g.globalAlpha = 1
        g.drawImage(stage.sprite(color), x - s, y - s, s * 2, s * 2)
      },
    })
  }

  /** a huge impact word: slams in oversized, settles, then floats away. A
   *  `caption` (who it happened to: the Argon and Astra takes name the agent)
   *  rides under it in small capitals. */
  word(x: number, y: number, text: string,
    o: { color?: string; ink?: string; size?: number; life?: number; tilt?: number; caption?: string } = {}): void {
    const color = o.color ?? '#ffdd33'
    const ink = o.ink ?? '#1a0d00'
    const size = o.size ?? 54
    const tilt = o.tilt ?? rand(-0.14, 0.14)
    const life = o.life ?? 1.25
    const caption = captionText(o.caption)
    this.add({
      age: 0, life, top: true,
      draw(g, k, stage) {
        const t = this.age
        const scale = t < 0.18 ? 2.4 - 1.4 * easeOutBack(t / 0.18) : 1 + (t - 0.18) * 0.08
        const fade = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1
        const lift = k > 0.55 ? (k - 0.55) * 60 : 0
        const { w } = stage.size
        const px = Math.max(size * 2, Math.min(w - size * 2, x))
        const py = Math.max(size, y - lift)
        g.translate(px, py)
        g.rotate(tilt)
        g.scale(scale, scale)
        g.globalAlpha = Math.max(0, fade)
        g.font = `900 ${size}px ${IMPACT}`
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.lineJoin = 'round'
        g.lineWidth = size * 0.16
        g.strokeStyle = ink
        g.strokeText(text, 0, 0)
        const grad = g.createLinearGradient(0, -size / 2, 0, size / 2)
        grad.addColorStop(0, '#ffffff')
        grad.addColorStop(0.45, color)
        grad.addColorStop(1, shade(color))
        g.fillStyle = grad
        g.fillText(text, 0, 0)
        if (caption) drawCaption(g, caption, size * 0.82, Math.max(13, size * 0.36), ink)
      },
    })
  }

  /** a big neon title across the middle of the window, split into magenta and
   *  cyan ghosts (the Astra take's OVERDRIVE): the combo's new rank. One title
   *  at a time: a new one ends the one before, or two ranks reached in one
   *  burst would print over each other */
  title(text: string, o: { caption?: string; color?: string; life?: number } = {}): void {
    const color = o.color ?? '#ff4fd8'
    const life = o.life ?? 2.1
    const caption = captionText(o.caption)
    if (this.titled) this.titled.life = Math.min(this.titled.life, this.titled.age)
    this.add(this.titled = {
      age: 0, life, top: true,
      draw(g, k, stage) {
        const { w, h } = stage.size
        const size = Math.min(96, w / Math.max(7, text.length * 0.62))
        const t = this.age
        const pop = t < 0.16 ? 2.2 - 1.2 * easeOutBack(t / 0.16) : 1 + (t - 0.16) * 0.05
        const fade = k > 0.72 ? 1 - (k - 0.72) / 0.28 : 1
        const jitter = (1 - k) * 4
        g.translate(w / 2, h * 0.3)
        g.scale(pop, pop)
        g.globalAlpha = Math.max(0, fade)
        g.font = `900 ${size}px ${IMPACT}`
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.shadowColor = color
        g.shadowBlur = 26
        g.fillStyle = '#ff3dd0'
        g.fillText(text, -3 - jitter * Math.sin(t * 50), 1)
        g.fillStyle = '#48f2ff'
        g.fillText(text, 3 + jitter * Math.sin(t * 43), -1)
        g.shadowBlur = 0
        g.lineJoin = 'round'
        g.lineWidth = size * 0.08
        g.strokeStyle = 'rgba(20,0,30,0.85)'
        g.strokeText(text, 0, 0)
        g.fillStyle = '#ffffff'
        g.fillText(text, 0, 0)
        if (caption) drawCaption(g, caption, size * 0.8, Math.max(14, size * 0.3), '#2a0030')
      },
    })
  }

  /** the whole window flashes a colour */
  flash(color: string, strength = 0.45, life = 0.35): void {
    this.add({
      age: 0, life,
      draw(g, k, stage) {
        g.globalAlpha = strength * (1 - k) ** 2
        g.fillStyle = color
        const { w, h } = stage.size
        g.fillRect(0, 0, w, h)
      },
    })
  }

  /** URGENT MAIL (user 2026-10-15: "a massive blaring alarm that tints and
   *  fades the entire screen"): the whole window tinted, deepest at its edges
   *  so the middle stays readable, under a banner. Both rise and fall in
   *  slow, smooth pulses, one every `period` seconds and never faster than
   *  0.4 s, so it is never a strobe. It lasts `life` seconds, fading out over
   *  the last 0.8, or starts fading out at once on `end()`. */
  alarm(o: { color?: string; period?: number; life?: number; strength?: number; text?: string; caption?: string } = {}): { end(): void } {
    const color = o.color ?? '#ff2a2a'
    const period = Math.max(0.4, o.period ?? 0.8)
    const strength = o.strength ?? 0.34
    const text = o.text ?? 'URGENT MAIL!'
    const caption = captionText(o.caption)
    const FADE = 0.8
    /** in over 0.2 s, out over the last FADE */
    const shown = (a: Actor): number => Math.max(0, Math.min(1, a.age / 0.2, (a.life - a.age) / FADE))
    /** 0 → 1 → 0 once a period, smoothly */
    const wave = (a: Actor): number => 0.5 - 0.5 * Math.cos((2 * Math.PI * a.age) / period)
    const tint: Actor = {
      age: 0, life: o.life ?? 8,
      draw(g, _k, stage) {
        const { w, h } = stage.size
        const edges = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.hypot(w, h) / 2)
        edges.addColorStop(0, color + '59')
        edges.addColorStop(1, color)
        g.globalAlpha = strength * shown(this) * (0.3 + 0.7 * wave(this))
        g.fillStyle = edges
        g.fillRect(0, 0, w, h)
      },
    }
    const banner: Actor = {
      age: 0, life: tint.life, top: true,
      draw(g, _k, stage) {
        const { w, h } = stage.size
        const size = Math.min(84, w / Math.max(7, text.length * 0.62))
        const beat = wave(this)
        g.translate(w / 2, h * 0.2)
        g.scale(1 + 0.06 * beat, 1 + 0.06 * beat)
        g.globalAlpha = shown(this) * (0.6 + 0.4 * beat)
        g.font = `900 ${size}px ${IMPACT}`
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.shadowColor = color
        g.shadowBlur = 30
        g.lineJoin = 'round'
        g.lineWidth = size * 0.1
        g.strokeStyle = 'rgba(40,0,0,0.9)'
        g.strokeText(text, 0, 0)
        g.fillStyle = '#ffffff'
        g.fillText(text, 0, 0)
        g.shadowBlur = 0
        if (caption) drawCaption(g, caption, size * 0.8, Math.max(14, size * 0.3), '#300000')
      },
    }
    this.add(tint)
    this.add(banner)
    return { end: () => { for (const a of [tint, banner]) a.life = Math.min(a.life, a.age + FADE) } }
  }

  /** a column of light from the top of the window down onto a point */
  beam(x: number, y: number, o: { color?: string; width?: number; life?: number } = {}): void {
    const color = o.color ?? '#fff3b0'
    const width = o.width ?? 120
    this.add({
      age: 0, life: o.life ?? 1.2,
      blend: 'lighter',
      draw(g, k, stage) {
        const open = k < 0.15 ? k / 0.15 : 1
        const fade = k > 0.5 ? 1 - (k - 0.5) / 0.5 : 1
        const w = width * open * (0.6 + 0.4 * Math.sin(k * 40) ** 2)
        const grad = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0)
        grad.addColorStop(0, 'rgba(255,255,255,0)')
        grad.addColorStop(0.5, color)
        grad.addColorStop(1, 'rgba(255,255,255,0)')
        g.globalAlpha = fade * 0.85
        g.fillStyle = grad
        g.fillRect(x - w / 2, 0, w, y)
        // where the beam lands, a pool of light
        const s = width * 1.6 * open
        g.globalAlpha = fade
        g.drawImage(stage.sprite(color), x - s / 2, y - s / 2, s, s)
      },
    })
    this.burst(x, y, { count: 60, colors: [color, '#ffffff'], speed: [60, 360], size: [3, 8], life: [0.6, 1.4], gravity: -60 })
  }

  /** ice spikes erupting from a point, then shattering into shards */
  spikes(x: number, y: number, o: { count?: number; length?: number; color?: string } = {}): void {
    const count = o.count ?? 11
    const length = o.length ?? 120
    const color = o.color ?? '#bfefff'
    const spikes = Array.from({ length: count }, (_, i) => ({
      angle: (i / count) * TAU + rand(-0.2, 0.2),
      length: length * rand(0.55, 1.15),
      width: rand(9, 18),
    }))
    const stage = this
    let shattered = false
    this.add({
      age: 0, life: 1.1,
      step() {
        if (!shattered && this.age > 0.75) {
          shattered = true
          for (const s of spikes) {
            const tx = x + Math.cos(s.angle) * s.length * 0.7
            const ty = y + Math.sin(s.angle) * s.length * 0.7
            stage.burst(tx, ty, { count: 5, kind: 'shard', colors: [color, '#ffffff', '#8fd3ff'],
              speed: [60, 260], size: [5, 11], life: [0.5, 1], gravity: 520, drag: 0.6 })
          }
        }
      },
      draw(g, k) {
        const grow = easeOutBack(Math.min(1, this.age / 0.22))
        const fade = shattered ? 0 : 1
        if (!fade) return
        for (const s of spikes) {
          const len = s.length * grow
          g.save()
          g.translate(x, y)
          g.rotate(s.angle)
          const grad = g.createLinearGradient(0, 0, len, 0)
          grad.addColorStop(0, 'rgba(120,200,255,0.95)')
          grad.addColorStop(0.6, color)
          grad.addColorStop(1, '#ffffff')
          g.fillStyle = grad
          g.globalAlpha = 0.92
          g.beginPath()
          g.moveTo(0, -s.width / 2); g.lineTo(len, 0); g.lineTo(0, s.width / 2)
          g.closePath(); g.fill()
          g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1.2; g.stroke()
          g.globalAlpha = 0.5
          g.beginPath(); g.moveTo(0, 0); g.lineTo(len * 0.9, 0); g.stroke()
          g.restore()
        }
        void k
      },
    })
  }

  /** The Argon take's ice spike: a crown of faceted crystals erupting
   *  upward from `y` (the foot of a card), glowing, ringed with frost, then
   *  shattering into falling shards. */
  crystal(x: number, y: number, o: { size?: number; life?: number } = {}): void {
    const u = (o.size ?? 160) / 180
    const life = o.life ?? 1.25
    const breakAt = life - 0.1
    const stage = this
    let shattered = false
    this.add({
      age: 0, life,
      step() {
        if (shattered || this.age < breakAt) return
        shattered = true
        for (const shape of CRYSTAL) {
          const [cx, cy] = centroid(shape.points)
          stage.burst(x + cx * u, y + cy * u, { count: 7, kind: 'shard', colors: ['#e1f5fe', '#80d8ff', '#40c4ff', '#ffffff'],
            speed: [80, 300], size: [5, 12], life: [0.5, 1.1], gravity: 640, drag: 0.5 })
        }
        stage.burst(x, y - 90 * u, { count: 24, colors: ['#ffffff', '#bfefff'], speed: [60, 260], size: [3, 6], life: [0.3, 0.7] })
      },
      draw(g) {
        if (shattered) return
        const t = this.age
        const rise = Math.min(1, t / 0.26)
        const sy = 0.1 + 0.9 * easeOutBack(rise)
        const sx = 0.4 + 0.6 * easeOutCubic(rise)
        g.translate(x, y)
        g.scale(u * sx, u * sy)
        g.globalAlpha = 0.95
        g.shadowColor = 'rgba(64,196,255,0.85)'
        g.shadowBlur = 18
        g.lineJoin = 'round'
        for (const shape of CRYSTAL) {
          g.beginPath()
          shape.points.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)))
          g.closePath()
          if (shape.fill === 'core') {
            const grad = g.createLinearGradient(0, -177, 0, 0)
            grad.addColorStop(0, 'rgba(255,255,255,0.96)')
            grad.addColorStop(0.45, 'rgba(128,216,255,0.88)')
            grad.addColorStop(1, 'rgba(0,145,234,0.78)')
            g.fillStyle = grad
          } else g.fillStyle = shape.fill
          g.fill()
          g.strokeStyle = shape.edge
          g.lineWidth = shape.width
          g.stroke()
        }
        g.shadowBlur = 0
        // the light running down the tallest facet, and the frost ring
        g.globalAlpha = 0.6 + 0.35 * Math.sin(t * 14)
        g.strokeStyle = '#ffffff'; g.lineWidth = 2
        g.beginPath(); g.moveTo(0, -173); g.lineTo(-4, -70); g.lineTo(4, -5); g.stroke()
        g.globalAlpha = 0.85
        g.setLineDash([8, 6])
        g.lineDashOffset = -t * 40
        g.strokeStyle = '#80d8ff'; g.lineWidth = 2.5
        g.beginPath(); g.arc(0, -40, 56 + rise * 14, 0, TAU); g.stroke()
        g.setLineDash([])
      },
    })
  }

  /** a stop sign slammed down at a point; `caption` names who was stopped */
  stopSign(x: number, y: number, o: { size?: number; life?: number; caption?: string } = {}): void {
    const size = o.size ?? 64
    const caption = captionText(o.caption)
    this.add({
      age: 0, life: o.life ?? 1.3,
      draw(g, k) {
        const t = this.age
        const scale = t < 0.14 ? 3.2 - 2.2 * easeOutCubic(t / 0.14) : 1 + Math.sin(Math.min(1, (t - 0.14) / 0.25) * Math.PI) * 0.08
        const fade = k > 0.72 ? 1 - (k - 0.72) / 0.28 : 1
        g.translate(x, y)
        g.rotate(-0.08)
        g.scale(scale, scale)
        g.globalAlpha = Math.max(0, fade)
        octagon(g, size)
        g.fillStyle = '#ffffff'; g.fill()
        octagon(g, size * 0.88)
        g.fillStyle = '#d7191c'; g.fill()
        octagon(g, size * 0.8)
        g.strokeStyle = '#ffffff'; g.lineWidth = size * 0.04; g.stroke()
        g.fillStyle = '#ffffff'
        g.font = `900 ${size * 0.5}px "Segoe UI Black", "Arial Black", Impact, sans-serif`
        g.textAlign = 'center'; g.textBaseline = 'middle'
        g.fillText('STOP', 0, size * 0.03)
        if (caption) drawCaption(g, caption, size * 1.32, Math.max(14, size * 0.3), '#2a0000')
      },
    })
  }

  /** radial cracks across the glass of the window */
  cracks(x: number, y: number, o: { count?: number; length?: number; life?: number } = {}): void {
    const lines: [number, number][][] = []
    const count = o.count ?? 9
    for (let i = 0; i < count; i++) {
      const pts: [number, number][] = [[x, y]]
      let angle = (i / count) * TAU + rand(-0.3, 0.3)
      let px = x, py = y
      const len = (o.length ?? 220) * rand(0.5, 1.2)
      for (let d = 0; d < len; d += rand(14, 34)) {
        angle += rand(-0.35, 0.35)
        px += Math.cos(angle) * rand(14, 34)
        py += Math.sin(angle) * rand(14, 34)
        pts.push([px, py])
      }
      lines.push(pts)
    }
    this.add({
      age: 0, life: o.life ?? 1.6,
      draw(g, k) {
        const grow = Math.min(1, this.age / 0.12)
        g.globalAlpha = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1
        for (const [w, color] of [[3, 'rgba(0,0,0,0.45)'], [1.2, 'rgba(255,255,255,0.95)']] as const) {
          g.strokeStyle = color; g.lineWidth = w; g.lineJoin = 'round'
          for (const pts of lines) {
            const n = Math.max(2, Math.ceil(pts.length * grow))
            g.beginPath()
            pts.slice(0, n).forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)))
            g.stroke()
          }
        }
      },
    })
  }

  /** a glowing frame pulsing around a rectangle (an agent card, a control) */
  frame(r: Rect, o: { color?: string; life?: number; pad?: number; width?: number } = {}): void {
    const color = o.color ?? '#ffd34d'
    const pad = o.pad ?? 6
    const width = o.width ?? 4
    this.add({
      age: 0, life: o.life ?? 0.9,
      blend: 'lighter',
      draw(g, k) {
        const grow = pad + easeOutCubic(k) * 18
        g.globalAlpha = (1 - k) * 0.95
        g.strokeStyle = color
        g.lineWidth = width * (1 - k * 0.5)
        roundRect(g, r.x - grow, r.y - grow, r.w + grow * 2, r.h + grow * 2, 12)
        g.stroke()
      },
    })
  }

  /** a translucent slab of ice over a rectangle, frosting over and melting */
  iceBlock(r: Rect, life = 2.2): void {
    const cracks = Array.from({ length: 6 }, () => {
      const sx = r.x + rand(0, r.w), sy = r.y + rand(0, r.h)
      return [[sx, sy], [sx + rand(-40, 40), sy + rand(-30, 30)], [sx + rand(-70, 70), sy + rand(-50, 50)]] as [number, number][]
    })
    this.add({
      age: 0, life,
      draw(g, k) {
        const grow = Math.min(1, this.age / 0.25)
        const fade = k > 0.65 ? 1 - (k - 0.65) / 0.35 : 1
        const pad = 10
        g.globalAlpha = 0.62 * fade * grow
        const grad = g.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h)
        grad.addColorStop(0, 'rgba(220,248,255,0.95)')
        grad.addColorStop(0.5, 'rgba(140,210,255,0.6)')
        grad.addColorStop(1, 'rgba(200,240,255,0.9)')
        g.fillStyle = grad
        roundRect(g, r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, 10)
        g.fill()
        g.globalAlpha = fade * grow
        g.strokeStyle = 'rgba(255,255,255,0.95)'
        g.lineWidth = 2
        g.stroke()
        g.lineWidth = 1
        g.strokeStyle = 'rgba(255,255,255,0.8)'
        for (const pts of cracks) {
          g.beginPath()
          pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)))
          g.stroke()
        }
      },
    })
  }

  /** particles spiralling into (or out of) a point */
  vortex(x: number, y: number, o: { color?: string; inward?: boolean; life?: number; radius?: number } = {}): void {
    const color = o.color ?? '#c58bff'
    const inward = o.inward ?? true
    const radius = o.radius ?? 110
    const arms = Array.from({ length: 36 }, (_, i) => ({ a: (i / 36) * TAU, r: rand(0.6, 1) }))
    const stage = this
    this.add({
      age: 0, life: o.life ?? 0.7,
      blend: 'lighter',
      draw(g, k) {
        const t = inward ? 1 - k : k
        for (const arm of arms) {
          const a = arm.a + k * 7
          const r = radius * arm.r * t
          const s = 14 * (1 - k * 0.5)
          g.globalAlpha = 1 - k * 0.6
          g.drawImage(stage.sprite(color), x + Math.cos(a) * r - s / 2, y + Math.sin(a) * r - s / 2, s, s)
        }
      },
    })
  }

  /** a firework: a rocket climbs, then bursts in coloured stars */
  firework(x: number, y: number, o: { colors?: string[]; height?: number } = {}): void {
    const colors = o.colors ?? [pick(FIREWORK), pick(FIREWORK)]
    const height = o.height ?? rand(140, 260)
    const stage = this
    let burst = false
    this.add({
      age: 0, life: 0.55,
      blend: 'lighter',
      step() {
        const k = Math.min(1, this.age / 0.5)
        const py = y - height * easeOutCubic(k)
        stage.burst(x, py, { count: 2, colors: ['#ffd9a0'], speed: [10, 60], size: [2, 4], life: [0.2, 0.4], gravity: 200 })
        if (k >= 1 && !burst) {
          burst = true
          stage.burst(x, py, { count: 90, colors, speed: [80, 360], size: [3, 7], life: [0.8, 1.6], gravity: 160, drag: 1.2 })
          stage.burst(x, py, { count: 30, kind: 'streak', colors: ['#ffffff', ...colors], speed: [200, 480], size: [4, 7], life: [0.3, 0.6], drag: 2.2 })
          stage.ring(x, py, { color: colors[0], radius: 110, life: 0.5 })
        }
      },
      draw() { /* the trail is particles */ },
    })
  }

  /** a meteor streaking in from the top corner and exploding on a point */
  meteor(x: number, y: number, o: { color?: string; onImpact?: () => void } = {}): void {
    const fromX = x + (x > this.width / 2 ? -1 : 1) * rand(260, 420)
    const fromY = -40
    const color = o.color ?? '#ff8a2a'
    const stage = this
    let hit = false
    this.add({
      age: 0, life: 0.42,
      blend: 'lighter',
      step() {
        const k = Math.min(1, this.age / 0.4)
        const px = fromX + (x - fromX) * k, py = fromY + (y - fromY) * k
        stage.burst(px, py, { count: 4, colors: [color, '#ffd34d', '#ffffff'], speed: [20, 120], size: [4, 10], life: [0.25, 0.6] })
        stage.burst(px, py, { count: 1, kind: 'smoke', colors: ['#6b6b6b'], speed: [5, 30], size: [14, 22], life: [0.6, 1.1], grow: 30 })
        if (k >= 1 && !hit) { hit = true; o.onImpact?.() }
      },
      draw() { /* all particles */ },
    })
  }

  /** a big glyph (“?”, “!”, a check mark) that pulses at a point */
  glyph(x: number, y: number, text: string, o: { color?: string; size?: number; life?: number } = {}): void {
    const color = o.color ?? '#ffffff'
    const size = o.size ?? 90
    this.add({
      age: 0, life: o.life ?? 1.4, top: true,
      draw(g, k) {
        const pulse = 1 + Math.sin(this.age * 18) * 0.06 * (1 - k)
        const pop = Math.min(1, easeOutBack(Math.min(1, this.age / 0.2)))
        g.translate(x, y)
        g.scale(pop * pulse, pop * pulse)
        g.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1
        g.font = `900 ${size}px "Segoe UI Black", "Arial Black", Impact, sans-serif`
        g.textAlign = 'center'; g.textBaseline = 'middle'
        g.lineWidth = size * 0.12; g.lineJoin = 'round'
        g.strokeStyle = 'rgba(0,0,0,0.75)'
        g.strokeText(text, 0, 0)
        g.fillStyle = color
        g.fillText(text, 0, 0)
      },
    })
  }

  /** a gear spinning up and fading — tools and settings */
  gear(x: number, y: number, o: { color?: string; size?: number; life?: number } = {}): void {
    const color = o.color ?? '#c9d6e3'
    const size = o.size ?? 26
    this.add({
      age: 0, life: o.life ?? 0.7,
      draw(g, k) {
        g.translate(x, y)
        g.rotate(this.age * 9)
        g.globalAlpha = 1 - k
        const s = size * (0.6 + easeOutBack(Math.min(1, this.age / 0.15)) * 0.4)
        g.fillStyle = color
        g.strokeStyle = 'rgba(0,0,0,0.6)'
        g.lineWidth = 2
        g.beginPath()
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * TAU
          const r = i % 2 ? s : s * 0.78
          g.lineTo(Math.cos(a) * r, Math.sin(a) * r)
        }
        g.closePath(); g.fill(); g.stroke()
        g.globalCompositeOperation = 'destination-out'
        g.beginPath(); g.arc(0, 0, s * 0.3, 0, TAU); g.fill()
      },
    })
  }

  /** weather over the whole window: confetti, snow or coins falling */
  rain(kind: 'confetti' | 'snow' | 'coin' | 'glow', o: { count?: number; colors?: string[] } = {}): void {
    if (this.idle) return
    const count = Math.ceil((o.count ?? 120) * this.quality)
    const colors = o.colors ?? (kind === 'snow' ? ['#ffffff', '#dff6ff'] : kind === 'coin' ? ['#f5c518'] : CONFETTI)
    for (let i = 0; i < count; i++) {
      const p = this.particle()
      if (!p) break
      p.kind = kind
      p.x = rand(0, this.width)
      p.y = rand(-this.height * 0.6, -10)
      p.vx = rand(-40, 40)
      p.vy = rand(80, 220)
      p.max = p.life = rand(2.2, 3.6)
      p.size = kind === 'coin' ? rand(7, 11) : kind === 'snow' ? rand(5, 9) : rand(7, 13)
      p.grow = 0
      p.rot = rand(0, TAU)
      p.vr = rand(-6, 6)
      p.gravity = kind === 'snow' ? 10 : 140
      p.drag = 0.3
      p.color = pick(colors)
      p.alpha = 1
    }
    this.wake()
  }

  /** the lights browning out: a few uneven dark flickers over the window */
  flicker(life = 0.9): void {
    const dips = Array.from({ length: 5 }, () => [rand(0, 0.85), rand(0.04, 0.1), rand(0.25, 0.55)] as const)
    this.add({
      age: 0, life,
      draw(g, k, stage) {
        const t = k * life
        let dark = 0
        for (const [at, len, depth] of dips) if (t >= at && t <= at + len) dark = Math.max(dark, depth)
        if (!dark) return
        g.globalAlpha = dark
        g.fillStyle = '#000'
        const { w, h } = stage.size
        g.fillRect(0, 0, w, h)
      },
    })
  }

  /** an old picture tube switching off: the image collapses to a line, then
   *  to a dot, then to nothing */
  crt(life = 0.95): void {
    this.add({
      age: 0, life,
      draw(g, k, stage) {
        const { w, h } = stage.size
        const cx = w / 2, cy = h / 2
        // the screen goes dark around a shrinking bright band
        const v = k < 0.45 ? 1 - easeOutCubic(k / 0.45) : 0
        const hz = k < 0.45 ? 1 : 1 - easeOutCubic((k - 0.45) / 0.4)
        g.globalAlpha = Math.min(1, k * 3) * (k > 0.9 ? (1 - k) / 0.1 : 1)
        g.fillStyle = '#000'
        g.fillRect(0, 0, w, h)
        const bh = Math.max(2, h * v)
        const bw = Math.max(3, w * Math.max(0, hz))
        g.globalAlpha = k > 0.9 ? (1 - k) / 0.1 : 1
        const grad = g.createLinearGradient(0, cy - bh / 2, 0, cy + bh / 2)
        grad.addColorStop(0, 'rgba(160,200,255,0)')
        grad.addColorStop(0.5, '#ffffff')
        grad.addColorStop(1, 'rgba(160,200,255,0)')
        g.fillStyle = grad
        g.fillRect(cx - bw / 2, cy - bh / 2, bw, bh)
        g.drawImage(stage.sprite('#cfe3ff'), cx - 30, cy - 30, 60, 60)
      },
    })
  }

  /** a short, decaying shake of the whole app */
  shake(intensity = 8, ms = 380): void {
    if (this.idle) return
    const el = this.shakeTarget()
    if (!el || typeof el.animate !== 'function') return
    const frames: Keyframe[] = []
    const steps = 9
    for (let i = 0; i <= steps; i++) {
      const fall = 1 - i / steps
      const dx = i === steps ? 0 : rand(-1, 1) * intensity * fall
      const dy = i === steps ? 0 : rand(-1, 1) * intensity * fall
      frames.push({ translate: `${dx.toFixed(1)}px ${dy.toFixed(1)}px` })
    }
    try {
      this.shakeAnim?.cancel()
      // a translated root overflows the window by a few pixels, which would
      // flash scrollbars at its edges: clip it for exactly as long as it shakes
      if (!this.unclip) {
        const before = el.style.overflow
        el.style.overflow = 'hidden'
        this.unclip = () => { el.style.overflow = before }
      }
      const anim = el.animate(frames, { duration: ms, easing: 'linear' })
      this.shakeAnim = anim
      const done = () => {
        if (this.shakeAnim !== anim) return
        this.shakeAnim = null
        this.unclip?.()
        this.unclip = null
      }
      anim.onfinish = done
      anim.oncancel = done
    } catch { /* no Web Animations: the stage still plays */ }
  }
  /** puts the shaken element's own overflow back */
  private unclip: (() => void) | null = null

  /** a one-off glow on an element of the app, reverting by itself */
  pulse(el: Element | null, color: string, ms = 900): void {
    if (this.dead || !el || typeof (el as HTMLElement).animate !== 'function') return
    try {
      (el as HTMLElement).animate([
        { filter: 'none' },
        { filter: `drop-shadow(0 0 10px ${color}) drop-shadow(0 0 22px ${color}) brightness(1.25)`, offset: 0.2 },
        { filter: 'none' },
      ], { duration: ms, easing: 'ease-out' })
    } catch { /* unsupported filter: skip */ }
  }

  /** a pressed control pops (the Wonder Full take): the individual `scale`
   *  property composes with whatever transform the control already has, and
   *  the animation reverts by itself */
  pop(el: Element | null, by = 1.12, ms = 200): void {
    if (this.idle || !el || typeof (el as HTMLElement).animate !== 'function') return
    try {
      (el as HTMLElement).animate([{ scale: '1' }, { scale: String(by), offset: 0.3 }, { scale: '1' }],
        { duration: ms, easing: 'ease-out' })
    } catch { /* no individual transforms: skip */ }
  }

  /** a summoning portal (the Astra and Argon takes' hire): three orbits
   *  spinning open around a glowing core */
  portal(x: number, y: number, o: { color?: string; radius?: number; life?: number } = {}): void {
    const color = o.color ?? '#ffd34d'
    const radius = o.radius ?? 90
    const stage = this
    this.add({
      age: 0, life: o.life ?? 1.4,
      blend: 'lighter',
      draw(g, k) {
        const open = easeOutBack(Math.min(1, this.age / 0.3))
        const fade = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1
        const r = Math.max(1, radius * open)
        const spin = this.age * 5
        g.translate(x, y)
        g.globalAlpha = fade
        const s = r * 1.4
        g.drawImage(stage.sprite(color), -s / 2, -s / 2, s, s)
        for (const [w, stroke] of [[3.5, color], [1.2, '#ffffff']] as const) {
          g.lineWidth = w
          g.strokeStyle = stroke
          for (let i = 0; i < 3; i++) {
            g.save()
            g.rotate(spin + (i * TAU) / 3)
            g.scale(1, 0.38)
            g.beginPath(); g.arc(0, 0, r, 0, TAU); g.stroke()
            g.restore()
          }
        }
      },
    })
  }

  /** a radar sweep (the Astra and Argon takes' watchdog): rings and a turning
   *  arm with a fading wake */
  radar(x: number, y: number, o: { color?: string; radius?: number; life?: number } = {}): void {
    const color = o.color ?? '#69f0ae'
    const radius = o.radius ?? 110
    this.add({
      age: 0, life: o.life ?? 1.3,
      blend: 'lighter',
      draw(g, k) {
        const r = Math.max(1, radius * easeOutCubic(Math.min(1, this.age / 0.25)))
        const fade = k > 0.65 ? 1 - (k - 0.65) / 0.35 : 1
        const arm = this.age * 7
        g.translate(x, y)
        g.strokeStyle = color
        g.lineWidth = 2
        for (let i = 1; i <= 3; i++) {
          g.globalAlpha = fade * (0.3 + 0.15 * i)
          g.beginPath(); g.arc(0, 0, (r * i) / 3, 0, TAU); g.stroke()
        }
        g.globalAlpha = fade * 0.4
        g.fillStyle = color
        g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, r, arm - 0.8, arm); g.closePath(); g.fill()
        g.globalAlpha = fade
        g.strokeStyle = '#ffffff'
        g.lineWidth = 3
        g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(arm) * r, Math.sin(arm) * r); g.stroke()
      },
    })
  }

  /** a warning sign that pops up and throbs (the Astra take's FAULT) */
  warn(x: number, y: number, o: { size?: number; life?: number } = {}): void {
    const size = o.size ?? 60
    this.add({
      age: 0, life: o.life ?? 1.3,
      draw(g, k) {
        const pop = easeOutBack(Math.min(1, this.age / 0.18))
        const throb = 1 + Math.sin(this.age * 22) * 0.06 * (1 - k)
        const fade = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1
        g.translate(x, y)
        g.scale(pop * throb, pop * throb)
        g.globalAlpha = Math.max(0, fade)
        g.lineJoin = 'round'
        g.beginPath()
        g.moveTo(0, -size); g.lineTo(size * 0.95, size * 0.68); g.lineTo(-size * 0.95, size * 0.68)
        g.closePath()
        g.lineWidth = size * 0.18; g.strokeStyle = '#1a0000'; g.stroke()
        g.fillStyle = '#ffcc00'; g.fill()
        g.lineWidth = size * 0.07; g.strokeStyle = '#ff3b3b'; g.stroke()
        g.fillStyle = '#1a0000'
        g.beginPath()
        g.moveTo(-size * 0.09, -size * 0.48); g.lineTo(size * 0.09, -size * 0.48)
        g.lineTo(size * 0.05, size * 0.2); g.lineTo(-size * 0.05, size * 0.2)
        g.closePath(); g.fill()
        g.beginPath(); g.arc(0, size * 0.4, size * 0.085, 0, TAU); g.fill()
      },
    })
  }

  /** The combo meter (the Wonder Full take's count, the Argon take's ranks,
   *  the Astra take's heat and arena): bottom right, the combo and its rank
   *  over a bar that runs down to the moment the combo drops. The hotter the
   *  combo, the more the window's edges glow, speed lines stream outward and
   *  the corners close in like an arena. `read` is asked every frame; null
   *  means the combo has dropped, and the meter fades out and lets the loop
   *  sleep. One meter per stage: asking again while it shows keeps it. */
  meter(read: () => ComboReading | null): void {
    if (this.idle || this.hud) return
    let last: ComboReading | null = null
    let gone = 0
    let bumped = 0
    this.hud = {
      age: 0, life: Infinity,
      step(dt) {
        const now = read()
        if (now) {
          if (!last || now.n !== last.n) bumped = this.age
          last = now
          gone = 0
          return true
        }
        gone += dt
        return gone < 0.35
      },
      draw(g, _k, stage) {
        if (!last) return
        const { w, h } = stage.size
        const fade = 1 - Math.min(1, gone / 0.35)
        const heat = last.heat * fade
        const hot = last.color
        if (heat > 0.01) {
          const halo = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75)
          halo.addColorStop(0, 'rgba(0,0,0,0)')
          halo.addColorStop(1, hot)
          g.globalAlpha = heat * 0.22
          g.fillStyle = halo
          g.fillRect(0, 0, w, h)
          g.globalAlpha = heat * 0.5
          g.strokeStyle = hot
          g.lineWidth = 2
          const far = Math.max(w, h)
          for (let i = 0; i < 18; i++) {
            const a = (i * TAU) / 18 + 0.3
            const r = far * (0.42 + ((this.age * 0.55 + i * 0.13) % 0.3))
            g.beginPath()
            g.moveTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r)
            g.lineTo(w / 2 + Math.cos(a) * r * 1.18, h / 2 + Math.sin(a) * r * 1.18)
            g.stroke()
          }
          const inset = 12 + (1 - heat) * 10
          const arm = 34 + heat * 56
          g.globalAlpha = Math.min(1, heat * 1.4)
          g.lineWidth = 3 + heat * 3
          for (const [cx, cy, sx, sy] of [[inset, inset, 1, 1], [w - inset, inset, -1, 1],
            [inset, h - inset, 1, -1], [w - inset, h - inset, -1, -1]] as const) {
            g.beginPath(); g.moveTo(cx, cy + sy * arm); g.lineTo(cx, cy); g.lineTo(cx + sx * arm, cy); g.stroke()
          }
        }
        // the meter itself
        const bw = 262, bh = 80
        const x0 = w - bw - 22, y0 = h - bh - 22
        g.globalAlpha = fade * 0.9
        roundRect(g, x0, y0, bw, bh, 12)
        g.fillStyle = 'rgba(10,12,20,0.88)'
        g.fill()
        g.lineWidth = 2
        g.strokeStyle = hot
        g.stroke()
        g.globalAlpha = fade
        g.textAlign = 'left'
        g.textBaseline = 'middle'
        g.font = `800 11px ${IMPACT}`
        g.fillStyle = hot
        g.fillText('COMBO', x0 + 16, y0 + 20)
        g.font = `900 13px ${IMPACT}`
        g.fillStyle = '#ffffff'
        g.fillText(last.rank, x0 + 16, y0 + 42)
        const bump = 1 + Math.max(0, 0.3 - (this.age - bumped)) * 1.1
        g.save()
        g.translate(x0 + bw - 16, y0 + 34)
        g.scale(bump, bump)
        g.font = `900 36px ${IMPACT}`
        g.textAlign = 'right'
        g.lineJoin = 'round'
        g.lineWidth = 6
        g.strokeStyle = '#1a0d00'
        const count = `×${last.n}`
        g.strokeText(count, 0, 0)
        const grad = g.createLinearGradient(0, -18, 0, 18)
        grad.addColorStop(0, '#ffffff')
        grad.addColorStop(0.45, '#ffd34d')
        grad.addColorStop(1, shade('#ffd34d'))
        g.fillStyle = grad
        g.fillText(count, 0, 0)
        g.restore()
        const barX = x0 + 16, barW = bw - 32, barY = y0 + bh - 16
        g.fillStyle = 'rgba(255,255,255,0.14)'
        g.fillRect(barX, barY, barW, 5)
        g.fillStyle = hot
        g.fillRect(barX, barY, barW * Math.max(0, Math.min(1, last.left)), 5)
      },
    }
    this.wake()
  }

  /** whether the combo meter is showing (for tests and the curious) */
  get metering(): boolean { return !!this.hud }
}

/* ── geometry helpers ───────────────────────────────────────────────────── */

/** the impact lettering every word, title and meter uses (system fonts only) */
const IMPACT = '"Segoe UI Black", "Arial Black", Impact, system-ui, sans-serif'

/** a caption is a name: small capitals, never longer than a card is wide */
function captionText(text: string | undefined): string {
  const t = (text ?? '').trim().toUpperCase()
  return t.length > 28 ? t.slice(0, 27) + '…' : t
}

/** a caption under a word, in the word's own transform */
function drawCaption(g: CanvasRenderingContext2D, text: string, y: number, size: number, ink: string): void {
  g.font = `800 ${size}px ${IMPACT}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineJoin = 'round'
  g.lineWidth = size * 0.3
  g.strokeStyle = ink
  g.strokeText(text, 0, y)
  g.fillStyle = '#ffffff'
  g.fillText(text, 0, y)
}

/** a five-pointed star around the origin */
function starPath(g: CanvasRenderingContext2D, r: number): void {
  g.beginPath()
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r
    const a = (i / 10) * TAU - Math.PI / 2
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr)
  }
  g.closePath()
}

/** The ice-spike crown, from the Argon take's drawing: points relative to the
 *  foot of the middle crystal, in a 180-unit-tall frame, back to front. */
const CRYSTAL: { points: [number, number][]; fill: string; edge: string; width: number }[] = [
  { points: [[-92, -93], [-32, -60], [-42, -10], [-76, -31]], fill: 'rgba(128,216,255,0.75)', edge: '#e1f5fe', width: 1.5 },
  { points: [[92, -93], [76, -31], [42, -10], [32, -60]], fill: 'rgba(128,216,255,0.75)', edge: '#e1f5fe', width: 1.5 },
  { points: [[-62, -147], [-12, -89], [-24, -7], [-48, -23]], fill: 'rgba(64,196,255,0.82)', edge: '#ffffff', width: 2 },
  { points: [[62, -147], [48, -23], [24, -7], [12, -89]], fill: 'rgba(0,176,255,0.82)', edge: '#ffffff', width: 2 },
  { points: [[0, -177], [26, -97], [14, 0], [-14, 0], [-26, -97]], fill: 'core', edge: '#e1f5fe', width: 2.5 },
]

function centroid(points: [number, number][]): [number, number] {
  let x = 0, y = 0
  for (const [px, py] of points) { x += px; y += py }
  return [x / points.length, y / points.length]
}

const FIREWORK = ['#ff4d6d', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff', '#ff9f1c']
const CONFETTI = ['#ff4d6d', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff', '#ff9f1c', '#ffffff']

function quad(x1: number, y1: number, mx: number, my: number, x2: number, y2: number, t: number): [number, number] {
  const a = (1 - t) ** 2, b = 2 * (1 - t) * t, c = t ** 2
  return [a * x1 + b * mx + c * x2, a * y1 + b * my + c * y2]
}

/** midpoint displacement: a jagged path between two points */
function lightning(x1: number, y1: number, x2: number, y2: number, depth: number): [number, number][] {
  let pts: [number, number][] = [[x1, y1], [x2, y2]]
  let offset = Math.hypot(x2 - x1, y2 - y1) * 0.22
  for (let d = 0; d < depth; d++) {
    const next: [number, number][] = [pts[0]!]
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i]!, [bx, by] = pts[i + 1]!
      const mx = (ax + bx) / 2, my = (ay + by) / 2
      const nx = -(by - ay), ny = bx - ax
      const len = Math.hypot(nx, ny) || 1
      const o = rand(-offset, offset)
      next.push([mx + (nx / len) * o, my + (ny / len) * o], [bx, by])
    }
    pts = next
    offset /= 2
  }
  return pts
}

/** a short branch off a random point of a bolt */
function fork(path: [number, number][]): [number, number][] {
  const i = Math.floor(rand(path.length * 0.2, path.length * 0.8))
  const [x, y] = path[i] ?? path[0]!
  const [nx, ny] = path[Math.min(path.length - 1, i + 3)]!
  const angle = Math.atan2(ny - y, nx - x) + rand(-0.9, 0.9)
  const len = rand(30, 90)
  return lightning(x, y, x + Math.cos(angle) * len, y + Math.sin(angle) * len, 3)
}

function strokePath(g: CanvasRenderingContext2D, pts: [number, number][]): void {
  g.beginPath()
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
  g.stroke()
}

function octagon(g: CanvasRenderingContext2D, r: number): void {
  g.beginPath()
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r)
  }
  g.closePath()
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}

/** a darker version of a #rrggbb colour, for the bottom of a word's gradient */
function shade(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1]!, 16)
  const r = Math.round(((n >> 16) & 255) * 0.55), g = Math.round(((n >> 8) & 255) * 0.55), b = Math.round((n & 255) * 0.55)
  return `rgb(${r},${g},${b})`
}
