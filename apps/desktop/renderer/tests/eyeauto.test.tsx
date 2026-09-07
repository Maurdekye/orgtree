// eyeauto.test.tsx — the OPTIONAL switchboard auto-open (user 2026-09-01).
//
// The rule: while the user is AT the switchboard (EyeDesk mounts only
// focused), a NEW direct line — an agent hired with a user audience, or an
// existing agent granted one — opens its panel immediately IF the toggle is
// on AND one more panel still fits without horizontal scrolling. Everything
// else keeps №24: new lines arrive as minimized lit tabs. The toggle is OFF
// by default.
//
// Anti-vacuity: §1 proves the DEFAULT still minimizes (the fixture would
// auto-open if the toggle leaked on); §4 proves the mount catch-up pass
// minimizes even with the toggle on, so §2's live-arrival open cannot pass
// via the mount path.
//
// Run:  cd frontend && node tests/run.mjs eyeauto

import { FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { EyeDesk } from '../src/canvas/cards'
import { DESK_SCALE, deskDpi, USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

function agent(id: string): CanvasNode {
  return {
    id, state: 'live', tier: 'haiku', model_id: 'haiku', parent: USER,
    mail_pending: 0, children: [], seat: 1, grant: 0, free: 0,
    audiences_held: [], scope: { tools: {}, add_dirs: [] },
  } as unknown as CanvasNode
}

/** eyeW that yields exactly `panels` × (420px + gap) of inner row space */
function eyeWFor(panels: number): number {
  const innerW = panels * 420 + (panels - 1) * 10 + 25
  return Math.ceil(innerW * DESK_SCALE * deskDpi()) + 4
}

let pushIds: ((ids: string[]) => void) | null = null

function Rig({ slug, eyeW }: { slug: string; eyeW: number }) {
  const [ids, setIds] = useState(['first'])
  pushIds = setIds
  const map = new Map<string, CanvasNode>(ids.map((id) => [id, agent(id)]))
  return <EyeDesk map={map} op={op} slug={slug} toast={noop} pip={null}
    pub={false} eyeW={eyeW} posX={() => 0} onMailLink={noop} />
}

const tabs = (el: HTMLElement) => [...el.querySelectorAll('.eye-tab')]
const openPanels = (el: HTMLElement) => el.querySelectorAll('.eye-panel').length
const tabFor = (el: HTMLElement, id: string) =>
  tabs(el).find((x) => x.textContent?.includes(id))

async function rig(t: { after(fn: () => unknown): void }, slug: string,
  eyeW: number, preset?: { auto?: boolean; seen?: string[] }) {
  useFakeClock()
  installFetch(new FakeServer())
  t.after(() => realClock())
  localStorage.removeItem('orgtree-eyemin-' + slug)
  if (preset?.seen) {
    localStorage.setItem('orgtree-eyeseen-' + slug,
      JSON.stringify(preset.seen))
  } else localStorage.removeItem('orgtree-eyeseen-' + slug)
  if (preset?.auto) localStorage.setItem('orgtree-eyeauto-' + slug, '1')
  else localStorage.removeItem('orgtree-eyeauto-' + slug)
  const view = await mountView(<Rig slug={slug} eyeW={eyeW} />, (el) => el)
  t.after(() => view.unmount())
  await flush()
  return view
}

test('§1 DEFAULT (toggle off): a line arriving live still minimizes — №24 holds', async (t) => {
  const view = await rig(t, 'ea1', eyeWFor(3))     // room is NOT the blocker
  assert.equal(openPanels(view.el), 1, 'the first line renders open')
  await inAct(() => pushIds!(['first', 'newbie']))
  await flush()
  assert.ok(tabFor(view.el, 'newbie'), 'the new line got its tab')
  assert.ok(!tabFor(view.el, 'newbie')!.classList.contains('on'),
    'off-by-default: the new line must arrive minimized')
  assert.equal(openPanels(view.el), 1, 'no second panel opened')
  const auto = view.el.querySelector('.eye-auto')!
  assert.ok(auto, 'the toggle renders')
  assert.ok(!auto.classList.contains('on'), 'and reads OFF by default')
})

test('§2 toggle on + room: a live-arriving line opens its panel immediately', async (t) => {
  const view = await rig(t, 'ea2', eyeWFor(3), { auto: true })
  assert.equal(openPanels(view.el), 1)
  await inAct(() => pushIds!(['first', 'opened']))
  await flush()
  assert.ok(tabFor(view.el, 'opened')!.classList.contains('on'),
    'the tab reads open')
  assert.equal(openPanels(view.el), 2, 'the panel opened alongside the first')
  const minned = JSON.parse(
    localStorage.getItem('orgtree-eyemin-ea2') || '[]') as string[]
  assert.ok(!minned.includes('opened'), 'nothing minimized it durably')
})

test('§3 toggle on but NO room: the line minimizes rather than cause scrolling', async (t) => {
  const view = await rig(t, 'ea3', eyeWFor(1), { auto: true })
  assert.equal(openPanels(view.el), 1, 'the row is exactly full')
  await inAct(() => pushIds!(['first', 'crowded']))
  await flush()
  assert.ok(!tabFor(view.el, 'crowded')!.classList.contains('on'),
    'a full row must not auto-open into horizontal scroll')
  assert.equal(openPanels(view.el), 1)
})

test('§4 mount catch-up: lines that arrived while AWAY minimize even with the toggle on', async (t) => {
  // the user's condition is "at the same time they're hired", and a mount is
  // not that moment: 'first' was seen before; 'away' arrived while the camera
  // was elsewhere; both are already in the map when the switchboard opens
  pushIds = null
  useFakeClock()
  installFetch(new FakeServer())
  t.after(() => realClock())
  localStorage.removeItem('orgtree-eyemin-ea4')
  localStorage.setItem('orgtree-eyeseen-ea4', JSON.stringify(['first']))
  localStorage.setItem('orgtree-eyeauto-ea4', '1')
  const map = new Map<string, CanvasNode>(
    [agent('first'), agent('away')].map((a) => [a.id, a]))
  const view = await mountView(
    <EyeDesk map={map} op={op} slug="ea4" toast={noop} pip={null} pub={false}
      eyeW={eyeWFor(3)} posX={() => 0} onMailLink={noop} />, (el) => el)
  t.after(() => view.unmount())
  await flush()
  assert.ok(!tabFor(view.el, 'away')!.classList.contains('on'),
    'the catch-up pass keeps №24 — arriving-while-away is not arriving-now')
  assert.equal(openPanels(view.el), 1)
})

test('§5 the toggle persists per org and arms without a reload', async (t) => {
  const view = await rig(t, 'ea5', eyeWFor(3))
  const auto = () => view.el.querySelector('.eye-auto')!
  await inAct(() => { (auto() as HTMLElement).click() })
  await flush()
  assert.ok(auto().classList.contains('on'), 'the click armed it')
  assert.equal(localStorage.getItem('orgtree-eyeauto-ea5'), '1', 'persisted')
  await inAct(() => pushIds!(['first', 'armedopen']))
  await flush()
  assert.ok(tabFor(view.el, 'armedopen')!.classList.contains('on'),
    'a line arriving after arming opens')
  await inAct(() => { (auto() as HTMLElement).click() })
  await flush()
  assert.equal(localStorage.getItem('orgtree-eyeauto-ea5'), '0',
    'disarming persists too')
})
