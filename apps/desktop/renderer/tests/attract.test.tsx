// Attract mode (@item:orgtree/attract-mode-the-org-drives-its-own-ui-cycling-t).
// USER 2026-11-02 m79cb0cf57f61 + answers mc8e118c58de9; gap-fills Q1-Q3
// @coordinator-opus m082646bad468.
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import {
  ATTRACT_IDLE_MS, DWELL_MAX_MS, DWELL_MIN_MS, attractCandidates, attractDwell, pickAttract,
  targetKey, useAttractCycle, watchInput,
} from '../src/attract/attract'
import type { AttractInput, AttractRoutes, AttractTarget } from '../src/attract/attract'
import { scrollMs, SCROLL_MAX_MS, SCROLL_PAUSE_MS, SCROLL_PX_PER_S } from '../src/attract/scroll'
import {
  ATTRACT_IDLE_KEY, ATTRACT_IDLE_EVENT, DEFAULT_ATTRACT_IDLE_SECONDS, ATTRACT_KEY, setAttractIdleSeconds,
  setAttractMode, watchAttract, watchAttractIdle,
} from '../src/attract/pref'
import { DEFAULT_PREFERENCES, preferencesPatch } from '../../main/policy'
import { canvasAttractRoutes } from '../src/attract/canvas'
import { markDocViewed } from '../src/canvas/docviewed'
import { readLocally, resetLocalReads } from '../src/mailread'

const SINCE = Date.parse('2026-11-02T12:00:00Z')
const before = '2026-11-02T11:59:00Z', later = '2026-11-02T12:01:00Z'
const input = (over: Partial<AttractInput> = {}): AttractInput =>
  ({ since: SINCE, agents: [], mail: [], docs: [], tickets: [], ...over })
const keys = (ts: AttractTarget[]) => ts.map(targetKey)

test('§1 what counts as new: busy or moved agents, unread mail (oldest), unread docs, moved tickets', () => {
  const got = attractCandidates(input({
    agents: [
      { id: 'quiet', busy: false, activityAt: before, deskTaken: false },
      { id: 'moved', busy: false, activityAt: later, deskTaken: false },
      { id: 'working', busy: true, activityAt: before, deskTaken: false },
      // "it does not focus any agent desks that are already pinned or open elsewhere"
      { id: 'pinned', busy: true, activityAt: later, deskTaken: true },
    ],
    mail: [{ id: 'm-old' }, { id: 'm-new' }],
    docs: [{ id: 'd1', node: 'moved' }],
    tickets: [{ slug: 'old-item', updatedAt: before }, { slug: 'new-item', updatedAt: later }, { slug: 'never', updatedAt: null }],
  }), new Set())
  assert.deepEqual(keys(got), [
    `agent:moved:${later}`, `agent:working:${before}`, 'mail:m-old', 'doc:d1', `ticket:new-item:${later}`,
  ])
})

test('§2 shown this run is not shown again, until that agent or ticket moves again', () => {
  const base = input({
    agents: [{ id: 'a', busy: true, activityAt: later, deskTaken: false }],
    mail: [{ id: 'm1' }, { id: 'm2' }],
    tickets: [{ slug: 't', updatedAt: later }],
  })
  const shown = new Set([`agent:a:${later}`, 'mail:m1', `ticket:t:${later}`])
  assert.deepEqual(keys(attractCandidates(base, shown)), ['mail:m2'])
  const again = '2026-11-02T12:05:00Z'
  const moved = { ...base, agents: [{ ...base.agents[0]!, activityAt: again }], tickets: [{ slug: 't', updatedAt: again }] }
  assert.deepEqual(keys(attractCandidates(moved, shown)), [`agent:a:${again}`, 'mail:m2', `ticket:t:${again}`])
})

test('§3 nothing new: only fit the whole org; otherwise the org is one random choice among them', () => {
  assert.deepEqual(pickAttract([], () => 0.99, null), { kind: 'org' })
  assert.deepEqual(pickAttract([], () => 0, { kind: 'org' }), { kind: 'org' }, 'repeats the org when it is all there is')
  const doc: AttractTarget = { kind: 'doc', id: 'd', node: null }
  const mail: AttractTarget = { kind: 'mail', id: 'm' }
  const picks = new Set([0, 0.4, 0.7, 0.99].map(r => targetKey(pickAttract([doc, mail], () => r, null))))
  assert.deepEqual([...picks].sort(), ['doc:d', 'mail:m', 'org'])
  // never the same target twice in a row
  for (const r of [0, 0.5, 0.99]) assert.notEqual(targetKey(pickAttract([doc, mail], () => r, doc)), 'doc:d')
})

test('§4 dwell is 8-15 s, a presentation at least its scroll; the scroll paces and caps', () => {
  assert.equal(attractDwell(() => 0), DWELL_MIN_MS)
  assert.equal(attractDwell(() => 0.9999), DWELL_MAX_MS)
  assert.equal([DWELL_MIN_MS, DWELL_MAX_MS].join(), '8000,15000')
  assert.equal(attractDwell(() => 0, 40_000), 40_000)
  assert.equal(scrollMs(SCROLL_PX_PER_S * 10), 2 * SCROLL_PAUSE_MS + 10_000)
  assert.equal(scrollMs(1e9), SCROLL_MAX_MS)
})

// ------------------------------------------------------------- the cycle
interface Log { calls: string[] }
function Cycle({ enabled, routes, log, idleMs }: { enabled: boolean; routes: AttractRoutes; log: Log; idleMs?: number }) {
  const running = useAttractCycle(enabled, routes, () => 0, idleMs)
  log.calls.push(`render:${running}`)
  return <span data-running={String(running)} />
}

const routesFor = (log: Log, mail: { id: string }[]): AttractRoutes => ({
  collect: async () => ({ agents: [], mail: mail.filter(m => !log.calls.includes(`show:mail:${m.id}`)), docs: [], tickets: [] }),
  show: (t) => { log.calls.push('show:' + targetKey(t)) },
  hide: (t) => { log.calls.push('hide:' + targetKey(t)) },
  stop: () => { log.calls.push('stop') },
})
const shows = (log: Log) => log.calls.filter(c => c.startsWith('show:') || c.startsWith('hide:') || c === 'stop')
const key = () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }))
// USER 2026-11-03 m6b0b27e6288f "only interacting with the canvas should interrupt
// attract mode": a tiny stand-in for the org canvas (OrgCanvas's .viewport) with
// a node on it, and the panels that live inside the viewport but are not canvas
function scene() {
  const d = window.document
  const mk = (cls: string, parent: Element, tag = 'div') => {
    const e = d.createElement(tag); if (cls) e.className = cls; parent.appendChild(e); return e
  }
  const root = mk('', d.body)
  const viewport = mk('viewport', root)
  const node = mk('node', viewport)
  const desk = mk('desk-over', viewport), deskText = mk('', desk, 'span')
  const overlay = mk('overlay', viewport)
  const tray = mk('tray', viewport)
  const pin = mk('pinwin', viewport)
  const app = mk('custom-app-window', viewport)
  const field = mk('', viewport, 'textarea')
  const outside = mk('settings', root)   // a panel outside the viewport entirely
  return { root, viewport, node, panels: { desk, deskText, overlay, tray, pin, app, field, outside } }
}
const fire = (el: Element | Window, type: string, init: Record<string, unknown> = {}) => {
  const W = window as unknown as Record<string, new (t: string, i?: object) => Event>
  const Ctor = type === 'keydown' ? W.KeyboardEvent : type === 'wheel' ? W.WheelEvent : W.MouseEvent
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }))
}

test('§5 starts after more than five minutes without input; canvas input stops it and leaves the screen', async () => {
  useFakeClock()
  try {
    watchInput(() => {})()   // the tracker, installed
    key()                    // the last input: now on the fake clock
    const log: Log = { calls: [] }
    const view = await mountView(<Cycle enabled routes={routesFor(log, [{ id: 'm1' }])} log={log} />, el => el)
    try {
      const running = () => view.el.querySelector('span')!.dataset.running
      await advance(ATTRACT_IDLE_MS - 1_000, 10_000)
      assert.equal(running(), 'false', 'not before five minutes')
      await advance(2_000, 500)
      assert.equal(running(), 'true')
      // with rng 0 the first pick is the first candidate: the unread mail
      assert.deepEqual(shows(log), ['show:mail:m1'])
      await advance(DWELL_MIN_MS, 500)
      assert.deepEqual(shows(log), ['show:mail:m1', 'hide:mail:m1', 'show:org'], 'nothing new left: the org')
      const sc = scene()
      await inAct(() => { fire(sc.node, 'keydown', { key: 'a' }) })
      assert.equal(running(), 'false')
      assert.equal(shows(log).at(-1), 'stop', 'canvas input stops it; nothing it showed is hidden')
      sc.root.remove()
      await advance(DWELL_MAX_MS * 2, 5_000)
      assert.equal(shows(log).at(-1), 'stop', 'and it stays stopped')
    } finally { await view.unmount() }
  } finally { realClock() }
})

test('§6 a pointer that did not move is not input, and moving never stops a run; off never runs', async () => {
  useFakeClock()
  try {
    watchInput(() => {})()
    const move = (x: number) => window.dispatchEvent(Object.assign(new window.Event('pointermove'), { screenX: x, screenY: 5 }))
    move(1)
    key()
    const log: Log = { calls: [] }
    const view = await mountView(<Cycle enabled routes={routesFor(log, [])} log={log} />, el => el)
    try {
      const running = () => view.el.querySelector('span')!.dataset.running
      await advance(ATTRACT_IDLE_MS + 1_000, 10_000)
      assert.equal(running(), 'true')
      await inAct(() => { move(1) })
      assert.equal(running(), 'true', 'Chromium\'s mousemove at an unmoved cursor is not input')
      await inAct(() => { move(9) })
      assert.equal(running(), 'true', 'moving the mouse is not canvas interaction')
      const sc = scene()
      await inAct(() => { fire(sc.node, 'pointerdown') })
      assert.equal(running(), 'false')
      sc.root.remove()
    } finally { await view.unmount() }
    key()
    const off: Log = { calls: [] }
    const idle = await mountView(<Cycle enabled={false} routes={routesFor(off, [])} log={off} />, el => el)
    try {
      await advance(ATTRACT_IDLE_MS * 2, 30_000)
      assert.equal(idle.el.querySelector('span')!.dataset.running, 'false')
      assert.deepEqual(shows(off), [])
    } finally { await idle.unmount() }
  } finally { realClock() }
  await flush()
})

test('§9 only the canvas stops a run: pointer down, drag, wheel, focused key; panels, fields and mouse moves do not', async () => {
  useFakeClock()
  try {
    watchInput(() => {})()
    const sc = scene()
    const startRun = async (log: Log) => {
      key()
      const view = await mountView(<Cycle enabled routes={routesFor(log, [])} log={log} />, el => el)
      await advance(ATTRACT_IDLE_MS + 1_000, 10_000)
      return view
    }
    const log: Log = { calls: [] }
    const view = await startRun(log)
    try {
      const running = () => view.el.querySelector('span')!.dataset.running
      assert.equal(running(), 'true')
      // input anywhere off the canvas leaves the run going
      const p = sc.panels
      for (const el of [p.desk, p.deskText, p.overlay, p.tray, p.pin, p.app, p.field, p.outside, sc.root]) {
        await inAct(() => { fire(el, 'pointerdown'); fire(el, 'keydown', { key: 'b' }); fire(el, 'wheel', { deltaY: 40 }); fire(el, 'touchstart') })
        assert.equal(running(), 'true', 'panel input does not stop it: ' + (el as Element).className)
      }
      await inAct(() => { fire(window, 'keydown', { key: 'c' }) })   // no focused element at all
      assert.equal(running(), 'true', 'a key with no canvas focus does not stop it')
      await inAct(() => { fire(sc.node, 'pointermove', { screenX: 3, screenY: 4 }); fire(sc.viewport, 'pointermove', { screenX: 8, screenY: 9 }) })
      assert.equal(running(), 'true', 'mouse movement over the canvas does not stop it')
      assert.ok(!shows(log).includes('stop'), 'nothing was stopped')
      // each canvas gesture stops it
      for (const [type, init] of [['pointerdown', {}], ['wheel', { deltaY: -40 }], ['keydown', { key: 'z' }], ['touchstart', {}]] as const) {
        const l: Log = { calls: [] }
        const v = await startRun(l)
        try {
          const r = () => v.el.querySelector('span')!.dataset.running
          assert.equal(r(), 'true')
          await inAct(() => { fire(type === 'pointerdown' ? sc.viewport : sc.node, type, init) })
          assert.equal(r(), 'false', 'canvas ' + type + ' stops it')
          assert.equal(shows(l).at(-1), 'stop')
        } finally { await v.unmount() }
      }
    } finally { await view.unmount() }
    // panel input still counts as input for the START rule: five quiet minutes
    // are measured from the last input anywhere
    key()
    const quiet: Log = { calls: [] }
    const idle = await mountView(<Cycle enabled routes={routesFor(quiet, [])} log={quiet} />, el => el)
    try {
      await advance(ATTRACT_IDLE_MS - 60_000, 10_000)
      await inAct(() => { fire(sc.panels.field, 'keydown', { key: 'd' }) })
      await advance(ATTRACT_IDLE_MS - 60_000, 10_000)
      assert.equal(idle.el.querySelector('span')!.dataset.running, 'false', 'a panel keypress restarts the quiet time')
      await advance(120_000, 10_000)
      assert.equal(idle.el.querySelector('span')!.dataset.running, 'true')
    } finally { await idle.unmount() }
    sc.root.remove()
  } finally { realClock() }
  await flush()
})

// USER 2026-11-03 10:30:13Z me67326548f6c "also allow attract mode's idle timeout
// to be configurable, as low as 0"
test('§10 the start-after setting: default 300 s, whole seconds from 0 up with no maximum, one app-wide preference', async () => {
  assert.equal(DEFAULT_ATTRACT_IDLE_SECONDS, 300)
  assert.equal(ATTRACT_IDLE_MS, 300_000, "the default is today's five minutes")
  assert.equal('attractIdleSeconds' in DEFAULT_PREFERENCES, false, 'absent means the default: nothing stored on a fresh install')
  for (const ok of [0, 1, 300, 86_400, 10_000_000]) assert.deepEqual(preferencesPatch({ attractIdleSeconds: ok }), { attractIdleSeconds: ok })
  for (const bad of [-1, 1.5, '300', null, NaN, Infinity, {}, true]) assert.throws(() => preferencesPatch({ attractIdleSeconds: bad }), String(bad))
  localStorage.removeItem(ATTRACT_IDLE_KEY)
  const seen: number[] = []
  const stop = watchAttractIdle(n => seen.push(n))
  try {
    await setAttractIdleSeconds(0)
    assert.equal(localStorage.getItem(ATTRACT_IDLE_KEY), '0')
    await setAttractIdleSeconds(45)
    await setAttractIdleSeconds(-3)    // refused: nothing stored, nothing announced
    await setAttractIdleSeconds(2.5)
    assert.deepEqual(seen, [300, 0, 45])
    localStorage.setItem(ATTRACT_IDLE_KEY, 'junk')
    window.dispatchEvent(new Event(ATTRACT_IDLE_EVENT))
    assert.equal(seen.at(-1), 300, 'junk reads as the default')
  } finally { stop(); localStorage.removeItem(ATTRACT_IDLE_KEY) }
})

test('§11 the delay is read live: a custom value, a change while waiting, and 0 starting at once', async () => {
  useFakeClock()
  try {
    watchInput(() => {})()
    key()
    const log: Log = { calls: [] }
    const view = await mountView(<Cycle enabled routes={routesFor(log, [])} log={log} idleMs={60_000} />, el => el)
    try {
      const running = () => view.el.querySelector('span')!.dataset.running
      await advance(59_000, 5_000)
      assert.equal(running(), 'false', 'a 60 s delay is not over at 59 s')
      await advance(2_000, 500)
      assert.equal(running(), 'true', 'and is at 61 s')
    } finally { await view.unmount() }
    // changed while waiting: 10 minutes becomes 30 seconds without a restart
    key()
    const l2: Log = { calls: [] }
    const v2 = await mountView(<Cycle enabled routes={routesFor(l2, [])} log={l2} idleMs={600_000} />, el => el)
    try {
      await advance(20_000, 5_000)
      assert.equal(v2.el.querySelector('span')!.dataset.running, 'false')
      await v2.render(<Cycle enabled routes={routesFor(l2, [])} log={l2} idleMs={30_000} />)
      await advance(15_000, 5_000)
      assert.equal(v2.el.querySelector('span')!.dataset.running, 'true', 'the shorter delay applies to the quiet time already passed')
    } finally { await v2.unmount() }
    // 0: as soon as there is no input
    key()
    const l3: Log = { calls: [] }
    const v3 = await mountView(<Cycle enabled routes={routesFor(l3, [])} log={l3} idleMs={0} />, el => el)
    try {
      await advance(50, 10)
      assert.equal(v3.el.querySelector('span')!.dataset.running, 'true', '0 starts at once')
    } finally { await v3.unmount() }
  } finally { realClock() }
  await flush()
})

test('§12 at 0 a canvas stop restarts as soon as the interaction ends (a held press waits for its release); panel input never stops it', async () => {
  useFakeClock()
  try {
    watchInput(() => {})()
    const sc = scene()
    key()
    const log: Log = { calls: [] }
    const view = await mountView(<Cycle enabled routes={routesFor(log, [])} log={log} idleMs={0} />, el => el)
    try {
      const running = () => view.el.querySelector('span')!.dataset.running
      await advance(50, 10)
      assert.equal(running(), 'true')
      await inAct(() => { fire(sc.panels.field, 'keydown', { key: 'q' }) })
      await advance(50, 10)
      assert.equal(running(), 'true', 'typing in a panel neither stops nor restarts it')
      // a click: stops, then runs again right after
      await inAct(() => { fire(sc.node, 'pointerdown') })
      assert.equal(running(), 'false', 'the canvas press stops it')
      await advance(2_000, 100)
      assert.equal(running(), 'false', 'and it stays stopped while the press is held (a drag)')
      await inAct(() => { fire(sc.node, 'pointerup') })
      await advance(50, 10)
      assert.equal(running(), 'true', 'it is back right after the release')
      // a wheel is over at once
      await inAct(() => { fire(sc.viewport, 'wheel', { deltaY: 30 }) })
      assert.equal(running(), 'false')
      await advance(50, 10)
      assert.equal(running(), 'true')
    } finally { await view.unmount() }
    sc.root.remove()
  } finally { realClock() }
  await flush()
})

test('§7 one app-wide toggle: off by default, flips through the shared store, and the main process accepts only a boolean', async () => {
  assert.equal('attractMode' in DEFAULT_PREFERENCES, false, 'absent means off: nothing stored on a fresh install')
  assert.deepEqual(preferencesPatch({ attractMode: true }), { attractMode: true })
  assert.deepEqual(preferencesPatch({ attractMode: false }), { attractMode: false })
  for (const bad of ['1', 1, null, {}]) assert.throws(() => preferencesPatch({ attractMode: bad }))
  localStorage.removeItem(ATTRACT_KEY)
  const seen: boolean[] = []
  const stop = watchAttract(on => seen.push(on))
  try {
    await setAttractMode(true)
    assert.equal(localStorage.getItem(ATTRACT_KEY), '1')
    await setAttractMode(false)
    assert.deepEqual(seen, [false, true, false])
  } finally { stop(); localStorage.removeItem(ATTRACT_KEY) }
})

// ------------------------------------------------------------- the canvas adapter
test('§8 the canvas routes: pinned or popped-out desks are skipped, real read marks, panels via the shell', async () => {
  const realFetch = globalThis.fetch
  const posted: string[] = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if ((init?.method ?? 'GET') !== 'GET') posted.push(u)
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (u.includes('/work-items-view')) return json({ items: [{ slug: 'moved', updated_at: later }, { slug: 'still', updated_at: before }], counts: { attention: 0, active: 2, archived: 0, backlogged: 0 }, now: later })
    if (u.endsWith('/inbox')) return json({ pending: [{ id: 'm2', at: later }, { id: 'm1', at: before, urgent: true }], delivered: [], sent: [] })
    if (u.includes('/inbox/read')) return json({ read: 1 })
    return json({})
  }) as typeof fetch
  resetLocalReads()
  localStorage.clear()
  try {
    const node = (id: string, extra: Record<string, unknown> = {}) =>
      [id, { id, tier: 'opus', state: 'idle', generation: 1, busy: false, turn_started_at: before, ...extra }] as const
    const map = new Map<string, any>([
      node('free', { busy: true }),
      node('pinned', { busy: true }),
      node('proj', { kind: 'project', busy: true }),
      node('old', { documents: [{ id: 'seen', title: 's', at: before }, { id: 'fresh', title: 'f', at: later }] }),
    ])
    markDocViewed('acme', 'seen', before)
    const calls: string[] = []
    const routes = canvasAttractRoutes(() => ({
      enabled: true, slug: 'acme', tree: { user_inbox_count: 2 } as any, map, pinnedIds: () => new Set(['pinned']),
      goToAgent: (id) => calls.push('go:' + id), fitAll: () => calls.push('fit'), openDoc: (id) => calls.push('doc:' + id),
      readerIds: () => [], closeReader: (id) => calls.push('close-reader:' + id),
      onPanel: (p) => calls.push('panel:' + (p ? `${p.kind}:${'mail' in p ? p.mail : p.item}` : 'close')),
    }))
    const got = await routes.collect(SINCE)
    assert.deepEqual(got.agents.map(a => `${a.id}:${a.deskTaken}`), ['free:false', 'pinned:true', 'old:false'])
    assert.deepEqual(got.docs, [{ id: 'fresh', node: 'old' }])
    assert.deepEqual(got.mail, [{ id: 'm1', urgent: true }, { id: 'm2' }], 'unread mail, oldest first')
    assert.deepEqual(keys(attractCandidates({ ...got, since: SINCE }, new Set())),
      [`agent:free:${before}`, 'mail:m1', 'doc:fresh', `ticket:moved:${later}`])
    await routes.show({ kind: 'org' })
    await routes.show({ kind: 'agent', id: 'free', mark: before })
    await routes.show({ kind: 'mail', id: 'm1', urgent: true })
    await flush()
    assert.equal(readLocally('acme', 'm1'), true, 'showing the mail reads it')
    assert.ok(posted.some(u => u.endsWith('/api/orgs/acme/inbox/read')))
    routes.hide({ kind: 'mail', id: 'm1' })
    await routes.show({ kind: 'ticket', slug: 'moved', mark: later })
    routes.hide({ kind: 'ticket', slug: 'moved', mark: later })
    const shown = routes.show({ kind: 'doc', id: 'fresh', node: 'old' })
    routes.hide({ kind: 'doc', id: 'fresh', node: 'old' })
    await shown
    assert.deepEqual(calls, ['fit', 'go:free', 'panel:inbox:m1', 'panel:close', 'panel:docket:moved', 'panel:close',
      'doc:fresh', 'close-reader:old'])
  } finally { globalThis.fetch = realFetch; resetLocalReads(); localStorage.clear() }
})
