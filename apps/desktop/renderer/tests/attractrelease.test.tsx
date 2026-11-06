// Attract mode must not lose the docket it opened, and must recover one it lost
// (@item:orgtree/attract-mode-gets-stuck-on-the-docket-and-doesn-t, reopened; coordinator ruling 2026-11-06 m23a4fc62023a).
// Installed 4.5.6-alpha.1: a "release" 7 s into a docket visit, then the docket stayed open for minutes while ticket steps kept
// being routed into it as "owned:false". The user had not touched it.
import { advance, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { ATTRACT_IDLE_MS, FOCUS_GRACE_MS, TAKEOVER_GAP_MS, isTakeoverInput, lastInputAt, setRequireTrustedInput, targetKey, useAttractCycle, watchInput } from '../src/attract/attract'
import type { AttractRoutes } from '../src/attract/attract'
import { createAttractPanels } from '../src/attract/panels'
import type { PanelKind } from '../src/attract/panels'
import { floatingOtherDockets } from '../src/canvas/modalpin'
import { updatePinSurface } from '../src/canvas/pinspace'
import { pinSurfaceKey } from '../src/canvas/pinspace'
import { setAttractTraceLive, setAttractTraceSink } from '../src/attract/trace'

function Cycle({ routes, idleMs }: { routes: AttractRoutes; idleMs?: number }) {
  const running = useAttractCycle(true, routes, () => 0.99, idleMs)
  return <span data-running={String(running)} />
}
const key = () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }))
function overlay() {
  const d = window.document
  const root = d.createElement('div'); d.body.appendChild(root)
  const viewport = d.createElement('div'); viewport.className = 'viewport'; root.appendChild(viewport)
  const panel = d.createElement('div'); panel.className = 'overlay'; viewport.appendChild(panel)
  return { root, panel }
}
const fire = (el: Element, type: string, init: object = {}) => {
  const W = window as unknown as Record<string, new (t: string, i?: object) => Event>
  const Ctor = type === 'keydown' || type === 'keyup' ? W.KeyboardEvent : type === 'wheel' ? W.WheelEvent : W.MouseEvent
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }))
}
function shell() {
  const committed: Record<PanelKind, boolean> = { inbox: false, docket: false }
  const pending: Record<PanelKind, boolean> = { inbox: false, docket: false }
  let shown = 0
  let closeCalls = 0
  let away = false
  const host = {
    isOpen: (k: PanelKind) => committed[k],
    elsewhere: () => away,
    show: (k: PanelKind) => { pending[k] = true; shown++ },
    close: (k: PanelKind) => { pending[k] = false },
    closeDockets: () => { closeCalls++ },
  }
  const render = () => { committed.inbox = pending.inbox; committed.docket = pending.docket }
  return { host, render, user: (k: PanelKind, open: boolean) => { pending[k] = open; render() }, open: () => ({ ...pending }), shows: () => shown, closeCalls: () => closeCalls, elsewhere: (on: boolean) => { away = on } }
}
/** a cycle whose agent and one changed ticket are always new, with the docket as `docket` says */
function routesWith(calls: string[], docket: AttractRoutes['docket']): AttractRoutes {
  return {
    collect: async () => ({
      agents: [{ id: 'a', busy: true, activityAt: '2026-11-06T13:00:00Z', deskTaken: false }],
      mail: [], docs: [], tickets: [{ slug: 't', updatedAt: new Date(Date.now() + 60_000).toISOString() }],
    }),
    show: (t) => { calls.push('show:' + targetKey(t).split(':')[0]) },
    hide: () => {},
    docket,
  }
}

test('R1 input that is not trusted (not the user) is no input: it releases nothing and restarts no quiet time', async () => {
  useFakeClock()
  setRequireTrustedInput(true)
  const sc = overlay()
  try {
    watchInput(() => {})()
    key()
    const released: (string | undefined)[] = []
    const calls: string[] = []
    const routes = { ...routesWith(calls, undefined), release: (via?: string) => { released.push(via) } } as AttractRoutes
    const view = await mountView(<Cycle routes={routes} />, el => el)
    try {
      await advance(ATTRACT_IDLE_MS + 2_000, 500)
      const idleAt = lastInputAt()
      await inAct(() => { fire(sc.panel, 'wheel'); fire(sc.panel, 'keydown'); fire(sc.panel, 'pointerdown') })
      assert.deepEqual(released, [], 'a synthetic wheel, key and press inside the panel hand nothing over')
      assert.equal(lastInputAt(), idleAt, 'and they are not input: the quiet time is not restarted')
      // the same events from the user (switched on here the way every other attract test runs) do release
      setRequireTrustedInput(false)
      await inAct(() => { fire(sc.panel, 'wheel') })
      assert.deepEqual(released, ['wheel'], 'user input releases, and says which kind it was')
    } finally { await view.unmount() }
  } finally { setRequireTrustedInput(false); sc.root.remove(); realClock() }
})


/** the cycle wired to real panels the way canvas.ts wires it: show opens, hide closes, release/stop hand over */
function wired(sh: ReturnType<typeof shell>, calls: string[]): { panels: ReturnType<typeof createAttractPanels>; routes: AttractRoutes } {
  const panels = createAttractPanels(sh.host)
  const routes: AttractRoutes = {
    collect: async () => ({
      agents: [{ id: 'a', busy: true, activityAt: '2026-11-06T13:00:00Z', deskTaken: false }],
      mail: [], docs: [], tickets: [{ slug: 't', updatedAt: new Date(Date.now() + 60_000).toISOString() }],
    }),
    show: (t) => { calls.push('show:' + targetKey(t).split(':')[0]); if (t.kind === 'ticket') { panels.apply({ kind: 'docket', item: 't' }); sh.render() } },
    hide: (t) => { if (t.kind === 'ticket') { panels.apply(null); sh.render() } },
    release: (via) => { calls.push('release:' + String(via)); panels.apply('release', via) },
    stop: () => { calls.push('stop'); panels.apply('release') },
    docket: panels.docket,
  }
  return { panels, routes }
}
/** advance until attract's docket is on screen (a ticket step), or fail */
async function untilDocket(sh: ReturnType<typeof shell>): Promise<void> {
  for (let i = 0; i < 400 && !sh.open().docket; i++) { await advance(1_000, 250); sh.render() }
  assert.equal(sh.open().docket, true, 'attract opened the docket within 400 s')
}

test('T1 only a real press/touch, a wheel, or a non-modifier key inside a panel is a takeover; modifiers, Alt+Tab, hover and outside targets are not', () => {
  const sc = overlay()
  try {
    const t = (type: string, init: object, el: Element = sc.panel, sinceFocus = 10_000) => {
      let got = false
      const off = watchInput(() => {})   // keep the listeners installed
      const h = (e: Event) => { got = isTakeoverInput(e, sinceFocus) }
      el.addEventListener(type, h, { once: true }); fire(el, type, init); off()
      return got
    }
    for (const key of ['Alt', 'Control', 'Shift', 'Meta', 'AltGraph']) assert.equal(t('keydown', { key }), false, `lone ${key}`)
    assert.equal(t('keydown', { key: 'Tab', altKey: true }), false, 'Tab with Alt held')
    assert.equal(t('keydown', { key: 'Tab' }, sc.panel, FOCUS_GRACE_MS - 1), false, 'Tab just after the window gained focus')
    assert.equal(t('keydown', { key: 'Tab' }, sc.panel, FOCUS_GRACE_MS + 1), true, 'a Tab long after focus is the user typing')
    assert.equal(t('keydown', { key: 'a' }), true, 'a letter key')
    assert.equal(t('keydown', { key: 'a' }, sc.root), false, 'a key outside every panel')
    assert.equal(t('pointermove', {}), false, 'hover')
    assert.equal(t('pointerdown', {}), true, 'a press')
    assert.equal(t('wheel', { deltaY: 5 }), true, 'a wheel')
  } finally { sc.root.remove() }
})

for (const [name, act, via] of [
  ['click inside the docket', (el: Element) => fire(el, 'pointerdown'), 'pointerdown'],
  ['wheel inside the docket', (el: Element) => fire(el, 'wheel', { deltaY: 20 }), 'wheel'],
  ['letter key with focus in the docket', (el: Element) => fire(el, 'keydown', { key: 'j' }), 'keydown'],
] as const) {
  test(`T2 ${name}: attract stops for good and the docket stays open (the user's)`, async () => {
    useFakeClock()
    setRequireTrustedInput(false)
    const sc = overlay()
    const got: Record<string, unknown>[] = []
    setAttractTraceSink(r => { got.push(r) })
    try {
      watchInput(() => {})()
      key()
      const sh = shell(); const calls: string[] = []
      const { routes } = wired(sh, calls)
      const view = await mountView(<Cycle routes={routes} />, el => el)
      try {
        const running = () => view.el.querySelector('span')!.dataset.running
        await advance(ATTRACT_IDLE_MS + 2_000, 500)
        await untilDocket(sh)
        await inAct(() => { act(sc.panel) })
        assert.equal(running(), 'false', 'a takeover ends the run')
        assert.deepEqual(calls.filter(c => c.startsWith('release')), ['release:' + via])
        await advance(120_000, 1_000); sh.render()
        assert.equal(sh.open().docket, true, 'and the docket stays open, the user\'s, never closed by attract')
        assert.ok(got.some(r => r.ev === 'stop' && r.why === 'takeover_stop'), 'the stop is traced takeover_stop')
        const shows = calls.length
        await advance(120_000, 1_000)
        assert.equal(calls.length, shows, 'no step runs after the stop (attract returns only through its idle start)')
      } finally { await view.unmount() }
    } finally { setAttractTraceSink(null); sc.root.remove(); realClock() }
  })
}

test('T3 window focus/blur, hover and an Alt+Tab key sequence with the docket open are no takeover: the visit goes on and closes on time', async () => {
  useFakeClock()
  setRequireTrustedInput(false)
  const sc = overlay()
  try {
    watchInput(() => {})()
    key()
    const sh = shell(); const calls: string[] = []
    const { routes } = wired(sh, calls)
    const view = await mountView(<Cycle routes={routes} />, el => el)
    try {
      const running = () => view.el.querySelector('span')!.dataset.running
      await advance(ATTRACT_IDLE_MS + 2_000, 500)
      await untilDocket(sh)
      await inAct(() => {
        window.dispatchEvent(new window.Event('blur')); window.dispatchEvent(new window.Event('focus'))
        fire(sc.panel, 'pointermove', { screenX: 5, screenY: 5 })
        fire(sc.panel, 'keydown', { key: 'Alt', altKey: true }); fire(sc.panel, 'keydown', { key: 'Tab', altKey: true })
        fire(sc.panel, 'keyup', { key: 'Tab', altKey: true }); fire(sc.panel, 'keyup', { key: 'Alt' })
        fire(sc.panel, 'keydown', { key: 'Tab' })     // the Tab that follows the window regaining focus
      })
      assert.equal(running(), 'true', 'still running')
      assert.deepEqual(calls.filter(c => c.startsWith('release')), [], 'nothing handed over')
      let closedAt = -1
      for (let i = 0; i < 40 && closedAt < 0; i++) { await advance(1_000, 250); sh.render(); if (!sh.open().docket) closedAt = i }
      assert.ok(closedAt >= 0, 'the visit closed within 40 s (its normal dwell), not held')
    } finally { await view.unmount() }
  } finally { sc.root.remove(); realClock() }
})

test('T4 a docket the user opens mid-run gets no ticket steps and is never closed by attract', async () => {
  useFakeClock()
  setRequireTrustedInput(false)
  try {
    watchInput(() => {})()
    key()
    const sh = shell(); const calls: string[] = []
    const { routes } = wired(sh, calls)
    const view = await mountView(<Cycle routes={routes} />, el => el)
    try {
      await advance(ATTRACT_IDLE_MS + 2_000, 500)
      sh.user('docket', false)
      for (let i = 0; i < 400 && calls.indexOf('show:ticket') < 0; i++) await advance(1_000, 250)
      // wait for attract's own visit (if any) to be over, then the user opens the docket
      await advance(30_000, 1_000); sh.render()
      sh.user('docket', true)
      const before = calls.filter(c => c === 'show:ticket').length
      await advance(300_000, 1_000); sh.render()
      assert.equal(calls.filter(c => c === 'show:ticket').length, before, 'no ticket step while the user\'s docket is open')
      assert.ok(calls.length > 0)
      assert.equal(sh.open().docket, true, 'and it is still open 5 minutes later: no reclaim')
    } finally { await view.unmount() }
  } finally { realClock() }
})

test('T5 a run starts by closing the docket that was open before the idle delay; normal steps follow', async () => {
  useFakeClock()
  setRequireTrustedInput(false)
  try {
    watchInput(() => {})()
    key()
    const sh = shell(); const calls: string[] = []
    const { routes } = wired(sh, calls)
    sh.user('docket', true)
    const view = await mountView(<Cycle routes={routes} />, el => el)
    try {
      assert.equal(sh.open().docket, true, 'open before the run')
      await advance(ATTRACT_IDLE_MS + 2_000, 500); sh.render()
      assert.equal(sh.closeCalls(), 1, 'the run start asked the shell to close every docket, exactly once')
      assert.equal(sh.open().docket, false, 'the run start closed it')
      await advance(30_000, 1_000)
      assert.ok(calls.some(c => c.startsWith('show:')), 'steps run normally after')
    } finally { await view.unmount() }
  } finally { realClock() }
})

test('T7 after a takeover stop with Start-after 0 the next run waits 60 s with no input: at 59 s no run and the docket is open, at 61 s it starts and closes it', async () => {
  useFakeClock()
  setRequireTrustedInput(false)
  const sc = overlay()
  try {
    watchInput(() => {})()
    key()
    const sh = shell(); const calls: string[] = []
    const { routes } = wired(sh, calls)
    const view = await mountView(<Cycle routes={routes} idleMs={0} />, el => el)
    try {
      const running = () => view.el.querySelector('span')!.dataset.running
      await advance(50, 10)
      await untilDocket(sh)
      await inAct(() => { fire(sc.panel, 'pointerdown') })
      assert.equal(running(), 'false', 'the takeover stops the run')
      const closesBefore = sh.closeCalls()
      await advance(TAKEOVER_GAP_MS - 1_000, 1_000); sh.render()
      assert.equal(running(), 'false', 'no run at 59 s of no input')
      assert.equal(sh.open().docket, true, 'and the touched docket is open')
      await advance(2_000, 500); sh.render()
      assert.equal(running(), 'true', 'at 61 s the run starts')
      assert.equal(sh.closeCalls(), closesBefore + 1, 'and closes the dockets')
    } finally { await view.unmount() }
  } finally { sc.root.remove(); realClock() }
})

test('T6 a run start closes the org docket and every floating agent/team docket of the window, traced as close/attract/run_start; popped-out ones are untouched', async () => {
  const log: Record<string, unknown>[] = []
  const { setDocketLogSink, resetDocketLog, docketChanged, markDocketPath, registerDocketCloser, closeFloatingDockets } = await import('../src/attract/docketlog')
  setDocketLogSink(r => { log.push(r) }); resetDocketLog()
  try {
    docketChanged('org', 'open'); docketChanged('agent', 'open'); docketChanged('team', 'open')
    let closed = 0
    const offs = [registerDocketCloser(() => { closed++; docketChanged('agent', 'close') }), registerDocketCloser(() => { closed++; docketChanged('team', 'close') })]
    log.length = 0
    markDocketPath('attract', 'run_start', 3)
    assert.equal(closeFloatingDockets(), 2)
    docketChanged('org', 'close')
    assert.equal(closed, 2)
    assert.deepEqual(log.map(r => [r.kind, r.action, r.path, r.reason, r.count]), [
      ['agent', 'close', 'attract', 'run_start', 2], ['team', 'close', 'attract', 'run_start', 1], ['org', 'close', 'attract', 'run_start', 0],
    ])
    offs.forEach(o => o())
  } finally { setDocketLogSink(null); resetDocketLog() }
})

test('R2 every release is traced with what triggered it (an enum only); a stop says stop', () => {
  const got: Record<string, unknown>[] = []
  setAttractTraceSink(r => { got.push(r) })
  setAttractTraceLive(true)
  try {
    const sh = shell()
    const panels = createAttractPanels(sh.host)
    panels.apply({ kind: 'docket', item: 'SECRET' }); sh.render()
    panels.apply('release', 'wheel')
    assert.deepEqual(got.filter(r => r.ev === 'release').map(r => r.via), ['wheel'])
    sh.user('docket', false)
    panels.apply({ kind: 'docket', item: 'SECRET' }); sh.render()
    panels.apply('release')
    assert.deepEqual(got.filter(r => r.ev === 'release').map(r => r.via), ['wheel', 'stop'])
    assert.ok(!JSON.stringify(got).includes('SECRET'))
  } finally { setAttractTraceSink(null); setAttractTraceLive(false) }
})


test('R4 while an unowned docket is open the cycle takes no ticket steps into it; the agent steps still run', async () => {
  useFakeClock()
  try {
    watchInput(() => {})()
    key()
    const calls: string[] = []
    const docket = { foreignSince: () => Date.now() - 1_000, closeAll: () => {} }
    const view = await mountView(<Cycle routes={routesWith(calls, docket)} />, el => el)
    try {
      await advance(ATTRACT_IDLE_MS + 60_000, 500)
      assert.ok(calls.length > 0)
      assert.ok(!calls.includes('show:ticket') && !calls.includes('show:attention'), `no ticket step: ${calls.join()}`)
      assert.ok(calls.includes('show:agent') || calls.includes('show:org'), 'org and agent steps run')
    } finally { await view.unmount() }
  } finally { realClock() }
})


test('R6 the time an unowned docket is open counts toward the docket share (docket_pct), whoever owns it', async () => {
  const trace: Record<string, unknown>[] = []
  setAttractTraceSink(r => { trace.push(r) })
  useFakeClock()
  try {
    watchInput(() => {})()
    key()
    const calls: string[] = []
    let t0 = 0
    const docket = { foreignSince: () => (t0 ? t0 : null), closeAll: () => {} }   // a docket that stays open
    const view = await mountView(<Cycle routes={routesWith(calls, docket)} />, el => el)
    try {
      await advance(ATTRACT_IDLE_MS + 2_000, 500)
      t0 = Date.now()
      await advance(100_000, 1_000)
      const last = trace.filter(r => r.ev === 'step').at(-1)!
      assert.ok((last.docket_pct as number) >= 25, `100 s of a 300 s window is about 33%: saw ${String(last.docket_pct)}`)
    } finally { await view.unmount() }
  } finally { realClock(); setAttractTraceSink(null) }
})


test("R7 a docket opened twice is one instance, and attract's close leaves none open (at most one docket per window)", async () => {
  const sh = shell()
  const panels = createAttractPanels(sh.host)
  panels.apply({ kind: 'docket', item: 'a' }); sh.render()
  panels.apply({ kind: 'docket', item: 'b' }); sh.render()   // a second open while it is up: the same instance, retargeted
  assert.equal(sh.shows(), 2)
  assert.deepEqual(sh.open(), { inbox: false, docket: true })
  panels.apply(null); sh.render()
  assert.equal(sh.open().docket, false, 'one close shuts it')
  await Promise.resolve()   // the same-tick memory of what attract closed is gone by the next turn
  // a docket open anywhere (the user's, or popped out) is never opened over: the cycle keeps tickets away from it (R4), and if it
  // is reached anyway the open retargets that one docket and is not attract's to close
  sh.user('docket', true)
  panels.apply({ kind: 'docket', item: 'c' }); sh.render()
  panels.apply(null); sh.render()
  assert.equal(sh.open().docket, true, "the user's docket stays")
})

test("R8 a docket open where attract cannot close it (popped out, or an agent docket floating beside the org docket) is the user's: no second docket, nothing closed", () => {
  const got: Record<string, unknown>[] = []
  setAttractTraceSink(r => { got.push(r) })
  setAttractTraceLive(true)
  try {
    const sh = shell()
    const panels = createAttractPanels(sh.host)
    assert.equal(panels.docket.foreignSince(), null)
    sh.elsewhere(true)
    assert.equal(typeof panels.docket.foreignSince(), 'number', 'elsewhere: foreign, so the cycle takes no ticket step into it')
    panels.docket.closeAll(); sh.render()
    assert.equal(sh.open().docket, false, "nothing of attract's to close")
    assert.equal(typeof panels.docket.foreignSince(), 'number', 'it stays foreign until it is gone')
    sh.elsewhere(false)
    assert.equal(panels.docket.foreignSince(), null)
  } finally { setAttractTraceSink(null); setAttractTraceLive(false) }
})

test("R9 an agent's or team's docket floating in this org is seen; the org docket itself, other orgs and other panels are not", () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 }
  updatePinSurface(pinSurfaceKey('acme', 'agent-docket:cora', true), 'acme', rect, true)
  updatePinSurface(pinSurfaceKey('acme', 'docket', true), 'acme', rect, true)
  updatePinSurface(pinSurfaceKey('acme', 'node-inbox:cora', true), 'acme', rect, true)
  updatePinSurface(pinSurfaceKey('other', 'agent-docket:max', true), 'other', rect, true)
  assert.deepEqual(floatingOtherDockets('acme'), ['agent-docket:cora'])
  assert.deepEqual(floatingOtherDockets('nobody'), [])
})

