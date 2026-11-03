// States tab duration bars: log length on a fixed 1 s .. 7 d scale, the status
// colour, live growth, exact-duration hover (USER 2026-11-03 12:09:22Z
// m03bf57ef1d94, @item:orgtree/agent-settings-show-active-idle-blocked-halted-f).
import { flush, inAct, mountView } from './harness'
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AgentStatesView, barWidthPct, fmtExact } from '../src/canvas/statesview'

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
  const steps = [2, 10, 100, 1e3, 1e4, 1e5, 6e5].map(barWidthPct)
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
