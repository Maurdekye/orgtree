// Attract mode must not lose the docket it opened, and must recover one it lost
// (@item:orgtree/attract-mode-gets-stuck-on-the-docket-and-doesn-t, reopened; coordinator ruling 2026-11-06 m23a4fc62023a).
// Installed 4.5.6-alpha.1: a "release" 7 s into a docket visit, then the docket stayed open for minutes while ticket steps kept
// being routed into it as "owned:false". The user had not touched it.
import { advance, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { ATTRACT_IDLE_MS, DOCKET_RECLAIM_MS, lastInputAt, setRequireTrustedInput, targetKey, useAttractCycle, watchInput } from '../src/attract/attract'
import type { AttractRoutes } from '../src/attract/attract'
import { createAttractPanels } from '../src/attract/panels'
import type { PanelKind } from '../src/attract/panels'
import { setAttractTraceLive, setAttractTraceSink } from '../src/attract/trace'

function Cycle({ routes }: { routes: AttractRoutes }) {
  const running = useAttractCycle(true, routes, () => 0.99)
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
const fire = (el: Element, type: string) => {
  const W = window as unknown as Record<string, new (t: string, i?: object) => Event>
  const Ctor = type === 'keydown' ? W.KeyboardEvent : type === 'wheel' ? W.WheelEvent : W.MouseEvent
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true }))
}
function shell() {
  const committed: Record<PanelKind, boolean> = { inbox: false, docket: false }
  const pending: Record<PanelKind, boolean> = { inbox: false, docket: false }
  let shown = 0
  const host = {
    isOpen: (k: PanelKind) => committed[k],
    show: (k: PanelKind) => { pending[k] = true; shown++ },
    close: (k: PanelKind) => { pending[k] = false },
  }
  const render = () => { committed.inbox = pending.inbox; committed.docket = pending.docket }
  return { host, render, user: (k: PanelKind, open: boolean) => { pending[k] = open; render() }, open: () => ({ ...pending }), shows: () => shown }
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

test('R3 the panels know a docket that is open and not attract\'s, and can take it back and close it', () => {
  const sh = shell()
  const panels = createAttractPanels(sh.host)
  assert.equal(panels.docket.foreignSince(), null, 'closed: nothing foreign')
  sh.user('docket', true)
  const since = panels.docket.foreignSince()
  assert.equal(typeof since, 'number', 'the user\'s docket is foreign')
  assert.equal(panels.docket.foreignSince(), since, 'and keeps the time it was first seen')
  panels.docket.reclaim(); sh.render()
  assert.equal(sh.open().docket, false, 'reclaimed: closed')
  assert.equal(panels.docket.foreignSince(), null)
  // a docket attract lost to a (false) release is foreign from the release
  panels.apply({ kind: 'docket', item: 'a' }); sh.render()
  assert.equal(panels.docket.foreignSince(), null, 'attract\'s own docket is not foreign')
  panels.apply('release', 'keydown')
  assert.equal(typeof panels.docket.foreignSince(), 'number', 'after a release it is foreign')
  panels.docket.reclaim(); sh.render()
  assert.equal(sh.open().docket, false)
})

test('R4 while an unowned docket is open the cycle takes no ticket steps into it; the agent steps still run', async () => {
  useFakeClock()
  try {
    watchInput(() => {})()
    key()
    const calls: string[] = []
    const docket = { foreignSince: () => Date.now() - 1_000, reclaim: () => {} }
    const view = await mountView(<Cycle routes={routesWith(calls, docket)} />, el => el)
    try {
      await advance(ATTRACT_IDLE_MS + 60_000, 500)
      assert.ok(calls.length > 0)
      assert.ok(!calls.includes('show:ticket') && !calls.includes('show:attention'), `no ticket step: ${calls.join()}`)
      assert.ok(calls.includes('show:agent') || calls.includes('show:org'), 'org and agent steps run')
    } finally { await view.unmount() }
  } finally { realClock() }
})

test('R5 an unowned docket with no user input for 60 s is taken back; one the user is using is not', async () => {
  useFakeClock()
  setRequireTrustedInput(false)
  const sc = overlay()
  try {
    watchInput(() => {})()
    key()
    const calls: string[] = []
    let reclaims = 0
    let foreign: number | null = null
    const docket = { foreignSince: () => foreign, reclaim: () => { reclaims++; foreign = null } }
    const view = await mountView(<Cycle routes={routesWith(calls, docket)} />, el => el)
    try {
      await advance(ATTRACT_IDLE_MS + 2_000, 500)   // the run is going
      foreign = Date.now()                          // the docket is open and not attract's
      await inAct(() => { fire(sc.panel, 'wheel') }) // the user scrolls it now
      await advance(DOCKET_RECLAIM_MS - 12_000, 1_000)
      assert.equal(reclaims, 0, 'used within the last 60 s: left alone')
      await advance(DOCKET_RECLAIM_MS + 20_000, 1_000)
      assert.equal(reclaims, 1, 'idle for 60 s: taken back once')
    } finally { await view.unmount() }
  } finally { sc.root.remove(); realClock() }
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
    const docket = { foreignSince: () => (t0 ? t0 : null), reclaim: () => {} }   // a docket that stays open
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

test('R7 a docket opened twice is one instance, and attract's close leaves none open (at most one docket per window)', () => {
  const sh = shell()
  const panels = createAttractPanels(sh.host)
  panels.apply({ kind: 'docket', item: 'a' }); sh.render()
  panels.apply({ kind: 'docket', item: 'b' }); sh.render()   // a second open while it is up: the same instance, retargeted
  assert.equal(sh.shows(), 2)
  assert.deepEqual(sh.open(), { inbox: false, docket: true })
  panels.apply(null); sh.render()
  assert.equal(sh.open().docket, false, 'one close shuts it')
  // a docket open anywhere (the user's, or popped out) is never opened over: the cycle keeps tickets away from it (R4), and if it
  // is reached anyway the open retargets that one docket and is not attract's to close
  sh.user('docket', true)
  panels.apply({ kind: 'docket', item: 'c' }); sh.render()
  panels.apply(null); sh.render()
  assert.equal(sh.open().docket, true, 'the user's docket stays')
})
