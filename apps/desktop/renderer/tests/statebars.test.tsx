// States tab duration bars: log length on a fixed 1 s .. 7 d scale, the status
// colour, live growth, exact-duration hover (USER 2026-11-03 12:09:22Z
// m03bf57ef1d94, @item:orgtree/agent-settings-show-active-idle-blocked-halted-f).
import { flush, inAct, mountView } from './harness'
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AgentStatesView, barWidthPct, fmtExact, scalePips, scaleMaxSecs, ageSecsOf } from '../src/canvas/statesview'

declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
const rules = (selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...css.matchAll(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`, 'g'))].map(m => m[1]).join(';')
}
const decl = (rule: string, prop: string): string | undefined =>
  [...rule.matchAll(new RegExp(`(?:^|[;\\s{])${prop}\\s*:\\s*([^;]+)`, 'g'))].map(m => m[1]!.trim()).at(-1)
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const zero = { active: 0, idle: 0, blocked: 0, halted: 0, frozen: 0 }

test('bar length is logarithmic on a fixed scale: 1 s is the minimum, 7 d or more is full', () => {
  const min = barWidthPct(1)
  assert.ok(min > 0 && min <= 3, `a few px at most, got ${min}%`)
  assert.equal(barWidthPct(0), min, 'zero reads as the minimum')
  assert.equal(barWidthPct(-5), min, 'a clamped span never goes below it')
  assert.equal(barWidthPct(604800), 100)
  assert.equal(barWidthPct(10_000_000), 100, 'beyond 7 d the bar stays full')
  const near = (got: number, want: number) => assert.ok(Math.abs(got - want) < 0.2, `${got} vs ${want}`)
  near(barWidthPct(60), 100 * Math.log(60) / Math.log(604800))       // about 30.8
  near(barWidthPct(3600), 100 * Math.log(3600) / Math.log(604800))   // about 61.5
  near(barWidthPct(86400), 100 * Math.log(86400) / Math.log(604800)) // about 85.4
  const steps = [2, 10, 100, 1e3, 1e4, 1e5, 6e5].map(secs => barWidthPct(secs))
  assert.ok(steps.every((w, i) => i === 0 || w > steps[i - 1]!), 'longer spans draw longer bars')
})

test('the hover reads the exact duration', () => {
  assert.equal(fmtExact(0), '0s')
  assert.equal(fmtExact(720), '12m')
  assert.equal(fmtExact(725), '12m 5s')
  assert.equal(fmtExact(90061), '1d 1h 1m 1s')
  assert.equal(fmtExact(604800), '7d')
})

test('each state bar uses the status colour its dot uses, through one shared variable', () => {
  const expect: Record<string, string> = { active: 'var(--state-provider, var(--ok))', idle: 'var(--dim)', blocked: 'var(--bad)', halted: 'var(--bad)', frozen: 'var(--ice)' }
  for (const [state, colour] of Object.entries(expect)) {
    const rule = state === 'idle' ? rules('.agent-states [data-state]') : rules(`.agent-states [data-state="${state}"]`)
    assert.equal(decl(rule, '--state-colour'), colour, `${state} colour`)
  }
  assert.equal(decl(rules('.agent-states .state-dot'), 'background'), 'var(--state-colour)', 'the dot reads it')
  assert.equal(decl(rules('.agent-states .state-bar'), 'background'), 'var(--state-colour)', 'the bar reads the same variable')
})

const page = {
  node: 'worker', next_cursor: null,
  totals: { h24: zero, d7: zero },
  states: [
    { state: 'idle', start: '2026-11-02T12:00:00Z', end: null, secs: 1800 },
    { state: 'active', start: '2026-11-02T11:48:00Z', end: '2026-11-02T12:00:00Z', secs: 720 },
    { state: 'frozen', start: '2026-11-01T10:00:00Z', end: '2026-11-02T11:48:00Z', secs: 100_000 },
  ],
}
const pct = (el: Element | null) => parseFloat((el as HTMLElement).style.width)

test('rows draw a coloured bar with the exact duration on hover; the open span grows with the clock', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2026-11-02T12:30:00Z') })
  globalThis.fetch = (async () => response(page)) as typeof fetch
  const view = await mountView(<AgentStatesView slug="fixture" nid="worker" />, el => el)
  try {
    await inAct(async () => { await flush(3) })
    const rows = [...view.el.querySelectorAll('li[data-state]')]
    const bars = rows.map(r => r.querySelector('.state-bar'))
    assert.ok(bars.every(Boolean), 'every row has a bar')
    assert.deepEqual(rows.map(r => r.querySelector('.state-bar')!.classList.contains(r.getAttribute('data-state')!)), [true, true, true],
      'each bar carries its state for the colour')
    assert.ok(Math.abs(pct(bars[0]!) - barWidthPct(1800)) < 0.2, 'open span width from now - start')
    assert.ok(Math.abs(pct(bars[1]!) - barWidthPct(720)) < 0.2)
    assert.ok(Math.abs(pct(bars[2]!) - barWidthPct(100_000)) < 0.2)
    const hover = (r: Element) => (r.querySelector('.agent-states-bar') as HTMLElement).getAttribute('title')
    assert.equal(hover(rows[0]!), 'Idle for 30m')
    assert.equal(hover(rows[1]!), 'Active for 12m')
    assert.equal(hover(rows[2]!), 'Frozen for 1d 3h 46m 40s')
    const before = pct(bars[0]!)
    await view.tick(3_600_000, ms => mock.timers.tick(ms))
    await inAct(async () => { await flush(2) })
    const after = [...view.el.querySelectorAll('li[data-state]')]
    assert.ok(pct(after[0]!.querySelector('.state-bar')) > before, 'the open span bar grew')
    assert.equal((after[0]!.querySelector('.agent-states-bar') as HTMLElement).getAttribute('title'), 'Idle for 1h 30m', 'and its hover with it')
    assert.equal(pct(after[1]!.querySelector('.state-bar')), pct(bars[1]!), 'a closed span never grows')
  } finally { await view.unmount(); mock.timers.reset() }
})

test('the duration text sits beside its bar in its own aligned column; bars share a left edge', () => {
  const row = rules('.agent-states-list li')
  const cols = decl(row, 'grid-template-columns') ?? ''
  const tracks = cols.split(/\s+(?![^(]*\))/)
  assert.equal(tracks.length, 4, `name | time | bar | duration, got "${cols}"`)
  assert.match(tracks[0]!, /^\d+px$/); assert.match(tracks[1]!, /^\d+px$/, 'the fixed columns before the bar are equal on every row, so every bar starts at one left edge')
  assert.equal(tracks[2], 'minmax(0, 1fr)', 'the bar track takes the rest of the row (USER m1ef0c049a6fd), the same on every row, so every bar also ends at one right edge')
  assert.match(tracks[3]!, /^\d+(px|em|rem|ch)$/, 'the duration column is a fixed width')
  const dur = rules('.agent-states-dur')
  assert.equal(decl(dur, 'text-align'), 'right')
  assert.equal(decl(dur, 'font-variant-numeric'), 'tabular-nums')
})

test('scale pips: 1 min, 1 hour and 1 day sit at the exact log positions of the bars, and any pip beyond the track is dropped', () => {
  assert.deepEqual(scalePips().map(p => p.label), ['1 min', '1 hour', '1 day'])
  for (const p of scalePips()) assert.equal(p.pct, barWidthPct(p.secs), `${p.label} uses the bar scale`)
  assert.deepEqual(scalePips().map(p => p.secs), [60, 3600, 86400])
  assert.ok(scalePips().every(p => p.pct > 0 && p.pct <= 100))
  assert.deepEqual(scalePips(3600).map(p => p.label), ['1 min', '1 hour'], 'a pip past the track maximum is omitted')
})

test('every row track carries the three pips with hover labels and no row text; a 1 h span ends at the 1 h pip', async () => {
  globalThis.fetch = (async () => response({ node: 'worker', next_cursor: null, totals: { h24: zero, d7: zero }, states: [
    { state: 'idle', start: '2026-11-02T10:00:00Z', end: '2026-11-02T11:00:00Z', secs: 3600 },
    { state: 'active', start: '2026-11-02T09:00:00Z', end: '2026-11-02T09:00:30Z', secs: 30 },
  ] })) as typeof fetch
  const view = await mountView(<AgentStatesView slug="fixture" nid="worker" />, el => el)
  try {
    await inAct(async () => { await flush(3) })
    const rows = [...view.el.querySelectorAll('li[data-state]')]
    assert.ok(rows.length >= 2)
    for (const r of rows) {
      const pips = [...r.querySelectorAll('.agent-states-bar .state-pip')] as HTMLElement[]
      assert.deepEqual(pips.map(p => p.getAttribute('title')), ['1 min', '1 hour', '1 day'])
      assert.deepEqual(pips.map(p => p.textContent), ['', '', ''], 'no text on the row')
      assert.deepEqual(pips.map(p => parseFloat(p.style.left)), scalePips().map(p => p.pct))
    }
    const bar = parseFloat((rows[0]!.querySelector('.state-bar') as HTMLElement).style.width)
    const hour = parseFloat((rows[0]!.querySelectorAll('.state-pip')[1] as HTMLElement).style.left)
    assert.ok(Math.abs(bar - hour) < 0.01, 'the 1 h bar ends exactly at the 1 h pip')
  } finally { await view.unmount() }
})

test('pips are subtle, theme-aware ticks drawn over the track without hiding the state colour', () => {
  const pip = rules('.agent-states .state-pip')
  assert.match(pip, /position:\s*absolute/)
  assert.match(decl(pip, 'background') ?? '', /var\(--(bg|ink)/, 'built from theme variables, not a fixed colour')
  assert.doesNotMatch(decl(pip, 'background') ?? '', /#[0-9a-f]{3,8}/i)
})

// LONGER SCALES FOR OLDER AGENTS (USER 2026-11-05 m7a0e94f5e592): the full bar is 7 d for an agent under a week old, 1 month
// (30 d) once it is older than a week, 1 year (365 d) once older than a month; pips add 1 week / 1 month.
const D = 86400
test('the scale tier follows the agent age: 6.9 d and exactly 7 d stay at 7 d; 7.1 and 29 d reach 1 month; 31 d reaches 1 year', () => {
  assert.equal(scaleMaxSecs(0), 7 * D)
  assert.equal(scaleMaxSecs(6.9 * D), 7 * D)
  assert.equal(scaleMaxSecs(7 * D), 7 * D, 'exactly a week is not yet over a week')
  assert.equal(scaleMaxSecs(7.1 * D), 30 * D)
  assert.equal(scaleMaxSecs(29 * D), 30 * D)
  assert.equal(scaleMaxSecs(30 * D), 30 * D)
  assert.equal(scaleMaxSecs(31 * D), 365 * D)
  assert.equal(scaleMaxSecs(5000 * D), 365 * D, 'a year is the top')
})

test('each scale is logarithmic with its own maximum: 1 s minimum, the maximum fills the bar; the default stays 7 d', () => {
  assert.equal(barWidthPct(100 * D, 30 * D), 100, 'beyond the month maximum the bar is full')
  assert.equal(barWidthPct(30 * D, 30 * D), 100)
  assert.equal(barWidthPct(1, 365 * D), barWidthPct(1), '1 s is the minimum on every scale')
  assert.ok(Math.abs(barWidthPct(7 * D, 30 * D) - 100 * Math.log(7 * D) / Math.log(30 * D)) < 0.01)
  assert.ok(Math.abs(barWidthPct(30 * D, 365 * D) - 100 * Math.log(30 * D) / Math.log(365 * D)) < 0.01)
  assert.equal(barWidthPct(7 * D), 100, 'no max given: the old 7 d scale')
  assert.equal(barWidthPct(3600), barWidthPct(3600, 7 * D))
})

test('pips per tier: 3 at 7 d; plus 1 week at 1 month; plus 1 month at 1 year; positions on that tier scale', () => {
  assert.deepEqual(scalePips().map(p => p.label), ['1 min', '1 hour', '1 day'])
  assert.deepEqual(scalePips(7 * D).map(p => p.label), ['1 min', '1 hour', '1 day'], 'the 1 week pip would sit at the end: not drawn')
  const m = scalePips(30 * D)
  assert.deepEqual(m.map(p => p.label), ['1 min', '1 hour', '1 day', '1 week'])
  assert.equal(m[3]!.secs, 7 * D); assert.equal(m[3]!.pct, barWidthPct(7 * D, 30 * D), 'the week pip is where a 1 week span ends')
  const y = scalePips(365 * D)
  assert.deepEqual(y.map(p => p.label), ['1 min', '1 hour', '1 day', '1 week', '1 month'])
  assert.equal(y[4]!.secs, 30 * D); assert.equal(y[4]!.pct, barWidthPct(30 * D, 365 * D))
  assert.ok(y.every(p => p.pct === barWidthPct(p.secs, 365 * D)))
})

test('age is measured from the hire time, or the earliest loaded span when no hire time is known', () => {
  const now = Date.parse('2026-11-02T12:30:00Z')
  const span = (start: string) => ({ state: 'idle' as const, start, end: null, secs: 0 })
  assert.equal(ageSecsOf('2026-10-02T12:30:00Z', [span('2026-11-01T00:00:00Z')], now), 31 * D, 'hire time wins when older')
  assert.equal(ageSecsOf(undefined, [span('2026-10-20T12:30:00Z'), span('2026-10-25T12:30:00Z')], now), 13 * D, 'earliest span')
  assert.equal(ageSecsOf('garbage', [], now), 0)
  assert.equal(ageSecsOf(undefined, [], now), 0)
})

const ageMountPage = (spans: { state: string; start: string; end: string | null; secs: number }[]) =>
  ({ node: 'worker', next_cursor: null, totals: { h24: zero, d7: zero }, states: spans })
test('rows draw the pips and bar length of the agent tier; a 1 week span ends at the 1 week pip on the month scale; the tier moves up live', async () => {
  const nowIso = '2026-11-02T12:30:00Z'
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse(nowIso) })
  // a span can never predate its agent's hire, so each agent gets spans inside its own age
  let weekLong = true
  globalThis.fetch = (async () => response(ageMountPage(weekLong ? [
    { state: 'idle', start: '2026-10-26T12:00:00Z', end: '2026-11-02T12:00:00Z', secs: 7 * D },
    { state: 'active', start: '2026-10-26T11:00:00Z', end: '2026-10-26T12:00:00Z', secs: 3600 },
  ] : [
    { state: 'idle', start: '2026-10-28T12:00:00Z', end: '2026-11-02T12:00:00Z', secs: 5 * D },
    { state: 'active', start: '2026-10-28T11:00:00Z', end: '2026-10-28T12:00:00Z', secs: 3600 },
  ]))) as typeof fetch
  const created = (days: number) => new Date(Date.parse(nowIso) - days * D * 1000).toISOString()
  const labels = (el: Element) => [...el.querySelectorAll('li[data-state]')[0]!.querySelectorAll('.state-pip')].map(p => p.getAttribute('title'))
  const view = await mountView(<AgentStatesView slug="fixture" nid="worker" created={created(10)} />, el => el)
  try {
    await inAct(async () => { await flush(3) })
    assert.deepEqual(labels(view.el), ['1 min', '1 hour', '1 day', '1 week'], 'a 10 d old agent: month scale')
    const row = view.el.querySelectorAll('li[data-state]')[0]!
    const bar = parseFloat((row.querySelector('.state-bar') as HTMLElement).style.width)
    const week = parseFloat((row.querySelectorAll('.state-pip')[3] as HTMLElement).style.left)
    assert.ok(Math.abs(bar - week) < 0.01, 'the 1 week span ends exactly at the 1 week pip')
    assert.ok(Math.abs(bar - barWidthPct(7 * D, 30 * D)) < 0.01)
  } finally { await view.unmount() }
  weekLong = false
  const young = await mountView(<AgentStatesView slug="fixture" nid="worker" created={created(6.9)} />, el => el)
  try {
    await inAct(async () => { await flush(3) })
    assert.deepEqual(labels(young.el), ['1 min', '1 hour', '1 day'], '6.9 d: still the week scale')
    await young.tick(3 * 3600 * 1000, ms => mock.timers.tick(ms))
    await inAct(async () => { await flush(2) })
    assert.deepEqual(labels(young.el), ['1 min', '1 hour', '1 day', '1 week'], 'crossing a week moves the scale up live')
  } finally { await young.unmount() }
  weekLong = true
  const old = await mountView(<AgentStatesView slug="fixture" nid="worker" created={created(31)} />, el => el)
  try {
    await inAct(async () => { await flush(3) })
    assert.deepEqual(labels(old.el), ['1 min', '1 hour', '1 day', '1 week', '1 month'], '31 d: the year scale')
  } finally { await old.unmount(); mock.timers.reset() }
})
