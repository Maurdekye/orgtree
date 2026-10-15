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
import { startEpic } from '../src/epic/director'
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
