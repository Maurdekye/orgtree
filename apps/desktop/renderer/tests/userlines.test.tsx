// userlines.test.tsx — the canvas draws the USER's connections to a project
// (docket canvas-draw-project-lines-and-watchdogs-for-the-u; USER 2026-10-21
// 22:18:43Z: "when the user is connected to a project as a listener or slot
// hold, draw a coloured line between the project and the switchboard as it
// would be drawn between the project and the agent, and show a watchdog below
// the switchboard as well"). The engine names the user's registrations
// "user"; the switchboard is the canvas's eye card (id `@user`).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the link helpers keep the user's rows (owner "user") beside the
//      agents': slot hold and wait, project listener and watch, fair queue
//      (this REPLACES the earlier "the user draws no canvas line" rule)
//   §2 the mounted canvas draws, from the eye card, the same coloured lines
//      an agent gets (amber slot line, solid for a hold; cyan listener line;
//      the fair-queue line), nest on their own lanes with an agent's lines
//      to the same project, and show the user's watchdog chips BELOW the eye
//      card, each tethered to it
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs userlines

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { advance, FakeServer, flush, installFetch, mountView, realClock, useFakeClock } from './harness'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import { DOG_H, DOG_W, USER, setChartLayout, setHideRetiredOn } from '../src/canvas/shared'
import { listenerLinks } from '../src/canvas/listeners'
import { slotLinks } from '../src/canvas/slots'
import { fairQueueLinks } from '../src/canvas/shared'
import { agent, bunchTree, project, retired } from './projectbunch-fixture'
import type { TreePayload, Watchdog } from '../src/types'

const W = window as unknown as Window & typeof globalThis
const numbers = (s: string) => (s.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []).map(Number)
const isProject = (p: string) => p === 'build'
const dog = (kind: Watchdog['kind'], owner: string, name: string, extra: Partial<Watchdog> = {}): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind, target: 'build', interval_s: 5, state: 'armed',
    at: '2026-10-21T07:00:00.000Z', fired: 0, once: false, spent: false, metadata_only: true, ...extra } as Watchdog)
const lease = (agentName: string, slot: number, lid: string) =>
  ({ project: 'build', agent: agentName, slot, lease: lid, since: '2026-10-21T09:00:00Z' })

/* ─── §1 the helpers ───────────────────────────────────────────────────── */

test('§1 the link helpers keep the user\'s rows, owner "user", beside the agents\'', () => {
  const dogs = [dog('slot', 'user', 'uh', { queued_at: '2026-10-21T09:10:00Z' }), dog('slot', 'qa', 'w', { queued_at: '2026-10-21T09:11:00Z' }),
    dog('project_listener', 'user', 'u1'), dog('project_listener', 'sa', 'a'),
    dog('listener_watch', 'user', 'uw', { count: 2 }),
    dog('fair_queue', 'user', 'uq'), dog('fair_queue', 'sa', 'q')]
  const leases = [lease('user', 1, 'sU'), lease('dev', 2, 'sD')]
  assert.deepEqual(slotLinks(dogs, leases, isProject).map((l) => `${l.owner}:${l.holding ? 'hold' : 'wait'}`).sort(),
    ['dev:hold', 'qa:wait', 'user:hold', 'user:wait'])
  assert.deepEqual(listenerLinks(dogs, isProject).map((l) => `${l.owner}:${l.watch ? 'watch' : 'listener'}`).sort(),
    ['sa:listener', 'user:listener', 'user:watch'])
  assert.deepEqual(fairQueueLinks(dogs, isProject).map((l) => l.owner).sort(), ['sa', 'user'])
})

/* ─── §2 the mounted canvas ────────────────────────────────────────────── */

async function canvas(t: TestContext, tree: TreePayload, hideRetired = false) {
  useFakeClock(); t.after(realClock)
  resetConvos()
  localStorage.clear()
  setChartLayout('row')
  localStorage.setItem('orgtree-canvas-gl-wires', 'off')
  localStorage.setItem('orgtree-start-zoom', '0')
  if (hideRetired) setHideRetiredOn(true)
  const proto = W.HTMLElement.prototype
  const old = { rect: proto.getBoundingClientRect, w: Object.getOwnPropertyDescriptor(proto, 'clientWidth'),
    h: Object.getOwnPropertyDescriptor(proto, 'clientHeight'), capture: proto.setPointerCapture }
  proto.setPointerCapture = () => {}
  proto.getBoundingClientRect = function () {
    return this.classList.contains('viewport') ? { left: 0, top: 0, right: 1600, bottom: 1000, width: 1600, height: 1000 } as DOMRect
      : old.rect.call(this)
  }
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return this.classList.contains('viewport') ? 1600 : 0 } })
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return this.classList.contains('viewport') ? 1000 : 0 } })
  t.after(() => {
    proto.getBoundingClientRect = old.rect; proto.setPointerCapture = old.capture
    if (old.w) Object.defineProperty(proto, 'clientWidth', old.w)
    if (old.h) Object.defineProperty(proto, 'clientHeight', old.h)
  })
  const previous = globalThis.fetch
  installFetch(new FakeServer())
  t.after(() => { globalThis.fetch = previous })
  const view = await mountView(<OrgCanvas tree={tree} slug={tree.slug} mailEvt={null} toast={() => {}}
    op={async () => ({}) as never} />, el => el)
  t.after(() => view.unmount())
  await flush(); await advance(3000, 50); await flush()
  return view
}
const treeWith = (extra: Partial<TreePayload>) => ({
  ...bunchTree([agent('boss', [project('build', [agent('dev')])])]), ...extra }) as TreePayload
const at = (el: HTMLElement, sel: string) => {
  const c = el.querySelector<HTMLElement>(sel)
  assert.ok(!!c, `${sel} present`)
  const [x, y] = numbers(c!.style.transform)
  return { x: x!, y: y! }
}
const count = (el: HTMLElement, sel: string) => el.querySelectorAll(sel).length

test('§2 a user slot hold, listener and watch draw the agents\' coloured lines from the switchboard', async t => {
  const view = await canvas(t, treeWith({
    slot_leases: [lease('user', 1, 'sU')] as never,
    watchdogs: [dog('project_listener', 'user', 'u1'), dog('listener_watch', 'user', 'uw', { count: 2 })],
  }))
  assert.equal(count(view.el, 'path.slot-line'), 1, 'the user\'s slot hold: an amber line')
  assert.equal(count(view.el, 'path.slot-line.wait'), 0, 'a hold is solid')
  assert.equal(count(view.el, 'path.listener-line'), 1, 'the user\'s listener: the cyan line')
  assert.equal(count(view.el, 'path.listener-watch-line'), 1, 'the user\'s watch: the dashed cyan line')
  // the line starts at the switchboard's side, not at some stray point
  const eye = at(view.el, '.sq.user'), pj = at(view.el, '.sq[data-copy-agent-name="build"]')
  const d = numbers(view.el.querySelector('path.slot-line')!.getAttribute('d') ?? '')
  assert.ok(Math.abs(d[0]! - (eye.x + 124)) < 1, 'it leaves the eye card\'s right edge')
  assert.ok(Math.abs(d[d.length - 2]! - (pj.x + 124)) < 1 + 60, 'and arrives at the project')
})

test('§2 a waiting user slot claim and the user\'s fair-queue place draw their lines too', async t => {
  const view = await canvas(t, treeWith({
    watchdogs: [dog('slot', 'user', 'uh', { queued_at: '2026-10-21T09:10:00Z' }), dog('fair_queue', 'user', 'uq')],
  }))
  assert.equal(count(view.el, 'path.slot-line.wait'), 1, 'a waiter\'s dashed amber line')
  assert.equal(count(view.el, 'path.fq-line'), 1, 'the fair-queue line')
})

test('§2 the user\'s lines nest beside an agent\'s to the same project, never on top of it', async t => {
  const view = await canvas(t, treeWith({
    slot_leases: [lease('user', 1, 'sU'), lease('dev', 2, 'sD')] as never,
  }))
  const lines = [...view.el.querySelectorAll('path.slot-line')].map((p) => numbers(p.getAttribute('d') ?? ''))
  assert.equal(lines.length, 2)
  assert.notEqual(lines[0]![1], lines[1]![1], 'each its own start height')
})

test('§2 the user\'s watchdogs show as chips BELOW the switchboard, tethered to it', async t => {
  const view = await canvas(t, treeWith({
    watchdogs: [dog('project_listener', 'user', 'u1'), dog('fair_queue', 'user', 'uq')],
  }))
  const eye = at(view.el, '.sq.user')
  const chips = [...view.el.querySelectorAll<HTMLElement>('.wd-chip')]
  assert.equal(chips.length, 2, 'one chip per user dog')
  for (const chip of chips) {
    const [, y] = numbers(chip.style.transform)
    assert.ok(y! >= eye.y + 124, 'below the eye card')
  }
  assert.ok(count(view.el, 'path.tether.wd') >= 1, 'a tether wire from the chips to the eye card')
  assert.equal(USER, '@user')
})

/* ─── §3 the eye's three satellites keep clear of one another ───────────── */

// USER 2026-10-21 22:34Z: "make sure the watchdogs dont interfere with the retired card under the switchboard".
// Under the eye sit (at rest) the root's "N retired" badge and now the user's watchdog chips; the hire chips
// are the card's own hover strip, drawn above both. The badge and the chips must not overlap at rest.
const BADGE_H = 20   // measured: 13px at the 0.64 map scale
const rectOf = (el: HTMLElement, w: number, h: number) => { const [x, y] = numbers(el.style.transform); return { x: x!, y: y!, w, h } }
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
for (const dogs of [1, 3, 5, 8, 9]) {
  test(`§3 ${dogs} user watchdog(s) and the root retired badge under the switchboard never overlap`, async t => {
    const view = await canvas(t, treeWith({
      roots: [retired(agent('old-boss')), ...bunchTree([agent('boss', [project('build', [agent('dev')])])]).roots],
      watchdogs: Array.from({ length: dogs }, (_, i) => dog(i % 2 ? 'project_listener' : 'fair_queue', 'user', 'd' + i)),
    }), true)
    const badge = view.el.querySelector<HTMLElement>('.root-retired-list')
    assert.ok(!!badge, 'fixture: the root retired badge shows')
    const eye = at(view.el, '.sq.user'), b = rectOf(badge!, 60, BADGE_H)
    assert.ok(b.y >= eye.y + 124, 'fixture: the badge is below the eye card')
    const chips = [...view.el.querySelectorAll<HTMLElement>('.wd-chip')]
    assert.equal(chips.length, dogs > 8 ? 1 : dogs, dogs > 8 ? 'more than eight dogs share one group card' : 'one chip per dog')
    const child = at(view.el, '.sq[data-copy-agent-name="boss"]')
    for (const chip of chips) {
      const c = rectOf(chip, dogs > 8 ? 104 : DOG_W, DOG_H)
      assert.equal(overlap(b, c), false, `a watchdog chip at ${c.x},${c.y} overlaps the retired badge at ${b.x},${b.y}`)
      assert.ok(c.y + c.h <= child.y, `a watchdog chip at ${c.x},${c.y} reaches the card below the switchboard (${child.y})`)
    }
  })
}
