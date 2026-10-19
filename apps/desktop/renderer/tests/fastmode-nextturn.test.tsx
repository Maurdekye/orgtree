import { mountView, inAct, flush, installFetch, FakeServer } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordOverlay } from '../src/recordoverlay'
import { FastModeButton } from '../src/canvas/fastmodebutton'
import { QueuedFastBadge } from '../src/canvas/nextturn'
import { syncProviderRegistries } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'

const node = (requested: boolean, current: boolean | null | undefined, busy = true): CanvasNode => ({
  id: 'worker', tier: 'sol', state: 'live', children: [], busy,
  scope: { tools: {}, add_dirs: [], fast_mode: requested }, fast_mode_current: current,
} as CanvasNode)
const control = (n: CanvasNode) => <><QueuedFastBadge node={n} />
  <FastModeButton node={n} slug="fixture" toast={() => {}} /></>
const badge = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-next-turn="fast"]')
test.beforeEach(() => {
  syncProviderRegistries({ providers: [{ id: 'openai', tiers: [{ tier: 'sol', fast_mode: true }] }] })
  installFetch(new FakeServer())
})

for (const requested of [true, false]) test(`serving evidence shows next turn fast ${requested ? 'on' : 'off'} beside bolt`, async () => {
  const view = await mountView(control(node(requested, !requested)), el => el)
  try {
    const pending = badge(view.el)
    assert.equal(!!pending, true, 'the running turn still uses the opposite speed')
    assert.equal(pending!.textContent, `next turn \u2192 fast ${requested ? 'on' : 'off'}`)
    assert.equal(pending!.title, `worker's fast will change from fast ${requested ? 'off' : 'on'} to fast ${requested ? 'on' : 'off'} next turn`)
    assert.equal(pending!.getAttribute('aria-label'), pending!.title)
    assert.equal(pending!.parentElement?.querySelector('[aria-label="Fast mode"]') !== null, true)
    await view.render(control(node(requested, requested)))
    assert.equal(badge(view.el) === null, true, 'next admission clears the pending marker')
  } finally { await view.unmount() }
})

test('reverting a queued setting clears the badge without waiting for another turn', async () => {
  const view = await mountView(control(node(true, false)), el => el)
  try {
    assert.equal(!!badge(view.el), true)
    await view.render(control(node(false, false)))
    assert.equal(badge(view.el) === null, true)
  } finally { await view.unmount() }
})

test('idle, matching, missing and unknown serving states never invent a pending change', async () => {
  for (const n of [node(true, null), node(true, undefined), node(true, true), node(false, false), node(true, false, false)]) {
    const view = await mountView(control(n), el => el)
    try { assert.equal(badge(view.el) === null, true) }
    finally { await view.unmount() }
  }
})

test('successful save alone does not invent serving evidence or an optimistic pending badge', async () => {
  const view = await mountView(control(node(false, undefined)), el => el)
  try {
    await inAct(async () => { view.el.querySelector<HTMLButtonElement>('button')!.click(); await flush(3) })
    assert.equal(badge(view.el) === null, true)
    await view.render(control(node(true, undefined)))
    assert.equal(badge(view.el) === null, true)
  } finally { await view.unmount() }
})

test('unsupported and retired seats hide the bolt and pending fast badge together', async () => {
  for (const extra of [{ tier: 'haiku' }, { state: 'archived' }]) {
    const view = await mountView(control({ ...node(true, false), ...extra } as CanvasNode), el => el)
    try {
      assert.equal(view.el.querySelector('[aria-label="Fast mode"]') === null, true)
      assert.equal(badge(view.el) === null, true)
    } finally { await view.unmount() }
  }
})


test('runtime feed carries accepted speed, clears on idle, and ignores stale frames', async () => {
  const identity = { org_uuid: 'fixture-org', incarnation: 'fixture-engine' }
  const frame = (seq: number, busy: boolean, current: boolean | null) => ({
    ...identity, type: 'agent_runtime' as const, epoch: 'host', seq, full: true,
    agents: { worker: { epoch: 'host', seq, busy, fast_mode_current: current } },
  })
  let overlay = new RecordOverlay(identity).receive(frame(1, true, false), true)
  const projected = () => ({ ...node(true, undefined), ...overlay.values.get('worker') } as CanvasNode)
  assert.equal(projected().fast_mode_current, false, 'serving false must survive the runtime allowlist')
  const view = await mountView(control(projected()), el => el)
  try {
    assert.equal(!!badge(view.el), true)
    overlay = overlay.receive(frame(2, false, null))
    await view.render(control(projected()))
    assert.equal(projected().fast_mode_current, null)
    assert.equal(badge(view.el) === null, true)
    overlay = overlay.receive(frame(1, true, false))
    await view.render(control(projected()))
    assert.equal(badge(view.el) === null, true, 'stale serving evidence cannot resurrect a pending change')
    overlay = overlay.receive(frame(3, true, true))
    await view.render(control(projected()))
    assert.equal(projected().fast_mode_current, true)
    assert.equal(badge(view.el) === null, true)
  } finally { await view.unmount() }
})
