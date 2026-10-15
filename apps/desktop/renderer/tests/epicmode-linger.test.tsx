// EPIC Mode — lingering effects (docket
// epic-mode-next-round-more-shake-and-blur-a-small, part 4: "more lingering
// effects that remain on screen for longer"; plan approved by the coordinator
// 2026-10-15 18:25Z). What a strike leaves behind fades slowly where it
// happened: cracks in the glass, a scorch mark and embers, frost that thaws on
// its card, confetti and coins settled on the window's floor, an afterglow.
// Each lasts at most 30 s, under a count cap. While only these are left, the
// stage's loop draws about 15 frames a second instead of the display's rate,
// and it sleeps once the last has faded: an idle organization still costs
// nothing.
//
// The stage's time is taken over (`clockwork`), so half a minute takes no
// real time and the frames the loop draws can be counted. Every stage made
// here draws on a context that records where each mark lands, per frame.

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { startEpic } from '../src/epic/director'
import { Stage } from '../src/epic/stage'
import type { Spot } from '../src/epic/locate'
import { clockwork, fakeAudio } from './epicmode-fakes'

const at = (x: number, y: number): Spot => ({ x, y, rect: null, el: null, doc: document })

interface Mark { frame: number; op: string; x: number; y: number; alpha: number }

/** Stages made from now on record each mark they draw: what (a line point, a
 *  rect's or an image's centre, an arc's or an ellipse's centre), where on
 *  the window and how opaque, and in which frame (a frame starts at the
 *  stage's clearRect). Other canvases (the glow sprites) record nothing. */
function recordMarks(): { marks: Mark[]; frame: () => number; restore: () => void } {
  const marks: Mark[] = []
  let frame = 0
  const proto = window.HTMLCanvasElement.prototype as unknown as { getContext: unknown }
  const had = proto.getContext
  proto.getContext = function (this: HTMLCanvasElement) {
    const stage = this.dataset.epic === 'stage'
    let m = [1, 0, 0, 1, 0, 0]
    let alpha = 1
    const stack: { m: number[]; alpha: number }[] = []
    const place = (x: number, y: number): [number, number] => [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!]
    const mark = (op: string, x: number, y: number) => {
      if (!stage) return
      const [px, py] = place(x, y)
      marks.push({ frame, op, x: px, y: py, alpha })
    }
    const ops: Record<string, unknown> = {
      save: () => { stack.push({ m: [...m], alpha }) },
      restore: () => { const s = stack.pop(); m = s?.m ?? [1, 0, 0, 1, 0, 0]; alpha = s?.alpha ?? 1 },
      setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => { m = [a, b, c, d, e, f] },
      translate: (x: number, y: number) => { const [e, f] = place(x, y); m = [m[0]!, m[1]!, m[2]!, m[3]!, e, f] },
      scale: (sx: number, sy: number) => { m = [m[0]! * sx, m[1]! * sx, m[2]! * sy, m[3]! * sy, m[4]!, m[5]!] },
      rotate: (r: number) => {
        const c = Math.cos(r), s = Math.sin(r)
        m = [m[0]! * c + m[2]! * s, m[1]! * c + m[3]! * s, m[2]! * c - m[0]! * s, m[3]! * c - m[1]! * s, m[4]!, m[5]!]
      },
      clearRect: () => { if (stage) frame++ },
      fillRect: (x: number, y: number, w: number, h: number) => mark('rect', x + w / 2, y + h / 2),
      drawImage: (_img: unknown, x: number, y: number, w: number, h: number) => mark('image', x + w / 2, y + h / 2),
      arc: (x: number, y: number) => mark('arc', x, y),
      ellipse: (x: number, y: number) => mark('ellipse', x, y),
      lineTo: (x: number, y: number) => mark('line', x, y),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      measureText: (s: string) => ({ width: String(s).length * 7 }),
    }
    return new Proxy({}, {
      get(_target, key) {
        if (key === 'globalAlpha') return alpha
        if (key === 'then') return undefined
        return ops[String(key)] ?? (() => undefined)
      },
      set(_target, key, value) { if (key === 'globalAlpha') alpha = Number(value); return true },
    })
  }
  return { marks, frame: () => frame, restore: () => { proto.getContext = had } }
}

const near = (m: { x: number; y: number }, x: number, y: number, r: number) => Math.hypot(m.x - x, m.y - y) <= r
const kinds = (stage: Stage) => stage.lingering.map(r => r.kind).join(', ') || 'none'
/** the marks of the newest frame */
const latest = (rec: { marks: Mark[]; frame: () => number }) => rec.marks.filter(m => m.frame === rec.frame())

test('a strike leaves its cracks in the glass: they fade over seconds, not at once, and are gone within 30 s', () => {
  const clock = clockwork()
  const rec = recordMarks()
  const stage = new Stage(document)
  try {
    stage.cracks(400, 300, { count: 6, length: 120, life: 1.6 })
    clock.run(2000)
    assert.equal(stage.lingering.some(r => r.kind === 'cracks' && near(r, 400, 300, 1)), true, `the cracks linger after their own 1.6 s (${kinds(stage)})`)
    const early = Math.max(0, ...latest(rec).filter(m => m.op === 'line' && near(m, 400, 300, 170)).map(m => m.alpha))
    assert.equal(early > 0, true, 'and are drawn')
    clock.run(8000)
    const later = latest(rec).filter(m => m.op === 'line' && near(m, 400, 300, 170))
    assert.equal(later.length > 0, true, 'still drawn 10 s after the strike')
    assert.equal(Math.max(...later.map(m => m.alpha)) < early, true, 'fainter than they were')
    clock.run(21_000)
    assert.equal(stage.lingering.length, 0, `gone 31 s after the strike (${kinds(stage)})`)
    assert.equal(clock.busy, false, 'and the loop sleeps')
    assert.equal(latest(rec).length, 0, 'with nothing left on the canvas')
  } finally { stage.destroy(); rec.restore(); clock.restore() }
})

test('with only lingering effects left the loop draws about 15 frames a second, and stops once they are gone', () => {
  const clock = clockwork()
  const stage = new Stage(document)
  try {
    stage.burst(300, 300, { count: 20, life: [0.4, 0.6] })
    stage.cracks(500, 300, { count: 4, length: 80, life: 1 })
    let from = clock.frames
    clock.run(500)
    assert.equal(clock.frames - from >= 25, true, `the display's rate while the burst lives (${clock.frames - from} frames in 0.5 s)`)
    clock.run(1500)
    from = clock.frames
    clock.run(2000)
    const fps = (clock.frames - from) / 2
    assert.equal(fps >= 10 && fps <= 16, true, `about 15 frames a second with only the cracks left (${fps})`)
    clock.run(30_000)
    assert.equal(stage.lingering.length, 0, `then they are gone (${kinds(stage)})`)
    assert.equal(clock.busy, false, 'and no frame is asked for')
  } finally { stage.destroy(); clock.restore() }
})

test('a new effect brings the loop back to the display\'s rate at once', () => {
  const clock = clockwork()
  const stage = new Stage(document)
  try {
    stage.cracks(500, 300, { count: 4, length: 80, life: 1 })
    clock.run(2000)
    let from = clock.frames
    clock.run(1000)
    assert.equal(clock.frames - from >= 10 && clock.frames - from <= 16, true, `the slow lane first (${clock.frames - from} frames in 1 s)`)
    stage.burst(300, 300, { count: 20, life: [0.6, 0.8] })
    from = clock.frames
    clock.run(250)
    assert.equal(clock.frames - from >= 13, true, `then every display frame for the burst (${clock.frames - from} in 0.25 s)`)
  } finally { stage.destroy(); clock.restore() }
})

test('however many strikes, the residue stops growing at its cap, and nothing lingers past 30 s', () => {
  const clock = clockwork()
  const stage = new Stage(document)
  try {
    for (let i = 0; i < 300; i++) stage.cracks(20 + (i * 37) % 900, 20 + (i * 53) % 700, { count: 3, length: 30, life: 0.5 })
    const capped = stage.lingering.length
    for (let i = 0; i < 50; i++) stage.cracks(50 + i * 15, 400, { count: 3, length: 30, life: 0.5 })
    assert.equal(capped > 0 && capped <= 64, true, `a cap of at most 64 (${capped})`)
    assert.equal(stage.lingering.length, capped, 'and nothing more past it')
    stage.destroy()
    const fresh = new Stage(document)
    try {
      fresh.afterglow(300, 300, { strength: 0.5, life: 120 })
      clock.run(29_000)
      assert.equal(fresh.lingering.length, 1, 'an afterglow asked to last two minutes is still there at 29 s')
      clock.run(1_500)
      assert.equal(fresh.lingering.length, 0, 'and gone by 30.5 s')
    } finally { fresh.destroy() }
  } finally { stage.destroy(); clock.restore() }
})

test('a hidden window leaves no residue, and residue ages on the clock, not on frames', () => {
  const clock = clockwork()
  const stage = new Stage(document)
  const doc = document as unknown as Record<string, unknown>
  try {
    Object.defineProperty(doc, 'visibilityState', { value: 'hidden', configurable: true })
    stage.cracks(400, 300)
    stage.afterglow(400, 300)
    assert.equal(stage.lingering.length, 0, `nothing left in a hidden window (${kinds(stage)})`)
    delete doc.visibilityState
    stage.cracks(400, 300, { count: 4, length: 80, life: 1 })
    clock.run(2000)
    assert.equal(stage.lingering.length > 0, true, 'shown, a strike leaves its cracks')
    clock.skip(60_000)
    clock.run(200)
    assert.equal(stage.lingering.length, 0, `a minute with no frames (the system hid the window) and they are gone when it shows again (${kinds(stage)})`)
  } finally { delete doc.visibilityState; stage.destroy(); clock.restore() }
})

test('confetti and coins that reach the bottom of the window settle there, stay a while, then go', () => {
  const clock = clockwork()
  const rec = recordMarks()
  const stage = new Stage(document)
  const h = window.innerHeight
  try {
    // rain dies 2.2 to 3.6 s after it starts above the window, so only about
    // one piece in nine reaches the bottom of jsdom's 768 px: 800 pieces land
    // about 90 (never under 56 in 20,000 simulated runs; 200 landed under 20
    // one run in four)
    stage.rain('confetti', { count: 640 })
    stage.rain('coin', { count: 160 })
    clock.run(5000)
    const floor = stage.lingering.find(r => r.kind === 'floor')
    assert.equal(!!floor, true, `what fell lies on the floor (${kinds(stage)})`)
    assert.equal((floor?.amount ?? 0) >= 20, true, `many pieces lie there (${floor?.amount})`)
    const lying = () => latest(rec).filter(m => (m.op === 'rect' || m.op === 'ellipse') && m.y >= h - 14 && m.y <= h)
    assert.equal(lying().length >= 20, true, `drawn along the bottom edge (${lying().length} pieces)`)
    assert.equal(latest(rec).some(m => m.op === 'ellipse' && m.y >= h - 14), true, 'coins among them')
    clock.run(6000)
    assert.equal(lying().length > 0, true, 'still there 11 s on')
    clock.run(20_000)
    assert.equal(stage.lingering.length, 0, `gone by 31 s (${kinds(stage)})`)
    assert.equal(lying().length, 0, 'the floor is clear')
  } finally { stage.destroy(); rec.restore(); clock.restore() }
})

test('a frozen card frosts over and thaws, following its card, and goes with it', () => {
  const clock = clockwork()
  const rec = recordMarks()
  const stage = new Stage(document)
  const card = document.createElement('div')
  document.body.appendChild(card)
  let box = { x: 200, y: 150, w: 180, h: 120 }
  card.getBoundingClientRect = () => ({ x: box.x, y: box.y, left: box.x, top: box.y, width: box.w, height: box.h,
    right: box.x + box.w, bottom: box.y + box.h, toJSON: () => ({}) }) as DOMRect
  try {
    stage.iceBlock({ ...box }, 2.4, card)
    clock.run(4000)
    const frost = () => stage.lingering.find(r => r.kind === 'frost')
    assert.equal(!!frost() && near(frost()!, 290, 210, 2), true, `the slab has melted, the card is frosted (${kinds(stage)})`)
    box = { x: 520, y: 300, w: 180, h: 120 }
    clock.run(500)
    assert.equal(near(frost()!, 610, 360, 2), true, `the frost follows its card (${Math.round(frost()!.x)}, ${Math.round(frost()!.y)})`)
    const on = latest(rec).filter(m => m.x >= 500 && m.x <= 720 && m.y >= 280 && m.y <= 440)
    assert.equal(on.length > 0, true, 'and is drawn there')
    assert.equal(latest(rec).some(m => m.x >= 180 && m.x <= 400 && m.y >= 130 && m.y <= 290), false, 'not where the card was')
    const early = Math.max(...on.map(m => m.alpha))
    clock.run(10_000)
    const thawing = latest(rec).filter(m => m.x >= 500 && m.x <= 720 && m.y >= 280 && m.y <= 440)
    assert.equal(thawing.length > 0 && Math.max(...thawing.map(m => m.alpha)) < early, true, 'thawing 15 s on')
    clock.run(16_000)
    assert.equal(frost(), undefined, `thawed by 30 s (${kinds(stage)})`)
    stage.iceBlock({ ...box }, 2.4, card)
    clock.run(3000)
    assert.equal(!!frost(), true, 'frozen again')
    card.remove()
    clock.run(500)
    assert.equal(frost(), undefined, 'and the frost goes with its card')
  } finally { card.remove(); stage.destroy(); rec.restore(); clock.restore() }
})

test('a meteor scorches the glass where it lands and leaves embers rising from it', () => {
  const clock = clockwork()
  const rec = recordMarks()
  const stage = new Stage(document)
  try {
    stage.meteor(500, 400)
    clock.run(700)
    assert.equal(stage.lingering.some(r => r.kind === 'scorch' && near(r, 500, 400, 1)), true, `a scorch mark where it landed (${kinds(stage)})`)
    assert.equal(stage.lingering.some(r => r.kind === 'embers' && near(r, 500, 400, 1)), true, 'and embers')
    clock.run(2500)
    const rising = () => latest(rec).filter(m => m.op === 'image' && Math.abs(m.x - 500) <= 120 && m.y < 400).length
    const embers = rising()
    assert.equal(embers >= 3, true, `rising above it 3 s on (${embers})`)
    assert.equal(latest(rec).some(m => near(m, 500, 400, 60) && m.op !== 'image'), true, 'over the scorch mark')
    clock.run(1600)
    assert.equal(rising(), embers, `every ember lingers at least 5 s: as many 4.8 s on (${rising()} of ${embers})`)
    clock.run(25_400)
    assert.equal(stage.lingering.length, 0, `all gone by 30 s (${kinds(stage)})`)
  } finally { stage.destroy(); rec.restore(); clock.restore() }
})

test('afterglows build up where activity repeats instead of piling up, and a new one restarts the fade', () => {
  const clock = clockwork()
  const stage = new Stage(document)
  try {
    stage.afterglow(300, 200, { strength: 0.3, life: 8 })
    stage.afterglow(310, 205, { strength: 0.3, life: 8 })
    stage.afterglow(700, 500, { strength: 0.3, life: 8 })
    const glows = () => stage.lingering.filter(r => r.kind === 'afterglow')
    assert.equal(glows().length, 2, `two places, two afterglows (${glows().length})`)
    const here = () => glows().find(g => near(g, 300, 200, 20))
    assert.equal((here()?.amount ?? 0) > 0.3, true, `the repeated place glows stronger (${here()?.amount})`)
    clock.run(7000)
    stage.afterglow(305, 200, { strength: 0.3, life: 8 })
    clock.run(5000)
    assert.equal(!!here(), true, 'activity again 7 s on keeps it glowing at 12 s')
    assert.equal(glows().some(g => near(g, 700, 500, 20)), false, 'while the other has faded')
  } finally { stage.destroy(); clock.restore() }
})

test('medium and heavy events leave an afterglow where they happened, the heavy ones stronger; light ones leave none', () => {
  const clock = clockwork()
  const proto = Stage.prototype as unknown as { afterglow?: (x: number, y: number, o?: { strength?: number }) => void }
  const had = proto.afterglow
  const glows: { x: number; y: number; strength: number }[] = []
  proto.afterglow = function (this: Stage, x: number, y: number, o: { strength?: number } = {}) {
    glows.push({ x, y, strength: o.strength ?? 0 })
    return had?.call(this, x, y, o)
  }
  const show = startEpic({ audio: fakeAudio().Ctor, greet: 'none' })
  try {
    for (const kind of ['click', 'type', 'tool', 'scroll'] as const) show.cue(kind, { spot: at(120, 120) })
    clock.run(100)
    assert.equal(glows.length, 0, `clicks, typing, tools and scrolling leave no afterglow (${glows.length})`)
    show.cue('turnEnd', { spot: at(300, 200) })
    clock.run(100)
    const medium = glows.find(g => near(g, 300, 200, 1))
    assert.equal(!!medium && medium.strength > 0, true, 'a turn\'s end glows where it happened')
    show.cue('error', { spot: at(600, 400) })
    clock.run(100)
    const heavy = glows.find(g => near(g, 600, 400, 1))
    assert.equal(!!heavy && heavy.strength > medium!.strength, true, `an error glows stronger (${heavy?.strength} > ${medium?.strength})`)
  } finally {
    show.stop()
    if (had) proto.afterglow = had
    else delete proto.afterglow
    clock.restore()
  }
})

test('the corner badge alone keeps the loop at the slow lane, until its combo drops', () => {
  const clock = clockwork()
  const stage = new Stage(document)
  let reading: { n: number; rank: string; color: string; left: number } | null =
    { n: 12, rank: 'HYPER-STREAK', color: '#ff8a2a', left: 1 }
  try {
    stage.meter(() => reading)
    clock.run(300)
    const from = clock.frames
    clock.run(2000)
    const fps = (clock.frames - from) / 2
    assert.equal(fps >= 10 && fps <= 16, true, `about 15 frames a second for the badge alone (${fps})`)
    reading = null
    clock.run(1500)
    assert.equal(stage.metering, false, 'the dropped combo\'s badge is gone')
    assert.equal(clock.busy, false, 'and the loop sleeps')
  } finally { stage.destroy(); clock.restore() }
})

test('a mark that momentum leaves to linger longer stretches its embers with it: it never lingers empty', () => {
  const clock = clockwork()
  const rec = recordMarks()
  const stage = new Stage(document)
  const more = stage as unknown as { intensity?: number }
  try {
    // what the director does while it stages an event in a busy spell
    more.intensity = 2
    stage.embers(500, 400)
    more.intensity = 1
    let alive = 0, drawn = 0
    for (let t = 250; t <= 20_000; t += 250) {
      clock.run(250)
      if (stage.lingering.some(r => r.kind === 'embers')) alive = t
      if (latest(rec).some(m => m.op === 'image' && Math.abs(m.x - 500) <= 200)) drawn = t
    }
    assert.equal(alive > 8000, true, `the embers' mark outlasts its 8 s at rest (${alive} ms)`)
    assert.equal(alive - drawn <= 250, true, `and draws its embers until it goes (drawn until ${drawn} of ${alive} ms)`)
  } finally { stage.destroy(); rec.restore(); clock.restore() }
})
