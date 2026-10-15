// EPIC Mode — comfort: nothing in the show strobes (docket
// epic-mode-next-round-more-shake-and-blur-a-small, part 6; user 2026-10-15
// 15:42Z: the "ticket flagged" effect flashes red and blue about 4.8 times a
// second, above the 3-a-second photosensitivity guideline: "slow it to at
// most 3 per second, keeping the same look". Coordinator ruling 18:25Z: the
// halt's three red flashes, 240 ms apart, are slowed the same way.)
//
// Every whole-window flash goes through Stage.flash, so these tests note each
// call (when, what colour, how strong, for how long) and check that the
// flashes keep their look, with the same count, colours, strength and length,
// and come at most three a second: each at least a third of a second after
// the one before, and never more than three starting in any one second.

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { startEpic, type Kind } from '../src/epic/director'
import { Stage } from '../src/epic/stage'
import type { Spot } from '../src/epic/locate'
import { fakeAudio } from './epicmode-fakes'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const at = (x: number, y: number): Spot => ({ x, y, rect: null, el: null, doc: document })

interface Flash { t: number; color: string; strength: number; life: number }
interface Ring { color: string; delay: number }

/** every flash and ring a stage is asked for while `body` runs */
async function watch(body: () => Promise<void>): Promise<{ flashes: Flash[]; rings: Ring[] }> {
  const flashes: Flash[] = []
  const rings: Ring[] = []
  const proto = Stage.prototype as unknown as {
    flash: (color: string, strength?: number, life?: number) => void
    ring: (x: number, y: number, o?: { color?: string; delay?: number }) => void
  }
  const { flash, ring } = proto
  proto.flash = function (this: Stage, color, strength = 0.45, life = 0.35) {
    flashes.push({ t: performance.now(), color, strength, life })
    return flash.call(this, color, strength, life)
  }
  proto.ring = function (this: Stage, x, y, o = {}) {
    rings.push({ color: o.color ?? '', delay: o.delay ?? 0 })
    return ring.call(this, x, y, o)
  }
  try { await body() } finally { proto.flash = flash; proto.ring = ring }
  return { flashes, rings }
}

/** the gaps between the flashes (ms) and the most that start in any one second */
function rate(flashes: Flash[]): { gaps: number[]; busiest: number } {
  const ts = flashes.map(f => f.t)
  const gaps = ts.slice(1).map((t, i) => Math.round(t - ts[i]!))
  const busiest = Math.max(0, ...ts.map(t => ts.filter(u => u >= t && u < t + 1000).length))
  return { gaps, busiest }
}

/** the flashes one cue makes, after its last one has had time to go out */
async function flashesOf(kind: 'attention' | 'halt'): Promise<{ flashes: Flash[]; rings: Ring[] }> {
  const show = startEpic({ audio: fakeAudio().Ctor, greet: 'none' })
  try {
    return await watch(async () => {
      show.cue(kind, { spot: at(400, 300) })
      await wait(1600)
    })
  } finally { show.stop() }
}

test('a flagged ticket (attention) flashes red and blue four times, at most three a second', async () => {
  const { flashes } = await flashesOf('attention')
  assert.deepEqual(flashes.map(f => [f.color, f.strength, f.life]),
    [['#ff3b3b', 0.2, 0.2], ['#3b6bff', 0.2, 0.2], ['#ff3b3b', 0.2, 0.2], ['#3b6bff', 0.2, 0.2]],
    'the same look: four flashes, red and blue in turn, as strong and as long as before')
  const { gaps, busiest } = rate(flashes)
  assert.equal(gaps.every(g => g >= 1000 / 3), true, `each flash at least a third of a second after the one before: gaps ${gaps.join(', ')} ms`)
  assert.equal(busiest <= 3, true, `no more than three flashes start in any one second (${busiest})`)
})

test('a halt flashes red three times, at most three a second, its rings going out with the flashes', async () => {
  const { flashes, rings } = await flashesOf('halt')
  assert.deepEqual(flashes.map(f => [f.color, f.strength, f.life]),
    [['#ff3b3b', 0.28, 0.22], ['#ff3b3b', 0.28, 0.22], ['#ff3b3b', 0.28, 0.22]],
    'the same look: three red flashes, as strong and as long as before')
  const { gaps, busiest } = rate(flashes)
  assert.equal(gaps.every(g => g >= 1000 / 3), true, `each flash at least a third of a second after the one before: gaps ${gaps.join(', ')} ms`)
  assert.equal(busiest <= 3, true, `no more than three flashes start in any one second (${busiest})`)
  // the same look: a red ring goes out with each flash
  const delays = rings.filter(r => r.color === '#ff3b3b').map(r => Math.round(r.delay * 1000))
  assert.equal(delays.length, 3, `three red rings (${delays.length})`)
  const step = Math.round((flashes[flashes.length - 1]!.t - flashes[0]!.t) / (flashes.length - 1))
  assert.equal(delays.every((d, i) => Math.abs(d - i * step) <= 40), true,
    `each ring starts with its flash: rings at ${delays.join(', ')} ms, flashes every ${step} ms`)
})

// ── the stage's comfort bounds (docket part 1: "more screen shake effects and
// screen blurs", bounded and never strobing; plan approved 2026-10-15 18:25Z,
// with flash merging ruled part of "no strobing"): at most three flashes a
// second however many events flash at once, shakes of at most 20 px and
// 0.9 s that a weaker one never cuts short, shaking at most half of any two
// seconds, blurs of at most 6 px over the whole window and 10 px at its edges
// for at most 0.7 s and at most one every 0.6 s, and under the system's
// reduced motion no shake and no blur, and softer flashes.

interface Frame { t: number; level: number }

/** Every stage made from now on draws on a context that records, per frame
 *  (a frame starts at the stage's clearRect), the most opaque fill covering
 *  the whole window, as epicmode-urgent does. */
function recordTint(): { frames: Frame[]; restore: () => void } {
  const frames: Frame[] = []
  const proto = window.HTMLCanvasElement.prototype as unknown as { getContext: unknown }
  const had = proto.getContext
  proto.getContext = () => {
    let alpha = 1
    const saved: number[] = []
    return new Proxy({}, {
      get(_target, key) {
        if (key === 'globalAlpha') return alpha
        if (key === 'save') return () => { saved.push(alpha) }
        if (key === 'restore') return () => { alpha = saved.pop() ?? 1 }
        if (key === 'clearRect') return () => { frames.push({ t: performance.now(), level: 0 }) }
        if (key === 'fillRect') {
          return (x: number, y: number, w: number, h: number) => {
            const frame = frames[frames.length - 1]
            if (frame && x <= 0 && y <= 0 && w >= window.innerWidth && h >= window.innerHeight) frame.level = Math.max(frame.level, alpha)
          }
        }
        if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} })
        if (key === 'measureText') return (s: string) => ({ width: String(s).length * 7 })
        if (key === 'then') return undefined
        return () => undefined
      },
      set(_target, key, value) { if (key === 'globalAlpha') alpha = Number(value); return true },
    })
  }
  return { frames, restore: () => { proto.getContext = had } }
}

/** When the whole-window fill rose by at least `step` after falling by as
 *  much since the rise before: each such rise starts one flash (or one dip).
 *  The window starts unlit (a new stage has drawn nothing), so a flash that is
 *  up in the very first frame counts too. */
function rises(frames: Frame[], step = 0.05): number[] {
  const at: number[] = []
  let low = 0, high = -Infinity, armed = true
  for (const f of frames) {
    if (armed) {
      low = Math.min(low, f.level)
      if (f.level - low >= step) { at.push(f.t); armed = false; high = f.level }
    } else {
      high = Math.max(high, f.level)
      if (high - f.level >= step) { armed = true; low = f.level }
    }
  }
  return at
}

/** the strongest whole-window fill drawn since `from` */
const strongest = (frames: Frame[], from: number): number =>
  Math.max(0, ...frames.filter(f => f.t >= from).map(f => f.level))

/** the most flashes starting in any one second, and the gaps between them (ms) */
function strobe(at: number[]): { busiest: number; gaps: number[] } {
  const gaps = at.slice(1).map((t, i) => Math.round(t - at[i]!))
  const busiest = Math.max(0, ...at.map(t => at.filter(u => u >= t && u < t + 1000).length))
  return { busiest, gaps }
}

interface Played { el: HTMLElement; frames: Keyframe[]; ms: number; from: number; end: number; cancelled: boolean }

/** Web Animations for jsdom, which has none: every call is noted, finishes by
 *  itself after its duration (running its onfinish) and can be cancelled
 *  (running its oncancel); `end` is when it stopped. */
function fakeAnimate(): { played: Played[]; restore: () => void } {
  const played: Played[] = []
  const proto = window.HTMLElement.prototype as unknown as { animate?: unknown }
  const had = Object.getOwnPropertyDescriptor(proto, 'animate')
  proto.animate = function (this: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions | number) {
    const ms = typeof opts === 'number' ? opts : Number(opts?.duration ?? 0)
    const now = performance.now()
    const p: Played = { el: this, frames, ms, from: now, end: now + ms, cancelled: false }
    played.push(p)
    let over = false
    const anim = {
      onfinish: null as null | (() => void),
      oncancel: null as null | (() => void),
      cancel() {
        if (over) return
        over = true
        p.cancelled = true
        p.end = performance.now()
        clearTimeout(timer)
        anim.oncancel?.()
      },
    }
    const timer = setTimeout(() => { if (!over) { over = true; anim.onfinish?.() } }, ms)
    return anim
  }
  return { played, restore: () => { if (had) Object.defineProperty(proto, 'animate', had); else delete proto.animate } }
}

/** the window's shakes: animations of a translate, with their amplitude, the
 *  farthest any keyframe moves the window (px) */
const shakes = (played: Played[]) => played
  .filter(p => p.frames.some(f => 'translate' in f))
  .map(p => ({
    ...p,
    amp: Math.max(0, ...p.frames.map(f => {
      const [dx = 0, dy = 0] = (String(f.translate ?? '').match(/-?[\d.]+/g) ?? []).map(Number)
      return Math.hypot(dx, dy)
    })),
  }))

/** the blurs: animations of a backdrop-filter, with their strength (px) and
 *  whether only the window's edges blur (the layer says so, and masks the
 *  rest: the mask itself is checked in Electron, jsdom does not keep it) */
const blurs = (played: Played[]) => played
  .filter(p => p.frames.some(f => 'backdropFilter' in f))
  .map(p => ({
    ...p,
    px: Math.max(0, ...p.frames.map(f => Number(/blur\(([\d.]+)px\)/.exec(String(f.backdropFilter))?.[1] ?? 0))),
    edges: p.el.dataset.blur === 'edges',
  }))

/** the system asks for reduced motion (Windows: Animation effects off) */
function reduceMotion(): () => void {
  const w = window as unknown as { matchMedia?: unknown }
  const had = Object.getOwnPropertyDescriptor(w, 'matchMedia')
  w.matchMedia = (q: string) => ({
    matches: /prefers-reduced-motion:\s*reduce/.test(q), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })
  return () => { if (had) Object.defineProperty(w, 'matchMedia', had); else delete w.matchMedia }
}

test('a flood of flashes never flashes the window more than three times a second', async () => {
  const tint = recordTint()
  const stage = new Stage(document)
  try {
    const from = performance.now()
    for (let i = 0; i < 12; i++) { stage.flash('#b6ffd3', 0.25, 0.4); await wait(90) }
    await wait(1600)
    const at = rises(tint.frames.filter(f => f.t >= from))
    const { busiest, gaps } = strobe(at)
    assert.equal(at.length >= 2, true, `the flood still flashes (${at.length} flashes)`)
    assert.equal(busiest <= 3, true, `no more than three flashes start in any second (${busiest}; gaps ${gaps.join(', ')} ms)`)
  } finally { stage.destroy(); tint.restore() }
})

test('the brown-out flicker dips the window at most three times a second', async () => {
  const tint = recordTint()
  const stage = new Stage(document)
  try {
    const from = performance.now()
    stage.flicker(1)
    await wait(1000)
    stage.flicker(1.2)
    await wait(1200)
    stage.flicker(0.9)
    await wait(1300)
    const at = rises(tint.frames.filter(f => f.t >= from))
    const { busiest, gaps } = strobe(at)
    assert.equal(at.length >= 3, true, `it still flickers (${at.length} dips)`)
    assert.equal(gaps.every(g => g >= 1000 / 3), true, `each dip at least a third of a second after the one before: gaps ${gaps.join(', ')} ms`)
    assert.equal(busiest <= 3, true, `no more than three dips start in any second (${busiest})`)
  } finally { stage.destroy(); tint.restore() }
})

test('a late frame cannot bring a flash and the dip after it closer than a third of a second on screen', async () => {
  const tint = recordTint()
  const stage = new Stage(document)
  try {
    const from = performance.now()
    stage.flash('#ffffff', 0.45, 0.35)
    stage.flicker(1)
    // the window is busy: the flash's first frame comes 80 ms late
    const busy = performance.now() + 80
    while (performance.now() < busy) { /* the main thread is held */ }
    await wait(1500)
    const at = rises(tint.frames.filter(f => f.t >= from))
    const { busiest, gaps } = strobe(at)
    assert.equal(at.length >= 2, true, `it flashes and dips (${at.length} in all)`)
    assert.equal(gaps.every(g => g >= 1000 / 3), true, `each at least a third of a second after the one before on screen: gaps ${gaps.join(', ')} ms`)
    assert.equal(busiest <= 3, true, `no more than three start in any second (${busiest})`)
  } finally { stage.destroy(); tint.restore() }
})

test('a shake moves the window at most 20 px for at most 0.9 s', () => {
  const anim = fakeAnimate()
  const stage = new Stage(document)
  try {
    stage.shake(40, 2000)
    const [s] = shakes(anim.played)
    assert.equal(!!s, true, 'it shakes')
    assert.equal(s!.amp <= 20.1, true, `at most 20 px (${s!.amp})`)
    assert.equal(s!.ms <= 900, true, `for at most 0.9 s (${s!.ms} ms)`)
  } finally { stage.destroy(); anim.restore() }
})

test('a weaker shake never cuts a stronger one short', () => {
  const anim = fakeAnimate()
  const stage = new Stage(document)
  try {
    stage.shake(12, 600)
    stage.shake(4, 300)
    const s = shakes(anim.played)
    assert.equal(s.length, 1, `the weak shake is not played over the strong one (${s.length} shakes)`)
    assert.equal(s[0]!.cancelled, false, 'and the strong one runs on')
  } finally { stage.destroy(); anim.restore() }
})

test('the window shakes at most half of any two seconds, however many events shake it', async () => {
  const anim = fakeAnimate()
  const stage = new Stage(document)
  try {
    const from = performance.now()
    for (let i = 0; i < 30; i++) { stage.shake(8, 400); await wait(100) }
    await wait(500)
    const s = shakes(anim.played)
    let worst = 0
    for (let t = from; t <= performance.now(); t += 50) {
      worst = Math.max(worst, s.reduce((sum, p) => sum + Math.max(0, Math.min(p.end, t) - Math.max(p.from, t - 2000)), 0))
    }
    assert.equal(s.length >= 2, true, `it shakes (${s.length} shakes)`)
    assert.equal(worst <= 1060, true, `at most a second of shaking in any two (${Math.round(worst)} ms)`)
  } finally { stage.destroy(); anim.restore() }
})

test('under the system\'s reduced motion nothing shakes or blurs, and flashes are softer', async () => {
  const restoreMotion = reduceMotion()
  const anim = fakeAnimate()
  const tint = recordTint()
  const show = startEpic({ audio: fakeAudio().Ctor, greet: 'none' })
  try {
    const from = performance.now()
    show.cue('killswitch', { spot: at(400, 300) })
    show.cue('hire', { spot: at(300, 200) })
    await wait(400)
    assert.equal(shakes(anim.played).length, 0, 'no shake')
    assert.equal(blurs(anim.played).length, 0, 'no blur')
    const top = strongest(tint.frames, from)
    assert.equal(top > 0 && top <= 0.3 + 1e-9, true, `the killswitch's red flash at half its strength (${top})`)
  } finally { show.stop(); tint.restore(); anim.restore(); restoreMotion() }
})

test('a heavy event blurs the whole window and a medium one its edges, briefly and spaced out; light ones never blur', async () => {
  const anim = fakeAnimate()
  const show = startEpic({ audio: fakeAudio().Ctor, greet: 'none' })
  try {
    show.cue('hire', { spot: at(400, 300) })
    let b = blurs(anim.played)
    assert.equal(b.length, 1, `a hire blurs the window (${b.length} blurs)`)
    assert.equal(b[0]!.edges, false, 'the whole window')
    assert.equal(b[0]!.px > 0 && b[0]!.px <= 6, true, `by at most 6 px (${b[0]!.px})`)
    assert.equal(b[0]!.ms > 0 && b[0]!.ms <= 700, true, `for at most 0.7 s (${b[0]!.ms} ms)`)
    const layer = b[0]!.el
    const canvas = document.querySelector<HTMLElement>('canvas[data-epic="stage"]')!
    assert.equal(layer.style.pointerEvents, 'none', 'the blur never takes a click')
    assert.equal(Number(layer.style.zIndex) < Number(canvas.style.zIndex), true, 'and lies under the effects, which stay sharp')
    show.cue('retire', { spot: at(400, 300) })
    assert.equal(blurs(anim.played).length, 1, 'another heavy event within 0.6 s does not blur again')
    await wait(800)
    assert.equal(document.querySelectorAll('[data-epic="blur"]').length, 0, 'the layer is gone once its blur ends')
    show.cue('question', { spot: at(400, 300) })
    b = blurs(anim.played)
    assert.equal(b.length, 2, `a question blurs (${b.length} blurs)`)
    assert.equal(b[1]!.edges, true, 'only the window\'s edges')
    assert.equal(b[1]!.px > 0 && b[1]!.px <= 10, true, `by at most 10 px (${b[1]!.px})`)
    assert.equal(b[1]!.ms > 0 && b[1]!.ms <= 700, true, `for at most 0.7 s (${b[1]!.ms} ms)`)
    await wait(800)
    for (const kind of ['click', 'type', 'tool', 'scroll'] as const) show.cue(kind, { spot: at(400, 300) })
    assert.equal(blurs(anim.played).length, 2, 'clicks, typing, tools and scrolling never blur')
  } finally { show.stop(); anim.restore() }
})

test('more events shake the window, by their weight: medium and heavy ones do, light ones do not', () => {
  const anim = fakeAnimate()
  /** how far one event alone shakes a fresh show's window (0: not at all) */
  const amp = (kind: Kind): number => {
    const show = startEpic({ audio: fakeAudio().Ctor, greet: 'none' })
    try {
      const n = anim.played.length
      show.cue(kind, { spot: at(400, 300) })
      return Math.max(0, ...shakes(anim.played.slice(n)).map(s => s.amp))
    } finally { show.stop() }
  }
  try {
    for (const kind of ['zap', 'answer', 'turnStart', 'userMail'] as const) {
      const a = amp(kind)
      assert.equal(a > 0 && a <= 6, true, `${kind} shakes the window lightly (${a} px)`)
    }
    for (const kind of ['retire', 'error', 'ticket', 'ticketDone'] as const) {
      const a = amp(kind)
      assert.equal(a >= 6, true, `${kind} shakes it hard (${a} px)`)
    }
    for (const kind of ['click', 'type', 'tool', 'scroll'] as const) {
      assert.equal(amp(kind), 0, `${kind} does not shake it`)
    }
  } finally { anim.restore() }
})
