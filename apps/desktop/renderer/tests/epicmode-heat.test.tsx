import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { HeatField, HEAT_IMPULSE } from '../src/epic/heatfield'
import { SoundHeatmap } from '../src/epic/heatmap'
import { clockwork } from './epicmode-fakes'
import { publishEpicCanvas, clearEpicTree } from '../src/epic/tap'

test('delta impulses diffuse to neighbours, accumulate with actions, and lose heat to ambient', () => {
  const f = new HeatField(0, 0, 1024, 1024), p = { x: 512, y: 512 }
  f.impulse(p)
  assert.ok(Math.abs(f.at(p.x, p.y) - HEAT_IMPULSE) < 1e-6)
  f.advance(0.25, [])
  assert.equal(f.at(544, 512) > 0, true, 'heat actually transfers between grid cells')
  assert.equal(f.at(512, 512) < HEAT_IMPULSE, true)
  const warm = f.peak
  f.advance(3, [])
  assert.equal(f.peak < warm, true, 'an idle source cools gradually')
  f.impulse(p); const one = f.at(512, 512); f.impulse(p)
  assert.equal(f.at(512, 512) > one, true)
  for (let i = 0; i < 100; i++) f.impulse(p)
  assert.equal(f.at(512, 512), 1)
})

test('fixed continuous flux heats with work time; overlapping sources add and remain capped', () => {
  const p = { x: 512, y: 512 }, a = new HeatField(0, 0, 1024, 1024), b = new HeatField(0, 0, 1024, 1024)
  a.advance(1, [p]); const early = a.at(512, 512)
  a.advance(5, [p])
  assert.equal(a.at(512, 512) > early, true, 'sustained work heats up')
  b.advance(6, [p, p])
  assert.equal(b.at(512, 512) > a.at(512, 512) * 1.8, true)
  b.advance(3600, Array.from({ length: 1000 }, () => p))
  assert.equal(b.values.every(v => Number.isFinite(v) && v >= 0 && v <= 1), true)
  assert.equal(b.values.length <= 96 * 96, true)
})

test('Jacobi diffusion is symmetric and independent of rendering cadence', () => {
  const p = { x: 528, y: 528 }, a = new HeatField(0, 0, 1024, 1024), b = new HeatField(0, 0, 1024, 1024)
  a.impulse(p); b.impulse(p)
  a.advance(1, [])
  for (let i = 0; i < 4; i++) b.advance(0.25, [])
  assert.equal(Math.abs(a.at(528, 528) - b.at(528, 528)) < 1e-6, true)
  assert.equal(Math.abs(a.at(496, 528) - a.at(560, 528)) < 1e-6, true)
  assert.equal(Math.abs(a.at(528, 496) - a.at(528, 560)) < 1e-6, true)
})

test('a thousand independent sources use one bounded diffusion grid', () => {
  const field = new HeatField(0, 0, 32_768, 32_768)
  const points = Array.from({ length: 1000 }, (_, i) => ({ x: 256 + (i % 32) * 960, y: 256 + Math.floor(i / 32) * 960 }))
  const start = performance.now()
  for (let i = 0; i < 30; i++) field.advance(1 / 15, points)
  const milliseconds = (performance.now() - start) / 30
  console.log(`1000 sources: ${field.cols}x${field.rows}, ${milliseconds.toFixed(3)} ms per 15 Hz simulation step`)
  assert.equal(field.values.length, 96 * 96)
  assert.equal(field.peak > 0 && field.peak <= 1, true)
})

test('the field lives beneath cards in world space; motion preference yields a static baseline without impulses', () => {
  const clock = clockwork()
  const host = document.createElement('div')
  host.className = 'viewport'
  host.innerHTML = '<div class="space" style="width:1024px;height:1024px"><div data-first-use-agent="a" style="transform:translate(400px,400px);width:200px;height:100px"></div></div>'
  document.body.append(host)
  const had = window.matchMedia
  window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  const heat = new SoundHeatmap(document)
  try {
    heat.update([{ id: 'a', layer: 'thinking' }]); clock.run(100)
    const canvas = host.querySelector('.epic-heatmap') as HTMLCanvasElement
    assert.equal(!!canvas, true)
    assert.equal(canvas.parentElement?.className, 'space')
    assert.equal(canvas.parentElement?.firstElementChild === canvas, true)
    const frames = clock.frames
    clock.run(1000)
    assert.equal(clock.frames, frames, 'no animation-frame loop for a static reduced-motion field')
    heat.impulse('a'); clock.run(100)
    assert.equal(clock.busy, false, 'reduced motion ignores transient spikes')
    const space = canvas.parentElement!
    space.style.transform = 'translate(100px,200px) scale(0.5)'
    assert.equal(canvas.parentElement, space, 'camera transforms the field with its original world cells')
  } finally { heat.stop(); host.remove(); window.matchMedia = had; clock.restore() }
  assert.equal(document.querySelector('.epic-heatmap') === null, true)
})

test('working cards stay still while heat and wire pulses follow activity', () => {
  const clock = clockwork(), host = document.createElement('div')
  host.className = 'viewport'
  host.innerHTML = '<div class="space" style="width:1024px;height:1024px"><div data-first-use-agent="a" style="transform:translate(400px,400px);width:200px;height:100px"></div></div>'
  document.body.append(host)
  const card = host.querySelector<HTMLElement>('[data-first-use-agent]')!
  let starts = 0
  card.animate = (() => { starts++; return { cancel() {} } }) as typeof card.animate
  const had = window.matchMedia
  let reduced = false, changed = () => {}
  window.matchMedia = (() => ({ get matches() { return reduced }, addEventListener(_event: string, fn: () => void) { changed = fn }, removeEventListener() {} })) as unknown as typeof window.matchMedia
  publishEpicCanvas([{ key: 'a', seg: { kind: 'l', pts: [{ x: 200, y: 400 }, { x: 400, y: 400 }] } }],
    new Map([['a', { x: 400, y: 400 }], ['offscreen', { x: 900, y: 900 }]]))
  const heat = new SoundHeatmap(document)
  try {
    heat.update([{ id: 'a', layer: 'tool' }, { id: 'offscreen', layer: 'thinking' }]); clock.run(100)
    assert.equal(starts, 0, 'working cards never start a piston animation')
    assert.equal(card.style.transform, 'translate(400px,400px)', 'layout/drag transform stays unchanged')
    assert.equal(card.style.translate, '')
    for (const layer of ['thinking', 'writing', 'toolWriting', 'tool', 'waiting', 'compacting', null] as const) {
      heat.update([{ id: 'a', layer }]); clock.run(100)
      assert.equal(starts, 0, `${layer ?? 'hum'} leaves the card still`)
    }
    const state = heat as unknown as { positions: Map<string, unknown>; pulses: unknown[] }
    assert.equal(state.positions.has('offscreen'), true, 'virtualization does not remove physical heat sources')
    heat.pulse('a'); assert.equal(state.pulses.length, 1)
    clock.run(100)
    assert.equal(host.querySelector('.epic-transport circle')?.getAttribute('visibility'), 'visible')
    heat.update([]); clock.run(100)
    assert.equal(starts, 0, 'idle cards remain still')
    reduced = true; changed(); heat.update([{ id: 'a', layer: 'tool' }]); clock.run(100)
    heat.pulse('a')
    assert.equal(starts, 0)
    assert.equal(state.pulses.length, 0)
  } finally { heat.stop(); host.remove(); clearEpicTree(); window.matchMedia = had; clock.restore() }
  assert.equal(document.querySelector('.epic-transport') === null, true)
})
