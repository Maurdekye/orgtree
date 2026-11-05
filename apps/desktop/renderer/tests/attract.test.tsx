// Attract mode (@item:orgtree/attract-mode-the-org-drives-its-own-ui-cycling-t).
// USER 2026-11-02 m79cb0cf57f61 + answers mc8e118c58de9; gap-fills Q1-Q3
// @coordinator-opus m082646bad468.
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import {
  ATTRACT_IDLE_MS, DWELL_MAX_MS, DWELL_MIN_MS, FIT_GAP_CAP, attractCandidates, attractDwell, fitGap, pickAttract,
  targetKey, useAttractCycle, watchInput,
} from '../src/attract/attract'
import type { AttentionTarget, AttractInput, AttractRoutes, AttractTarget } from '../src/attract/attract'
import { scrollMs, SCROLL_MAX_MS, SCROLL_PAUSE_MS, SCROLL_PX_PER_S } from '../src/attract/scroll'
import {
  ATTRACT_IDLE_KEY, ATTRACT_IDLE_EVENT, DEFAULT_ATTRACT_IDLE_SECONDS, ATTRACT_KEY, setAttractIdleSeconds,
  setAttractMode, watchAttract, watchAttractIdle,
  ATTRACT_REFUSE_KEY, ATTRACT_REFUSE_EVENT, setAttractRefuseQuestions, watchAttractRefuse,
} from '../src/attract/pref'
import { bindRoomSocket, reportAttract } from '../src/streamrooms'
import { DEFAULT_PREFERENCES, preferencesPatch } from '../../main/policy'
import { canvasAttractRoutes } from '../src/attract/canvas'
import { createAttractPanels } from '../src/attract/panels'
import { setAttractTraceSink } from '../src/attract/trace'
import type { PanelKind } from '../src/attract/panels'
import { markDocViewed } from '../src/canvas/docviewed'
import { readLocally, resetLocalReads } from '../src/mailread'
import { registerWindow } from '../src/windowlife'
import { deskIdentity } from '../src/canvas/deskhosts'
import { setAttentionLayout, setOrgView } from '../src/attention/mode'

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

test('§3 nothing new: only fit the whole org; with something new the first steps are the new things', () => {
  assert.deepEqual(pickAttract([], () => 0.99, null), { kind: 'org' })
  assert.deepEqual(pickAttract([], () => 0, { kind: 'org' }), { kind: 'org' }, 'repeats the org when it is all there is')
  const doc: AttractTarget = { kind: 'doc', id: 'd', node: null }
  const mail: AttractTarget = { kind: 'mail', id: 'm' }
  const picks = new Set([0, 0.4, 0.7, 0.99].map(r => targetKey(pickAttract([doc, mail], () => r, null))))
  assert.deepEqual([...picks].sort(), ['doc:d', 'mail:m'], 'two new things: one of them, at random, before the first fit step')
  // never the same target twice in a row
  for (const r of [0, 0.5, 0.99]) assert.notEqual(targetKey(pickAttract([doc, mail], () => r, doc, 1)), 'doc:d')
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
// the default generator asks for the LAST of the new things and dwells the longest
function Cycle({ enabled, routes, log, idleMs, rng = () => 0.99 }: { enabled: boolean; routes: AttractRoutes; log: Log; idleMs?: number; rng?: () => number }) {
  const running = useAttractCycle(enabled, routes, rng, idleMs)
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
      await advance(DWELL_MAX_MS, 500)   // the default generator dwells the longest
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
      await inAct(() => { fire(sc.node, 'pointerup') })
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
          await inAct(() => { fire(sc.node, 'pointerup') })   // the press ends
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

// USER 2026-11-03 10:56:41Z m25dcebcbace4 "also it seems the panels that attract mode
// opens dont close automatically"
/** a stand-in for the shell: two panels whose open state only updates on the next
 *  "render", like React state (a ref read right after a close still says open) */
function shell() {
  const committed: Record<PanelKind, boolean> = { inbox: false, docket: false }
  const pending: Record<PanelKind, boolean> = { inbox: false, docket: false }
  const log: string[] = []
  const host = {
    isOpen: (k: PanelKind) => committed[k],
    show: (k: PanelKind, id: string) => { pending[k] = true; log.push(`show:${k}:${id}`) },
    close: (k: PanelKind) => { pending[k] = false; log.push(`close:${k}`) },
  }
  const render = () => { committed.inbox = pending.inbox; committed.docket = pending.docket }
  const user = (k: PanelKind, open: boolean) => { pending[k] = open; render() }
  return { host, render, user, log, open: () => ({ ...pending }) }
}

test('§13 panels attract opens close when it moves on, including one target of the same kind right after another', () => {
  const sh = shell()
  const panels = createAttractPanels(sh.host)
  panels.apply({ kind: 'docket', item: 'a' }); sh.render()
  assert.deepEqual(sh.open(), { inbox: false, docket: true })
  // the cycle moves ticket -> ticket: hide closes, show opens again in the same tick
  panels.apply(null); panels.apply({ kind: 'docket', item: 'b' }); sh.render()
  panels.apply(null); sh.render()
  assert.deepEqual(sh.open(), { inbox: false, docket: false }, 'the second ticket\'s docket is still attract\'s and closes')
  // the inbox, then a ticket, then nothing left open
  panels.apply({ kind: 'inbox', mail: 'm' }); sh.render()
  panels.apply(null); panels.apply({ kind: 'docket', item: 'c' }); sh.render()
  panels.apply(null); sh.render()
  assert.deepEqual(sh.open(), { inbox: false, docket: false })
})

test('§13b a panel the user opened or already had open is never closed', async () => {
  const sh = shell()
  const panels = createAttractPanels(sh.host)
  sh.user('inbox', true)                       // already open before attract
  panels.apply({ kind: 'inbox', mail: 'm' }); sh.render()
  panels.apply(null); sh.render()
  assert.equal(sh.open().inbox, true, 'an inbox the user had open stays')
  assert.ok(!sh.log.includes('close:inbox'))
  // the user opens the docket while attract is on the inbox: attract moving to a ticket shares it, never closes it
  panels.apply({ kind: 'docket', item: 'x' }); sh.render()
  panels.apply(null); sh.render()
  assert.equal(sh.open().docket, false, 'a docket attract opened itself closes')
  await Promise.resolve()   // the tick attract's own close is remembered for has ended
  sh.user('docket', true)
  panels.apply({ kind: 'docket', item: 'y' }); sh.render()
  panels.apply(null); sh.render()
  assert.equal(sh.open().docket, true, 'a docket the user opened stays')
})

test('§13c the screen stays when attract is interrupted, and a panel the user touched becomes theirs', () => {
  const sh = shell()
  const panels = createAttractPanels(sh.host)
  panels.apply({ kind: 'docket', item: 'a' }); sh.render()
  panels.apply('release')                       // canvas interaction ends the run, or the panel was touched
  panels.apply(null); sh.render()
  assert.equal(sh.open().docket, true, 'released panels are the user\'s: nothing closes them')
  // and a later run treats a docket that is open as not its own
  panels.apply({ kind: 'docket', item: 'b' }); sh.render()
  panels.apply(null); sh.render()
  assert.equal(sh.open().docket, true)
})

test('§14 the reader attract opened closes (the node that owns the document), unless the user had it open or touched it', async () => {
  localStorage.clear(); resetLocalReads()
  try {
    // 'fresh' is listed on two nodes: the shell opens it on the FIRST one (OrgCanvas docOwner)
    const doc = { id: 'fresh', title: 'f', at: later }
    const map = new Map<string, any>([
      ['first', { id: 'first', tier: 'opus', state: 'idle', documents: [doc] }],
      ['second', { id: 'second', tier: 'opus', state: 'idle', documents: [doc] }],
    ])
    const run = async (open: string[], act: (r: ReturnType<typeof canvasAttractRoutes>) => void | Promise<void>) => {
      const calls: string[] = []
      const routes = canvasAttractRoutes(() => ({
        enabled: true, slug: 'acme', tree: { user_inbox_count: 0 } as any, map, pinnedIds: () => new Set(),
        goToAgent: () => {}, fitAll: () => {}, openDoc: (id) => calls.push('doc:' + id),
        readerIds: () => open, closeReader: (id) => calls.push('close-reader:' + id),
        onPanel: (p) => calls.push('panel:' + (p === 'release' ? 'release' : p ? p.kind : 'close')),
      }))
      const t = { kind: 'doc' as const, id: 'fresh', node: 'second' }
      const shown = routes.show(t)
      await act(routes)
      routes.hide(t)
      await shown
      return calls
    }
    assert.deepEqual(await run([], () => {}), ['doc:fresh', 'close-reader:first'], 'closes the reader that was opened, not the listing node\'s')
    assert.deepEqual(await run(['first'], () => {}), ['doc:fresh'], 'a reader the user already had open stays')
    assert.deepEqual(await run([], r => r.release?.()), ['doc:fresh', 'panel:release'], 'touched: the user\'s now')
    assert.deepEqual(await run([], r => r.stop?.()), ['doc:fresh', 'panel:release'], 'interrupted: the screen stays, nothing is attract\'s any more')
  } finally { localStorage.clear(); resetLocalReads() }
})

test('§15 touching a panel hands it to the user and the run goes on; a canvas interaction ends the run and releases too', async () => {
  useFakeClock()
  try {
    watchInput(() => {})()
    const sc = scene()
    key()
    const calls: string[] = []
    const routes: AttractRoutes = {
      collect: async () => ({ agents: [], mail: [], docs: [], tickets: [] }),
      show: () => {}, hide: () => {},
      release: () => { calls.push('release') }, stop: () => { calls.push('stop') },
    }
    const log: Log = { calls: [] }
    const view = await mountView(<Cycle enabled routes={routes} log={log} idleMs={0} />, el => el)
    try {
      const running = () => view.el.querySelector('span')!.dataset.running
      await advance(50, 10)
      assert.equal(running(), 'true')
      await inAct(() => { fire(sc.panels.overlay, 'pointerdown') })
      assert.deepEqual(calls, ['release'], 'a press in a panel releases it')
      assert.equal(running(), 'true', 'and the run goes on')
      await inAct(() => { fire(sc.panels.overlay, 'wheel', { deltaY: 10 }); fire(sc.panels.pin, 'keydown', { key: 'x' }) })
      assert.deepEqual(calls, ['release', 'release', 'release'], 'wheel and keys in a panel count too')
      await inAct(() => { fire(sc.panels.tray, 'pointerdown') })
      assert.deepEqual(calls, ['release', 'release', 'release'], 'the agents tray is not an attract panel')
      await inAct(() => { fire(sc.node, 'pointerdown') })
      assert.equal(running(), 'false')
      assert.equal(calls.at(-1), 'stop')
      await inAct(() => { fire(sc.node, 'pointerup') })
    } finally { await view.unmount() }
    sc.root.remove()
  } finally { realClock() }
  await flush()
})

// USER 2026-11-03 13:06:58Z m0dc876241ee7 "attract mode should still return to fitting the org at some regular, above
// average portion of the time, even if there's new activity", REPLACED 13:08:49Z m6802501d1f0c "one in three on average, varies
// depending on activity. if there's only a single agent working, then it would go back and forth between that agent and the
// org. 2-3 agents and a new mail, every third change. 10+ agents, 5 changed tickets, 4 updated presentations, and 30 new
// mails, and the org only gets fit every 10-15th transition": the targets between two fit steps are round(1 + N/4 * jitter),
// jitter 0.8-1.2, at least 1, at most 15, N = the new targets waiting at that moment.
/** a seeded generator, so the counts are fixed numbers */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const waiting = (n: number): AttractTarget[] => Array.from({ length: n }, (_, i) => ({ kind: 'ticket', slug: 't' + i, mark: 'm' } as AttractTarget))
/** the targets shown between consecutive fit steps over `steps` steps, with N new things always waiting */
function gaps(n: number, seed: number, steps = 400): number[] {
  const rng = seeded(seed)
  const out: number[] = []
  let last: AttractTarget | null = null, run = 0, jitter = 0.8 + 0.4 * rng()
  for (let i = 0; i < steps; i++) {
    const next = pickAttract(waiting(n), rng, last, run, jitter)
    if (next.kind === 'org') { out.push(run); run = 0; jitter = 0.8 + 0.4 * rng() } else run++
    last = next
  }
  return out.slice(1)   // the first cycle begins before any fit step
}

test('§16 the gap grows with the number of new things: fitGap(N, jitter) = clamp(round(1 + N/4 x jitter), 1, 15)', () => {
  assert.equal(FIT_GAP_CAP, 15)
  for (const j of [0.8, 1, 1.2]) {
    assert.equal(fitGap(0, j), 1, 'at least 1')
    assert.equal(fitGap(1, j), 1, 'one agent: alternate')
    assert.equal(fitGap(4, j), 2, '3 agents + a mail: two targets, then the org, i.e. every third transition')
    assert.equal(fitGap(1000, j), 15, 'capped')
  }
  assert.ok(fitGap(49, 0.8) >= 10 && fitGap(49, 1.2) <= 15 && fitGap(49, 0.8) < fitGap(49, 1.2), 'about 49 new things: 10-15')
})

test('§16a one new thing waiting: it goes back and forth between it and the whole org', () => {
  for (const seed of [1, 2, 3, 42]) {
    const rng = seeded(seed)
    const seq: string[] = []
    let last: AttractTarget | null = null, run = 0
    const one = waiting(1)
    for (let i = 0; i < 20; i++) {
      // a real run drops what was shown from the waiting list; here the same agent stays new, but it is never twice in a row
      const next = pickAttract(one, rng, last, run, 0.8 + 0.4 * rng())
      run = next.kind === 'org' ? 0 : run + 1
      seq.push(next.kind === 'org' ? 'O' : 'x'); last = next
    }
    assert.equal(seq.join(''), 'xOxOxOxOxOxOxOxOxOxO', 'seed ' + seed)
  }
})

test('§16b 2-3 agents and a new mail (4 waiting): every third transition is the whole org', () => {
  for (const seed of [1, 2, 3, 42, 2026]) {
    const g = gaps(4, seed)
    assert.ok(g.length > 50)
    assert.ok(g.every(x => x === 2), `seed ${seed}: two targets between fit steps, saw ${[...new Set(g)]}`)
  }
})

test('§16d 49 new things (10+ agents, 5 tickets, 4 presentations, 30 mails): the org only every 10th-15th transition, varying', () => {
  const all: number[] = []
  for (const seed of [1, 2, 3, 42, 2026]) all.push(...gaps(49, seed, 1500))
  assert.ok(all.length > 40)
  assert.ok(all.every(x => x >= 10 && x <= 15), 'gap within 10-15: ' + [...new Set(all)].sort((a, b) => a - b))
  assert.ok(new Set(all).size >= 3, 'the +-20% jitter really varies the gap: ' + [...new Set(all)])
  const mean = all.reduce((a, b) => a + b, 0) / all.length
  assert.ok(mean > 11 && mean < 14, 'around 1 + 49/4 = 13: ' + mean)
  // never more than the cap, however much is waiting; never the org twice in a row or a target twice in a row
  assert.ok(gaps(500, 5, 600).every(x => x <= FIT_GAP_CAP))
})

test('§16e nothing new: only the whole org; the same single new thing is never shown twice in a row', () => {
  const rng = seeded(7)
  for (let i = 0; i < 50; i++) assert.deepEqual(pickAttract([], rng, { kind: 'org' }, 0, 1), { kind: 'org' })
  const only: AttractTarget[] = [{ kind: 'mail', id: 'm' }]
  let last: AttractTarget | null = null
  for (let i = 0; i < 40; i++) {
    const next = pickAttract(only, seeded(i), last, 0, 1)
    if (last) assert.notEqual(targetKey(next), targetKey(last))
    last = next
  }
})

test('§16c a fit step in the cycle closes what attract opened before it (the move-on rule applies to the whole org too)', async () => {
  useFakeClock()
  try {
    watchInput(() => {})()
    key()
    const log: Log = { calls: [] }
    // with one new thing the cycle alternates it and the whole org
    const routes: AttractRoutes = {
      collect: async () => ({ agents: [], mail: [{ id: 'm1' }], docs: [], tickets: [] }),
      show: (t) => { log.calls.push('show:' + targetKey(t)) }, hide: (t) => { log.calls.push('hide:' + targetKey(t)) }, stop: () => {},
    }
    const view = await mountView(<Cycle enabled routes={routes} log={log} idleMs={0} />, el => el)
    try {
      await advance(60_000, 1_000)
      const order = log.calls.filter(c => c.startsWith('show:') || c.startsWith('hide:'))
      // every show of a non-org target is followed by its hide before the next show
      order.forEach((c, i) => {
        if (c.startsWith('show:') && !c.startsWith('show:org') && order[i + 1]) assert.equal(order[i + 1], 'hide:' + c.slice(5), 'the panel target is taken down before the next step: ' + order.join(' '))
      })
      assert.ok(order.some(c => c === 'show:org'), 'the whole org is shown: ' + order.join(' '))
    } finally { await view.unmount() }
  } finally { realClock() }
  await flush()
})

// USER 2026-11-03 13:10:21Z m0962694602bd "and if anything needing attention appears, it is immediately focused with
// zero delay"; intent m459d9dd72005 "roughly mimic how i as the user might navigate the org to check on new things
// during idle use"; scope @coordinator-opus mcd6bfb242dc4
const attn = (key: string, what: AttentionTarget['what'] = 'question', agent: string | null = 'boss', id = key): AttentionTarget =>
  ({ kind: 'attention', key, what, agent, id })

test('§17 attention: an arrival interrupts the current dwell at once; several are shown in arrival order, one per step, before ordinary targets', async () => {
  useFakeClock()
  try {
    watchInput(() => {})()
    key()
    const calls: string[] = []
    let arrive: ((items: AttentionTarget[]) => void) | null = null
    const routes: AttractRoutes = {
      collect: async () => ({ agents: [], mail: [], docs: [], tickets: [] }),
      show: (t) => { calls.push('show:' + targetKey(t)) }, hide: (t) => { calls.push('hide:' + targetKey(t)) }, stop: () => {},
      watch: (cb) => { arrive = cb; return () => { arrive = null } },
    }
    const log: Log = { calls: [] }
    const view = await mountView(<Cycle enabled routes={routes} log={log} idleMs={0} />, el => el)
    try {
      await advance(50, 10)
      assert.deepEqual(calls, ['show:org'], 'running: the first step is the whole org (nothing else is new)')
      assert.ok(arrive, 'the cycle listens for attention while it runs')
      // the org is dwelling (8-15 s): the arrival does not wait for it
      await inAct(() => { arrive!([attn('q1')]) })
      assert.deepEqual(calls, ['show:org', 'hide:org', 'show:attn:q1'], 'zero delay: no time has passed')
      // two more arrive while q1 is shown: they wait their turn (q1 gets its dwell), in arrival order
      await inAct(() => { arrive!([attn('q2', 'mail'), attn('q3', 'ticket')]) })
      assert.deepEqual(calls, ['show:org', 'hide:org', 'show:attn:q1'], 'an attention item on screen is not cut short')
      await advance(DWELL_MAX_MS + 100, 500)
      assert.deepEqual(calls.slice(3, 5), ['hide:attn:q1', 'show:attn:q2'], 'next in arrival order')
      await advance(DWELL_MAX_MS + 100, 500)
      assert.deepEqual(calls.slice(5, 7), ['hide:attn:q2', 'show:attn:q3'])
      await advance(DWELL_MAX_MS + 100, 500)
      assert.deepEqual(calls.slice(7, 9), ['hide:attn:q3', 'show:org'], 'then the ordinary cycle resumes')
    } finally { await view.unmount() }
    assert.equal(arrive, null, 'the listener is removed when the run ends')
  } finally { realClock() }
  await flush()
})

test('§17b once per arrival: standing attention at the start of a run is the baseline, a new one is reported once, and a re-raised one is new again', async () => {
  localStorage.clear(); resetLocalReads()
  const realFetch = globalThis.fetch
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const pending: any[] = [], items: any[] = [], asks: any[] = []
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    if (u.includes('/work-items-view')) return json({ items, counts: { attention: items.length, active: items.length, archived: 0, backlogged: 0 }, now: later })
    if (u.endsWith('/inbox')) return json({ pending, delivered: [], sent: [] })
    return json({})
  }) as typeof fetch
  try {
    const tree: any = { user_inbox_count: 0, roots: [], asks }
    const routes = canvasAttractRoutes(() => ({
      enabled: true, slug: 'acme', tree, map: new Map(), pinnedIds: () => new Set(),
      goToAgent: () => {}, fitAll: () => {}, openDoc: () => {}, readerIds: () => [], closeReader: () => {}, onPanel: () => {},
    }))
    const got: AttentionTarget[][] = []
    // something already waiting when the run starts
    asks.push({ id: 'old', node: 'boss', status: 'open', question: 'standing?', at: '2026-11-03T08:00:00Z' })
    const off = routes.watch!(a => got.push(a))
    await routes.poll!()
    assert.deepEqual(got, [], 'what was already waiting is not an arrival')
    // three new things, raised in this order
    asks.push({ id: 'q9', node: 'bea', status: 'open', question: 'which?', at: '2026-11-03T12:00:01Z' })
    items.push({ slug: 'flagged', title: 'F', status: 'in_progress', rev: 1, updated_at: later, manual_attention: { at: '2026-11-03T12:00:02Z', by: { node: 'cy' }, reason: 'look' }, done_so_far: [], working_on_next: [] })
    pending.push({ id: 'um1', from: 'dee', at: '2026-11-03T12:00:03Z', body: 'now', urgent: true, urgent_reason: 'fire' })
    await routes.poll!()
    assert.equal(got.length, 1)
    assert.deepEqual(got[0]!.map(t => `${t.what}:${t.id}`), ['question:q9', 'ticket:flagged', 'mail:um1'], 'in arrival order')
    assert.deepEqual(got[0]!.map(t => t.agent), ['bea', 'cy', 'dee'])
    await routes.poll!(); await routes.poll!()
    assert.equal(got.length, 1, 'shown once per arrival: polling again reports nothing')
    // answered, then asked again: a new arrival
    asks.splice(1, 1)
    await routes.poll!()
    asks.push({ id: 'q9', node: 'bea', status: 'open', question: 'which?', at: '2026-11-03T12:05:00Z' })
    await routes.poll!()
    assert.equal(got.length, 2)
    assert.deepEqual(got[1]!.map(t => t.id), ['q9'], 'raised again')
    off()
    await routes.poll!()
    assert.equal(got.length, 2, 'nobody listens: nothing is reported')
  } finally { globalThis.fetch = realFetch; resetLocalReads(); localStorage.clear() }
})

test('§17c the attention routes: a question or mention goes to its node, a flagged ticket to the docket, urgent mail to the inbox; a desk that is visible anywhere is skipped entirely; moving on closes the panels', async () => {
  localStorage.clear(); resetLocalReads()
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ read: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  try {
    const calls: string[] = []
    const pinned = new Set<string>()
    const routes = canvasAttractRoutes(() => ({
      enabled: true, slug: 'acme', tree: { user_inbox_count: 1, roots: [], asks: [] } as any, map: new Map(), pinnedIds: () => pinned,
      goToAgent: (id) => calls.push('go:' + id), fitAll: () => calls.push('fit'), openDoc: () => {}, readerIds: () => [], closeReader: () => {},
      onPanel: (p) => calls.push('panel:' + (p === 'release' ? 'release' : p ? `${p.kind}:${'mail' in p ? p.mail : p.item}` : 'close')),
    }))
    await routes.show(attn('question:q1', 'question', 'bea', 'q1'))
    await routes.show(attn('mention:bea:m1', 'mention', 'bea', 'm1'))
    assert.deepEqual(calls, ['go:bea', 'go:bea'], 'its node, with the question')
    calls.length = 0
    pinned.add('bea')
    await routes.show(attn('question:q2', 'question', 'bea', 'q2'))
    assert.deepEqual(calls, [], 'a desk visible anywhere: attract skips the agent entirely - no fit, no pan, no focus (USER m1869e398fdea)')
    calls.length = 0
    await routes.show(attn('ticket:flagged', 'ticket', 'cy', 'flagged'))
    routes.hide(attn('ticket:flagged', 'ticket', 'cy', 'flagged'))
    await routes.show(attn('mail:um1', 'mail', 'dee', 'um1'))
    await flush()
    routes.hide(attn('mail:um1', 'mail', 'dee', 'um1'))
    assert.deepEqual(calls, ['panel:docket:flagged', 'panel:close', 'panel:inbox:um1', 'panel:close'])
  } finally { globalThis.fetch = realFetch; resetLocalReads(); localStorage.clear() }
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
      onPanel: (p) => calls.push('panel:' + (p === 'release' ? 'release' : p ? `${p.kind}:${'mail' in p ? p.mail : p.item}` : 'close')),
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

// USER 2026-11-03 17:57:15Z m7efd38ca3400 "attract mode focused your desk even though it's open in the pinned agent desk already"
test('§8b a desk open elsewhere is never touched, even when it was pinned after the candidates were collected; its presentations are not opened on it, and the canvas does not move either', async () => {
  const node = (id: string, extra: Record<string, unknown> = {}) =>
    [id, { id, tier: 'opus', state: 'idle', generation: 1, busy: true, turn_started_at: before, ...extra }] as const
  const map = new Map<string, any>([node('late'), node('pinned', { documents: [{ id: 'pd', title: 'p', at: later }] })])
  resetLocalReads(); localStorage.clear()
  try {
    let pinned = new Set<string>(['pinned'])
    const calls: string[] = []
    const routes = canvasAttractRoutes(() => ({
      enabled: true, slug: 'acme', tree: { user_inbox_count: 0 } as any, map, pinnedIds: () => pinned,
      goToAgent: (id) => calls.push('go:' + id), fitAll: () => calls.push('fit'), openDoc: (id) => calls.push('doc:' + id),
      readerIds: () => [], closeReader: (id) => calls.push('close-reader:' + id),
    }))
    const got = await routes.collect(SINCE)
    assert.deepEqual(got.docs, [], 'a presentation of a pinned desk is not a candidate')
    // chosen while free, pinned before its step runs
    pinned = new Set(['pinned', 'late'])
    await routes.show({ kind: 'agent', id: 'late', mark: before })
    await routes.show({ kind: 'agent', id: 'pinned', mark: before })
    await routes.show({ kind: 'doc', id: 'pd', node: 'pinned' })
    assert.deepEqual(calls, [], 'nothing moves (USER m1869e398fdea): no pan, no focus, no desk change, no reader: ' + calls.join(','))
  } finally { resetLocalReads(); localStorage.clear() }
})

// USER 2026-11-04 19:34:25Z m1869e398fdea "attract mode still focused your node even though i have your desk open in a pinned attention
// view agent desk": an agent whose desk is visible ANYWHERE (pinned, the attention view's desk, a popped-out window) is skipped
// entirely: no node focus, no pan, no desk change, whether it comes up as an agent step, an attention item or a presentation.
for (const kind of ['pinned', 'attention-view', 'popped-out'] as const) {
  test(`§8c a desk shown as ${kind} is skipped entirely: no focus, no pan, no fit, no reader; a free agent is still visited`, async () => {
    localStorage.clear(); resetLocalReads()
    const node = (id: string, extra: Record<string, unknown> = {}) =>
      [id, { id, tier: 'opus', state: 'idle', generation: 1, busy: true, turn_started_at: before, ...extra }] as const
    const map = new Map<string, any>([node('liaison', { documents: [{ id: 'dx', title: 'd', at: later }] }), node('free')])
    const pinned = new Set<string>()
    let stopSurface = () => {}
    try {
      if (kind === 'pinned') pinned.add('liaison')
      if (kind === 'attention-view') { setOrgView('acme', 'attention'); setAttentionLayout('acme', { agent: 'liaison' }) }
      if (kind === 'popped-out') stopSurface = registerWindow({ id: 'probe-desk', kind: `desk:${deskIdentity('acme', map.get('liaison'))}`, org: 'acme', editable: false,
        window: globalThis.window, redock: () => {} })
      const calls: string[] = []
      const routes = canvasAttractRoutes(() => ({
        enabled: true, slug: 'acme', tree: { user_inbox_count: 0, roots: [], asks: [] } as any, map, pinnedIds: () => pinned,
        goToAgent: (id) => calls.push('go:' + id), fitAll: () => calls.push('fit'), openDoc: (id) => calls.push('doc:' + id),
        readerIds: () => [], closeReader: () => {}, onPanel: () => {},
      }))
      const got = await routes.collect(SINCE)
      assert.equal(got.agents.find(a => a.id === 'liaison')!.deskTaken, true, 'its desk counts as taken')
      assert.deepEqual(got.docs, [], 'and so do its presentations')
      await routes.show({ kind: 'agent', id: 'liaison', mark: before })
      await routes.show(attn('question:q', 'question', 'liaison', 'q'))
      await routes.show({ kind: 'doc', id: 'dx', node: 'liaison' })
      assert.deepEqual(calls, [], 'nothing moved for the visible desk: ' + calls.join(','))
      await routes.show({ kind: 'agent', id: 'free', mark: before })
      assert.deepEqual(calls, ['go:free'], 'an agent whose desk is not open anywhere is still visited')
    } finally { stopSurface(); setOrgView('acme', 'canvas'); setAttentionLayout('acme', { agent: null }); localStorage.clear(); resetLocalReads() }
  })
}

// USER 2026-11-03 13:10:58Z m46c12a448a66 "any user facing questions while attract mode is on should
// be outright refused (optional extra toggle default on)"
test('§12 refuse-questions setting: on when absent, one app-wide boolean preference', async () => {
  assert.equal('attractRefuseQuestions' in DEFAULT_PREFERENCES, false, 'absent means on: nothing stored on a fresh install')
  for (const ok of [true, false]) assert.deepEqual(preferencesPatch({ attractRefuseQuestions: ok }), { attractRefuseQuestions: ok })
  for (const bad of [1, 'true', null, {}]) assert.throws(() => preferencesPatch({ attractRefuseQuestions: bad }), String(bad))
  localStorage.removeItem(ATTRACT_REFUSE_KEY)
  const seen: boolean[] = []
  const stop = watchAttractRefuse(on => seen.push(on))
  try {
    await setAttractRefuseQuestions(false)
    assert.equal(localStorage.getItem(ATTRACT_REFUSE_KEY), '0')
    await setAttractRefuseQuestions(true)
    assert.deepEqual(seen, [true, false, true])
    localStorage.setItem(ATTRACT_REFUSE_KEY, 'junk')
    window.dispatchEvent(new Event(ATTRACT_REFUSE_EVENT))
    assert.equal(seen.at(-1), true, 'junk reads as the default, on')
  } finally { stop(); localStorage.removeItem(ATTRACT_REFUSE_KEY) }
})

test('§13 the org socket is told attract started and stopped, with the setting, and again on reconnect', async () => {
  const sent: unknown[] = []
  bindRoomSocket('o1', m => sent.push(m))
  sent.length = 0
  reportAttract('o1', true, true)
  reportAttract('o1', true, false)     // the setting changed while running
  reportAttract('o1', true, false)     // unchanged: not repeated
  reportAttract('o1', false, false)
  assert.deepEqual(sent, [
    { type: 'attract', running: true, refuse: true },
    { type: 'attract', running: true, refuse: false },
    { type: 'attract', running: false, refuse: false },
  ])
  // a running window that reconnects tells the new socket at once (the engine's flag is per connection)
  reportAttract('o1', true, true)
  bindRoomSocket('o1', null)
  const again: unknown[] = []
  bindRoomSocket('o1', m => again.push(m))
  assert.deepEqual(again.filter(m => (m as { type: string }).type === 'attract'), [{ type: 'attract', running: true, refuse: true }])
  // stopped: a reconnect says nothing
  reportAttract('o1', false, true)
  bindRoomSocket('o1', null)
  const quiet: unknown[] = []
  bindRoomSocket('o1', m => quiet.push(m))
  assert.deepEqual(quiet.filter(m => (m as { type: string }).type === 'attract'), [])
  bindRoomSocket('o1', null)
})

test('§19 a ticket is picked at most every fourth step (USER 2026-11-05 m207f9caba2e3: less docket, more canvas and desks)', () => {
  const t1: AttractTarget = { kind: 'ticket', slug: 't1', mark: 'a' }, t2: AttractTarget = { kind: 'ticket', slug: 't2', mark: 'b' }
  const ag: AttractTarget = { kind: 'agent', id: 'a1', mark: 'x' }
  for (const since of [0, 1, 2]) for (const r of [0, 0.3, 0.6, 0.99]) {
    assert.notEqual(pickAttract([t1, t2, ag], () => r, null, 0, 1, since).kind, 'ticket', `since ${since} rng ${r}: the docket sits this one out`)
  }
  assert.equal(pickAttract([t1, t2, ag], () => 0, null, 0, 1, 3).kind, 'ticket', 'the fourth step after a ticket may be one')
  assert.equal(pickAttract([t1, t2], () => 0, null, 0, 1).kind, 'ticket', 'no ticket yet this run: allowed')
  assert.deepEqual(pickAttract([t1, t2], () => 0, null, 0, 1, 1), { kind: 'org' }, 'only tickets waiting and one was just shown: the org')
})

test('§20 the docket gets at most 15% of screen time over any rolling 5 minutes, a burst of 30 changed tickets included; attention tickets get one visit per window (USER 2026-11-05 m68460e1a8f36)', async () => {
  const trace: Record<string, unknown>[] = []
  setAttractTraceSink(r => { trace.push(r) })
  useFakeClock()
  try {
    watchInput(() => {})()
    key()
    const stamp = new Date(Date.now() + 60_000).toISOString()
    const tickets = Array.from({ length: 30 }, (_, i) => ({ slug: 't' + i, updatedAt: stamp }))
    const shownSlugs = new Set<string>()
    const visits: { at: number; end: number | null; attn: boolean }[] = []
    let arrive: ((items: AttentionTarget[]) => void) | undefined
    const close = () => { const v = visits.at(-1); if (v && v.end === null) v.end = Date.now() }
    const routes: AttractRoutes = {
      collect: async () => ({ agents: [], mail: [], docs: [], tickets: tickets.filter(t => !shownSlugs.has(t.slug)) }),
      show: (t) => {
        if (t.kind === 'ticket') shownSlugs.add(t.slug)
        if (t.kind === 'ticket' || (t.kind === 'attention' && t.what === 'ticket')) visits.push({ at: Date.now(), end: null, attn: t.kind === 'attention' })
      },
      hide: () => close(),
      stop: () => close(),
      watch: (fn) => { arrive = fn; return () => { arrive = undefined } },
    }
    const log: Log = { calls: [] }
    const view = await mountView(<Cycle enabled routes={routes} log={log} />, el => el)
    try {
      await advance(ATTRACT_IDLE_MS + 2_000, 500)
      const t0 = Date.now()
      await advance(120_000, 1_000)
      // five tickets someone flagged arrive together
      const attn = (i: number): AttentionTarget => ({ kind: 'attention', key: 'k' + i, what: 'ticket', agent: 'a', id: 'f' + i })
      await inAct(() => { arrive?.([1, 2, 3, 4, 5].map(attn)) })
      await advance(480_000, 1_000)
      close()
      const end = Date.now()
      const used = (a: number, b: number) => visits.reduce((n, v) => n + Math.max(0, Math.min(v.end ?? end, b) - Math.max(v.at, a)), 0)
      let worst = 0, worstAttn = 0
      for (let w = t0; w + 300_000 <= end; w += 10_000) {
        worst = Math.max(worst, used(w, w + 300_000))
        worstAttn = Math.max(worstAttn, visits.filter(v => v.attn && v.at >= w && v.at < w + 300_000).length)
      }
      assert.ok(visits.length > 0, 'the docket is still visited')
      assert.ok(worst <= 0.15 * 300_000, `the docket share over 5 minutes is at most 15%: worst window ${Math.round(worst / 3000)}% (${worst} ms)`)
      assert.ok(worstAttn <= 1, `attention tickets: at most one docket visit per window, saw ${worstAttn}`)
      const steps = trace.filter(r => r.ev === 'step')
      assert.ok(steps.length > 0 && steps.every(r => typeof r.docket_pct === 'number'), 'every traced step reports the docket share')
      assert.ok(trace.some(r => r.ev === 'skip'), 'a refused attention ticket is traced as a skip')
    } finally { await view.unmount() }
  } finally { realClock(); setAttractTraceSink(null) }
})

// §18 the attract trace (item attract-mode-gets-stuck-on-the-docket-and-doesn-t, coordinator go 2026-11-05 13:43Z): one record per
// step / panel change / hand-over / stop, so the next "stuck on the docket" is measurable. Kinds and timings only: the user streams.
test('§18 the trace: a step, a panel opening and closing, a hand-over and a stop are each one record, with no ids or text', async () => {
  const got: Record<string, unknown>[] = []
  setAttractTraceSink(r => { got.push(r) })
  try {
    // panels: attract opens the docket (owned), closes it; the user's own docket is not owned; a touch hands one over
    const sh = shell()
    const panels = createAttractPanels(sh.host)
    panels.apply({ kind: 'docket', item: 'SECRET-TICKET' }); sh.render()
    panels.apply(null); sh.render()
    await Promise.resolve()
    sh.user('docket', true)
    panels.apply({ kind: 'docket', item: 'SECRET-TICKET' }); sh.render()
    panels.apply('release')
    const panelRows = got.filter(r => r.ev === 'panel' || r.ev === 'release')
    assert.deepEqual(panelRows.map(r => [r.ev, r.action, r.panel, r.owned]), [
      ['panel', 'open', 'docket', true], ['panel', 'close', 'docket', true],
      ['panel', 'open', 'docket', false], ['release', undefined, undefined, undefined],
    ])
    // the cycle: a step names its kind and its timings; a canvas press is a stop with its reason
    got.length = 0
    useFakeClock()
    try {
      watchInput(() => {})()
      key()
      const log: Log = { calls: [] }
      const view = await mountView(<Cycle enabled routes={routesFor(log, [{ id: 'SECRET-MAIL' }])} log={log} />, el => el)
      try {
        await advance(ATTRACT_IDLE_MS + 2_000, 500)
        const step = got.find(r => r.ev === 'step')!
        assert.equal(step.kind, 'mail')
        assert.equal(typeof step.need_ms, 'number'); assert.equal(typeof step.dwell_ms, 'number')
        assert.ok((step.dwell_ms as number) >= DWELL_MIN_MS && (step.dwell_ms as number) <= DWELL_MAX_MS)
        const sc = scene()
        await inAct(() => { fire(sc.node, 'keydown', { key: 'a' }) })
        const stop = got.find(r => r.ev === 'stop')!
        assert.equal(stop.why, 'canvas')
        sc.root.remove()
      } finally { await view.unmount() }
    } finally { realClock() }
    assert.ok(!JSON.stringify(got).includes('SECRET'), 'no id, title or text is ever traced')
  } finally { setAttractTraceSink(null) }
})
