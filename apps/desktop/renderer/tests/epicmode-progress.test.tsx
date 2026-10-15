// EPIC Mode — progression (docket
// epic-mode-next-round-more-shake-and-blur-a-small, part 3: "more progressive
// idle game mechanics, things that build up over time with more momentum and
// have recursive effects on each other"; plan approved by the coordinator
// 2026-10-15 18:25Z).
//
// Momentum: each event adds its weight times the multiplier, so busy spells
// snowball; it halves every 45 s and the multiplier grows with it, bounded at
// ×3. Charge: an agent's own events charge it, its effects grow with it, and
// two charged agents meeting (a zap) combine theirs. Level: the session's
// total activity unlocks extras one at a time, each announced once in the
// corner. Chains: crossing a momentum tier makes what lingers flare once,
// only inside an event. All of it plain numbers decayed from timestamps, with
// no timer, living for the app session: across EPIC Mode turning off and on.

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { startEpic } from '../src/epic/director'
import { Stage } from '../src/epic/stage'
import { charge, feed, momentum, multiplier, reset, total, unlocked } from '../src/epic/progress'
import type { Spot } from '../src/epic/locate'
import { clockwork, fakeAudio } from './epicmode-fakes'

declare const __SRC_DIR__: string

const at = (x: number, y: number): Spot => ({ x, y, rect: null, el: null, doc: document })
const T0 = 1_000_000
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6

interface Call { self: Stage; args: unknown[]; intensity: number }

/** every call of one of the stage's methods, with the stage it was made on
 *  and how much more that stage gave at that moment (its `intensity`, which
 *  the director sets only while it stages an event; 1: nothing more) */
function spy(name: 'burst' | 'shake' | 'chain' | 'toast' | 'ring'): { calls: Call[]; restore: () => void } {
  const proto = Stage.prototype as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>
  const had = proto[name]
  const calls: Call[] = []
  proto[name] = function (this: Stage, ...args: unknown[]) {
    calls.push({ self: this, args, intensity: (this as unknown as { intensity?: number }).intensity ?? 1 })
    return had?.apply(this, args)
  }
  return { calls, restore: () => { if (had) proto[name] = had; else delete proto[name] } }
}

test('momentum halves every 45 s from its timestamp, and progression never sets a timer or asks for a frame', () => {
  reset()
  try {
    feed(2, T0)
    assert.equal(close(momentum(T0), 2), true, `an event adds its weight, ×1 from rest (${momentum(T0)})`)
    assert.equal(close(momentum(T0 + 45_000), 1), true, `half of it 45 s on (${momentum(T0 + 45_000)})`)
    assert.equal(close(momentum(T0 + 90_000), 0.5), true, `a quarter at 90 s (${momentum(T0 + 90_000)})`)
    const source = readFileSync(path.join(__SRC_DIR__, 'epic', 'progress.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    assert.equal(/setTimeout|setInterval|requestAnimationFrame|addEventListener/.test(source), false, 'no timer, frame or listener in progression')
  } finally { reset() }
})

test('busy spells snowball: each event adds its weight times the multiplier, which never passes ×3', () => {
  reset()
  try {
    const steps: number[] = []
    let last = 0
    for (let i = 0; i < 6; i++) { feed(1, T0); steps.push(momentum(T0) - last); last = momentum(T0) }
    assert.equal(steps.every((s, i) => i === 0 || s > steps[i - 1]!), true, `each event adds more than the one before (${steps.map(s => s.toFixed(2)).join(', ')})`)
    for (let i = 0; i < 200; i++) feed(2, T0)
    assert.equal(multiplier(T0) <= 3, true, `the multiplier is bounded (${multiplier(T0)})`)
    assert.equal(close(multiplier(T0), 3), true, 'and reaches ×3 in a long busy spell')
    assert.equal(multiplier(T0 + 600_000) < 1.01, true, `ten quiet minutes and it is back to ×1 (${multiplier(T0 + 600_000)})`)
  } finally { reset() }
})

test('an agent\'s own events charge it and lift its effects; a zap between two charged agents combines their charges', () => {
  reset()
  try {
    for (let i = 0; i < 4; i++) feed(1, T0, 'acme/boss')
    assert.equal(close(charge('acme/boss', T0), 4), true, `four events, a charge of 4 (${charge('acme/boss', T0)})`)
    assert.equal(close(charge('acme/boss', T0 + 60_000), 2), true, 'halving every 60 s')
    const plain = feed(0, T0).lift
    const charged = feed(0, T0, 'acme/boss').lift
    assert.equal(charged > plain, true, `a charged agent's effect is lifted more (${charged} > ${plain})`)
    feed(2, T0, 'acme/dave')
    feed(1, T0, 'acme/dave', 'acme/boss')
    assert.equal(close(charge('acme/dave', T0), 7), true, `dave (3) meeting boss (4) combine to 7 (${charge('acme/dave', T0)})`)
    assert.equal(close(charge('acme/boss', T0), 7), true, `and so does boss (${charge('acme/boss', T0)})`)
  } finally { reset() }
})

test('total activity unlocks the extras one at a time, each reported once, by the event that reached it', () => {
  reset()
  try {
    const seen: string[] = []
    let t = T0
    for (let i = 0; i < 300; i++) {
      const gain = feed(2, t += 1000)
      if (gain.unlock) {
        const all = unlocked()
        assert.equal(all[all.length - 1], gain.unlock.extra, 'the newest extra is the one reported')
        seen.push(gain.unlock.extra)
      }
      assert.equal(unlocked().length, seen.length, 'one at a time, in the order reported')
    }
    assert.deepEqual(seen, ['embers', 'afterimages', 'echoes', 'aurora'], `every extra once, in the plan's order (${seen.join(', ')})`)
    assert.equal(total(), 600, 'the total counts every event\'s weight')
  } finally { reset() }
})

test('crossing a momentum tier is reported once, by the event that crossed it, and again only after falling back', () => {
  reset()
  try {
    const crossed: number[] = []
    for (let i = 0; i < 8; i++) { const gain = feed(1, T0); if (gain.tier) crossed.push(gain.tier) }
    assert.deepEqual(crossed, [10], `one tier crossed (${crossed.join(', ')})`)
    for (let i = 0; i < 3; i++) { const gain = feed(0.1, T0 + i); if (gain.tier) crossed.push(gain.tier) }
    assert.deepEqual(crossed, [10], 'nothing more within the tier')
    const later = T0 + 120_000
    assert.equal(momentum(later) < 10, true, 'two quiet minutes and momentum is back under the tier')
    for (let i = 0; i < 8; i++) { const gain = feed(1, later); if (gain.tier) crossed.push(gain.tier) }
    assert.deepEqual(crossed, [10, 10], `and crossing it again is reported again (${crossed.join(', ')})`)
  } finally { reset() }
})

test('momentum makes the show bigger within its caps: more particles, stronger shakes, residue that lasts longer', () => {
  const clock = clockwork()
  const bursts = spy('burst')
  const shakes = spy('shake')
  reset()
  const show = startEpic({ audio: fakeAudio().Ctor, greet: 'none' })
  try {
    show.cue('turnEnd', { spot: at(300, 200), node: 'alice' })
    const calm = Math.max(...bursts.calls.map(c => c.intensity))
    const calmShake = Math.max(0, ...shakes.calls.map(c => Number(c.args[0] ?? 0)))
    assert.equal(calm < 1.15, true, `from rest the show gives about what it always did (${calm})`)
    for (let i = 0; i < 120; i++) feed(2, performance.now())
    bursts.calls.length = 0
    shakes.calls.length = 0
    clock.run(1000)
    show.cue('turnEnd', { spot: at(600, 400), node: 'bob' })
    const busy = Math.max(...bursts.calls.map(c => c.intensity))
    const busyShake = Math.max(0, ...shakes.calls.map(c => Number(c.args[0] ?? 0)))
    assert.equal(busy >= 1.8, true, `in a busy spell its particles come up to twice over (${busy})`)
    assert.equal(busyShake > calmShake, true, `and it shakes harder (${busyShake} > ${calmShake})`)
    clock.run(10_000)
    const lasting = bursts.calls[0]?.self.lingering.some(r => r.kind === 'afterglow' && Math.hypot(r.x - 600, r.y - 400) < 2)
    assert.equal(lasting, true, 'its afterglow (8 s at rest) still shows 10 s on')
  } finally { show.stop(); bursts.restore(); shakes.restore(); reset(); clock.restore() }
})

test('crossing a momentum tier makes what lingers flare once, only inside an event, never on a timer', () => {
  const clock = clockwork()
  const chains = spy('chain')
  reset()
  const show = startEpic({ audio: fakeAudio().Ctor, greet: 'none' })
  try {
    show.cue('error', { spot: at(300, 300) })
    for (let i = 0; i < 4; i++) feed(1, performance.now())
    clock.run(400)
    assert.equal(chains.calls.length, 0, 'under the first tier, nothing flares')
    show.cue('hire', { spot: at(600, 300), node: 'zed' })
    assert.equal(chains.calls.length >= 1, true, `the hire crossed the tier: what lingers flares (${chains.calls.length})`)
    const once = chains.calls.length
    show.cue('question', { spot: at(500, 200), node: 'amy' })
    clock.run(60_000)
    assert.equal(chains.calls.length, once, 'nothing more within the tier, and nothing as time passes')
  } finally { show.stop(); chains.restore(); reset(); clock.restore() }
})

test('each extra is announced once in the corner, then plays: embers, word afterimages, echo rings, an aurora while momentum is high', () => {
  const clock = clockwork()
  const toasts = spy('toast')
  const rings = spy('ring')
  reset()
  const show = startEpic({ audio: fakeAudio().Ctor, greet: 'none' })
  /** bring the session's total to `to` without the show (each step weighs 2 or 1) */
  const upTo = (to: number) => { while (total() < to) feed(to - total() >= 2 ? 2 : 1, performance.now()) }
  const announced = (i: number) => String(toasts.calls[i]?.args[0] ?? '')
  try {
    upTo(24)
    show.cue('error', { spot: at(300, 300) })
    assert.equal(toasts.calls.length, 1, `the error (heavy, 2) reaches 26 and the first extra is announced (${toasts.calls.length})`)
    assert.equal(announced(0).includes('EMBERS'), true, `embers (${announced(0)})`)
    const stage = toasts.calls[0]!.self
    clock.run(1000)
    show.cue('refused', { spot: at(500, 300) })
    assert.equal(stage.lingering.some(r => r.kind === 'embers' && Math.hypot(r.x - 500, r.y - 300) < 2), true, 'a heavy event now leaves embers')
    upTo(73)
    clock.run(1000)
    show.cue('hire', { spot: at(700, 300), node: 'kim' })
    assert.equal(toasts.calls.length, 2, 'the hire (heavy, 2) reaches 75: the second extra is announced')
    assert.equal(announced(1).includes('AFTERIMAGES'), true, `word afterimages (${announced(1)})`)
    clock.run(2000)
    assert.equal(stage.lingering.some(r => r.kind === 'afterimage'), true, 'and the hire\'s word leaves its afterimage')
    upTo(199)
    clock.run(1000)
    rings.calls.length = 0
    show.cue('question', { spot: at(400, 200), node: 'amy' })
    assert.equal(toasts.calls.length, 3, 'the question (medium, 1) reaches 200: the third extra is announced')
    assert.equal(announced(2).includes('ECHO RINGS'), true, `echo rings (${announced(2)})`)
    assert.equal(rings.calls.some(c => {
      const o = c.args[2] as { color?: string; delay?: number } | undefined
      return o?.color === '#ffffff' && (o.delay ?? 0) >= 0.2
    }), true, 'and an echo ring follows it')
    upTo(499)
    clock.run(1000)
    show.cue('ticketDone', { spot: at(300, 500) })
    assert.equal(toasts.calls.length, 4, 'the closed ticket reaches 501: the fourth extra is announced')
    assert.equal(announced(3).includes('AURORA'), true, `the aurora (${announced(3)})`)
    assert.equal(stage.lingering.some(r => r.kind === 'aurora'), true, 'and with momentum high an aurora shows')
    show.cue('ticket', { spot: at(320, 520) })
    assert.equal(toasts.calls.length, 4, 'no extra is announced twice')
    clock.run(240_000)
    assert.equal(stage.lingering.some(r => r.kind === 'aurora'), false, 'four quiet minutes later the aurora is gone')
  } finally { show.stop(); toasts.restore(); rings.restore(); reset(); clock.restore() }
})

test('progression lives for the app session: it carries across EPIC Mode turning off and on', () => {
  const clock = clockwork()
  const bursts = spy('burst')
  reset()
  try {
    const first = startEpic({ audio: fakeAudio().Ctor, greet: 'none' })
    for (let i = 0; i < 120; i++) feed(2, performance.now())
    first.stop()
    clock.run(2000)
    const second = startEpic({ audio: fakeAudio().Ctor, greet: 'none' })
    try {
      bursts.calls.length = 0
      second.cue('turnEnd', { spot: at(300, 200), node: 'alice' })
      const lift = Math.max(...bursts.calls.map(c => c.intensity))
      assert.equal(lift >= 1.8, true, `turned off and on, the momentum is still there (${lift})`)
      assert.equal(momentum(performance.now()) > 10, true, 'and readable')
    } finally { second.stop() }
  } finally { bursts.restore(); reset(); clock.restore() }
})
