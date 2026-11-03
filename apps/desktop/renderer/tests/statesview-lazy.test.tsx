// The States tab loads older states lazily (USER 2026-11-03 17:27:54Z m779d1355bbd4), shows HH:MM start times with
// a date divider per local day (mc4ba13607c47), and its bar track takes the row width (m1ef0c049a6fd).
import { flush, inAct, mountView } from './harness'
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { AgentStatesView, liveRecordedState, totalsWithLive, withLive } from '../src/canvas/statesview'
import { setDisplayZone } from '../src/timefmt'

const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const span = (state: string, start: string, end: string | null, secs: number) => ({ state, start, end, secs })
const zero = { active: 0, idle: 0, blocked: 0, halted: 0, frozen: 0 }

/** a stand-in IntersectionObserver the test fires by hand: `seen()` reports every live target in view */
function fakeObserver(t: { after: (fn: () => void) => void }) {
  const live = new Set<{ cb: (e: { isIntersecting: boolean }[]) => void }>()
  const g = globalThis as Record<string, unknown>
  const had = g.IntersectionObserver
  g.IntersectionObserver = class {
    entry: { cb: (e: { isIntersecting: boolean }[]) => void }
    constructor(cb: (e: { isIntersecting: boolean }[]) => void) { this.entry = { cb } }
    observe() { live.add(this.entry) }
    disconnect() { live.delete(this.entry) }
    unobserve() { live.delete(this.entry) }
  }
  t.after(() => { g.IntersectionObserver = had })
  return { count: () => live.size, seen: () => { for (const o of [...live]) o.cb([{ isIntersecting: true }]) } }
}

const PAGE1 = { node: 'w', next_cursor: 'c1', totals: { h24: zero, d7: zero },
  states: [span('idle', '2026-11-02T12:00:00Z', null, 1800), span('active', '2026-11-02T11:00:00Z', '2026-11-02T12:00:00Z', 3600)] }
const PAGE2 = { node: 'w', next_cursor: 'c2', states: [span('frozen', '2026-11-02T09:00:00Z', '2026-11-02T11:00:00Z', 7200)] }
const PAGE3 = { node: 'w', next_cursor: null, states: [span('blocked', '2026-11-01T22:00:00Z', '2026-11-02T09:00:00Z', 39600)] }

const rowsOf = (el: Element) => [...el.querySelectorAll('li[data-state]')].map(r => r.getAttribute('data-state'))

test('the first fetch has no cursor; reaching the sentinel fetches the cursor page once; none after the end', async t => {
  const io = fakeObserver(t)
  const urls: string[] = []
  let release: (() => void) | null = null
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url))
    const u = String(url)
    if (u.includes('before=c1')) { await new Promise<void>(r => { release = r }); return response(PAGE2) }
    if (u.includes('before=c2')) return response(PAGE3)
    return response(PAGE1)
  }) as typeof fetch
  const view = await mountView(<AgentStatesView slug="fixture" nid="w" />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(3) })
  assert.equal(urls.length, 1)
  assert.doesNotMatch(urls[0]!, /before=/, 'the open fetches the first page only')
  assert.equal(view.el.querySelector('button.agent-states-more'), null, 'no Load older button: the sentinel does it')
  assert.ok(io.count() > 0, 'a sentinel is watched while a cursor stands')
  await inAct(async () => { io.seen(); io.seen(); await flush(2) })
  assert.equal(urls.filter(u => u.includes('before=c1')).length, 1, 'two sightings while one fetch is in flight make one fetch')
  assert.match(view.el.textContent ?? '', /Loading older states/, 'a loading row while the page loads')
  await inAct(async () => { release?.(); await flush(4) })
  assert.deepEqual(rowsOf(view.el), ['idle', 'active', 'frozen'])
  await inAct(async () => { io.seen(); await flush(4) })
  assert.match(urls[urls.length - 1]!, /before=c2/)
  assert.deepEqual(rowsOf(view.el), ['idle', 'active', 'frozen', 'blocked'])
  const after = urls.length
  assert.equal(io.count(), 0, 'the cursor is spent: nothing is watched')
  await inAct(async () => { io.seen(); await flush(2) })
  assert.equal(urls.length, after, 'no fetch after the end')
  assert.equal(view.el.querySelectorAll('.agent-states-totals').length, 1, 'totals come from the first page and stay')
})

test('a failed page shows an inline retry row and keeps the rows already shown', async t => {
  const io = fakeObserver(t)
  let fail = true
  const urls: string[] = []
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url))
    if (String(url).includes('before=c1')) { if (fail) return new Response('nope', { status: 500 }); return response(PAGE3) }
    return response(PAGE1)
  }) as typeof fetch
  const view = await mountView(<AgentStatesView slug="fixture" nid="w" />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(3) })
  await inAct(async () => { io.seen(); await flush(4) })
  const retry = [...view.el.querySelectorAll('button')].find(b => /retry/i.test(b.textContent ?? ''))
  assert.ok(retry, 'an inline Retry')
  assert.deepEqual(rowsOf(view.el), ['idle', 'active'], 'the rows already shown stay')
  const n = urls.length
  await inAct(async () => { io.seen(); await flush(2) })
  assert.equal(urls.length, n, 'a failed page is not re-fetched in a loop by the sentinel')
  fail = false
  await inAct(async () => { retry!.click(); await flush(4) })
  assert.deepEqual(rowsOf(view.el), ['idle', 'active', 'blocked'])
})

test('each row shows its start as HH:MM in the display zone, and the full stamp stays on hover', async t => {
  setDisplayZone('UTC'); t.after(() => setDisplayZone(null))
  fakeObserver(t)
  globalThis.fetch = (async () => response(PAGE1)) as typeof fetch
  const view = await mountView(<AgentStatesView slug="fixture" nid="w" />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(3) })
  const times = [...view.el.querySelectorAll('li[data-state] time')]
  assert.deepEqual(times.map(x => x.textContent), ['12:00', '11:00'])
  assert.match(times[1]!.getAttribute('title') ?? '', /→/, 'the hover names the whole span')
  assert.match(times[0]!.getAttribute('title') ?? '', /now/, 'the open span ends now')
})

test('one date divider per local day, none doubled at a page join, and the day turns at local midnight', async t => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T12:00:00Z') })
  t.after(() => mock.timers.reset())
  const io = fakeObserver(t)
  setDisplayZone('UTC'); t.after(() => setDisplayZone(null))
  globalThis.fetch = (async (url: string) => String(url).includes('before=c1')
    ? response({ node: 'w', next_cursor: null, states: [span('frozen', '2026-11-02T09:00:00Z', '2026-11-02T11:00:00Z', 7200), span('blocked', '2026-11-01T22:00:00Z', '2026-11-02T09:00:00Z', 39600)] })
    : response(PAGE1)) as typeof fetch
  const view = await mountView(<AgentStatesView slug="fixture" nid="w" />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(3) })
  const days = () => [...view.el.querySelectorAll('[role="separator"]')].map(d => d.textContent)
  assert.deepEqual(days(), ['Nov 2'], 'page 1: both rows are on Nov 2')
  await inAct(async () => { io.seen(); await flush(4) })
  // the page join continues Nov 2 (no second divider); the last row is on Nov 1 (22:00Z)
  assert.deepEqual(days(), ['Nov 2', 'Nov 1'])
  const order = [...view.el.querySelectorAll('.agent-states-list > li')].map(l => l.getAttribute('role') === 'separator' ? 'D' : 'R')
  assert.equal(order.join(''), 'DRRRDR', 'a divider sits before the first row of each day')
})

test('a span either side of UTC midnight is one day in a zone where it is not midnight, two days where it is', async t => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T12:00:00Z') })
  t.after(() => mock.timers.reset())
  fakeObserver(t)
  const page = { node: 'w', next_cursor: null, states: [span('idle', '2026-11-03T00:30:00Z', null, 600), span('active', '2026-11-02T23:30:00Z', '2026-11-03T00:30:00Z', 3600)] }
  globalThis.fetch = (async () => response(page)) as typeof fetch
  for (const [zone, expected] of [['UTC', ['Nov 3', 'Nov 2']], ['Asia/Jerusalem', ['Nov 3']]] as const) {
    setDisplayZone(zone); t.after(() => setDisplayZone(null))
    const view = await mountView(<AgentStatesView slug="fixture" nid="w" />, el => el)
    await inAct(async () => { await flush(3) })
    assert.deepEqual([...view.el.querySelectorAll('[role="separator"]')].map(d => d.textContent), expected, zone)
    view.unmount()
  }
})

test('the bar track fills the row between the time and the duration columns', async () => {
  const { readFileSync } = await import('node:fs')
  const path = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.agent-states-list li \{[^}]*grid-template-columns: 88px 40px minmax\(0, 1fr\) 56px/, 'fixed label, time, and duration columns around a 1fr track')
  assert.match(css, /\.agent-states-bar \{[^}]*width: 100%/, 'the track is the whole 1fr cell, not a fixed 90px')
})

// USER 2026-11-03 17:39:40Z mb71bc6df4882: no Refresh button; the tab reads the first page fresh on open and is then
// kept current from the node data the renderer already holds, locally, with no polling and no refetch.
test('there is no Refresh button, and a live state change adds a row and closes the open span without fetching again', async t => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2026-11-02T12:30:00Z') })
  t.after(() => mock.timers.reset())
  fakeObserver(t)
  setDisplayZone('UTC'); t.after(() => setDisplayZone(null))
  const urls: string[] = []
  globalThis.fetch = (async (url: string) => { urls.push(String(url)); return response(PAGE1) }) as typeof fetch
  const view = await mountView(<AgentStatesView slug="fixture" nid="w" liveState="idle" />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(3) })
  assert.equal([...view.el.querySelectorAll('button')].some(b => /refresh/i.test(b.textContent ?? '')), false, 'no Refresh button')
  assert.deepEqual(rowsOf(view.el), ['idle', 'active'])
  mock.timers.tick(60_000)  // a minute later the agent starts a turn
  await view.render(<AgentStatesView slug="fixture" nid="w" liveState="active" />)
  await inAct(async () => { await flush(3) })
  assert.deepEqual(rowsOf(view.el), ['active', 'idle', 'active'], 'the new state is added at the top')
  const closed = view.el.querySelectorAll('li[data-state]')[1]!
  assert.equal(closed.hasAttribute('data-open'), false, 'the previous open span is closed locally')
  assert.equal(view.el.querySelectorAll('li[data-state]')[0]!.hasAttribute('data-open'), true)
  assert.equal(urls.length, 1, 'no refetch and no polling: the one fetch is the open')
  // the totals grew locally by the time the page has been open
  assert.match(view.el.querySelector('.agent-states-totals')?.textContent ?? '', /Idle 60s/, 'the idle time since the read is added to the totals locally')
})

test('reopening the tab fetches the first page fresh', async t => {
  fakeObserver(t)
  const urls: string[] = []
  globalThis.fetch = (async (url: string) => { urls.push(String(url)); return response(PAGE1) }) as typeof fetch
  for (let k = 0; k < 2; k++) {
    const view = await mountView(<AgentStatesView slug="fixture" nid="w" />, el => el)
    await inAct(async () => { await flush(3) })
    view.unmount()
  }
  assert.equal(urls.length, 2)
  assert.ok(urls.every(u => !u.includes('before=')))
})

test('withLive and totalsWithLive: the open span closes where the first live state begins; totals accrue per state', () => {
  const t0 = Date.parse('2026-11-02T12:00:00Z')
  const fetched = [span('idle', '2026-11-02T11:00:00Z', null, 3600), span('active', '2026-11-02T10:00:00Z', '2026-11-02T11:00:00Z', 3600)]
  const live = [{ state: 'active' as const, at: t0 + 60_000 }, { state: 'idle' as const, at: t0 + 180_000 }]
  const rows = withLive(fetched, live, t0 + 240_000)
  assert.deepEqual(rows.map(r => [r.state, r.end === null]), [['idle', true], ['active', false], ['idle', false], ['active', false]])
  assert.equal(rows[2]!.secs, 3660, 'the span that was open at the read ends where the live one begins')
  assert.equal(rows[1]!.secs, 120)
  const base = { active: 0, idle: 10, blocked: 0, halted: 0, frozen: 0 }
  const totals = totalsWithLive(base, t0, 'idle', live, t0 + 240_000)
  assert.deepEqual(totals, { active: 120, idle: 10 + 60 + 60, blocked: 0, halted: 0, frozen: 0 })
  assert.equal(withLive(fetched, [], t0), fetched, 'nothing live, nothing changed')
})

test('liveRecordedState reads the node through the desk badge derivation', () => {
  assert.equal(liveRecordedState({ halt: { phase: 'halted' } as never }), 'halted')
  assert.equal(liveRecordedState({ state: 'live' }), 'idle')
})

// USER 2026-11-03 17:40:33Z m6443dc36a3f1: Active is the agent's provider colour; other states are unchanged.
test('Active takes the provider colour for each provider; the other states keep their own', async t => {
  fakeObserver(t)
  globalThis.fetch = (async () => response(PAGE1)) as typeof fetch
  const { readFileSync } = await import('node:fs')
  const path = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.agent-states \[data-state="active"\] \{ --state-colour: var\(--state-provider, var\(--ok\)\); \}/)
  assert.match(css, /\.agent-states \[data-state="blocked"\] \{ --state-colour: var\(--bad\); \}/, 'blocked is unchanged')
  assert.match(css, /\.agent-states \[data-state="frozen"\] \{ --state-colour: var\(--ice\); \}/, 'frozen is unchanged')
  for (const provider of ['claude', 'openai']) {
    assert.match(css, new RegExp(`\\.agent-states\\.prov-${provider} \\{ --state-provider: var\\(--prov-${provider}\\); \\}`), provider)
    const view = await mountView(<AgentStatesView slug="fixture" nid="w" provider={provider} />, el => el)
    await inAct(async () => { await flush(3) })
    assert.ok(view.el.querySelector(`section.agent-states.prov-${provider}`), `the tab carries prov-${provider}`)
    view.unmount()
  }
})

declare const __SRC_DIR__: string
