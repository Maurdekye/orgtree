// fablepip.test.tsx — the "Fable pip" on the Claude weekly (all models) meter
// (USER 2026-11-10 18:11:26Z ma76204ba37d2; formula 18:15:42Z m9c19aae87fb3
// "Yes, r = ½": p = (1 + f) / 2, f = Fable weekly fraction used; docket
// usage-fable-pip-on-the-claude-weekly-meter).
//
//   §1  p for sample f values, on the weekly (all models) bar only
//   §2  hidden: no Fable reading, unknown, reset-passed, 100% used, no weekly
//   §3  only Fable scopes count (Gemini/Codex scoped windows never pip)
//   §4  live: a new Fable reading moves the pip
//   §5  the stylesheet draws it neutral (no warning/limit colour)
//   §6  hovering shows the caption with the pip's percentage after "this point"
//       (USER 2026-11-10 23:51:33Z ma05bce0c2983)
//   §7  past the pip, the unreachable end of the Fable bar is red, from
//       max(f, f + 2(1 - w)) to 100% (USER 2026-11-11 11:04:55Z m49c4c03b6da4)
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs fablepip

import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { UsageBars } from '../src/canvas/accounts'
import type { AccountUsage, UsageLimit } from '../src/types'
import * as fablepip from '../src/canvas/fablepip'

declare const __SRC_DIR__: string

const lim = (kind: string, percent: number | null, model: string | null = null,
  resets_at: string | null = null): UsageLimit => ({
  kind, group: kind, percent, severity: 'normal', resets_at, is_active: false, model,
})
const SOON = new Date(Date.now() + 3 * 86400000).toISOString()
const claude = (limits: UsageLimit[], extra: Partial<AccountUsage> = {}): AccountUsage => ({
  account: 'claude-5', provider: 'Claude', label: 'claude@example.test',
  available: true, plan: 'max', limits, ...extra,
})
const fableAt = (f: number | null, weekly = 35) => claude([
  lim('session', 10, null, SOON), lim('weekly_all', weekly, null, SOON),
  lim('weekly_scoped', f, 'Fable 5.2', SOON)])

async function bars(t: { after: (fn: () => void | Promise<void>) => void }, u: AccountUsage) {
  const view = await mountView(<UsageBars u={u} />, el => el)
  t.after(() => view.unmount())
  return view
}
const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.usage-row')]
const rowOf = (el: HTMLElement, label: RegExp) =>
  rows(el).find(r => label.test(r.querySelector('.u-label')?.textContent ?? '')) ?? null
const pips = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.usage-pip')]

test('§1 p = (1 + f) / 2 on the weekly (all models) bar only', async (t) => {
  for (const [f, p] of [[0, 50], [20, 60], [52, 76], [90, 95]] as const) {
    const view = await bars(t, fableAt(f))
    const all = pips(view.el)
    assert.equal(all.length, 1, `f=${f}%: exactly one pip (got ${all.length})`)
    const weekly = rowOf(view.el, /^weekly \(7 day\)$/)
    assert.ok(weekly, 'POSITIVE CONTROL: the weekly (all models) row rendered')
    assert.ok(weekly!.contains(all[0]!), `f=${f}%: the pip sits on the weekly (all models) bar`)
    assert.ok(weekly!.querySelector('.usage-track')!.contains(all[0]!), 'inside its track')
    assert.equal(all[0]!.style.left, `${p}%`, `f=${f}%: pip at ${p}%`)
    assert.match(all[0]!.getAttribute('title') ?? '',
      /rest of this week's Fable allowance can't be used up before the weekly limit/)
    assert.ok(all[0]!.getAttribute('aria-label'), 'and names itself for assistive tech')
    await view.unmount()
  }
})

test('§2 hidden: no Fable reading, unknown, reset passed, 100% used, no weekly bar', async (t) => {
  const PAST = new Date(Date.now() - 60000).toISOString()
  const cases: [string, AccountUsage][] = [
    ['no Fable window', claude([lim('session', 10), lim('weekly_all', 35)])],
    ['Fable unknown (percent null)', fableAt(null)],
    ['Fable 100% used', fableAt(100)],
    ['Fable over 100%', fableAt(130)],
    ['no weekly (all models) bar', claude([lim('weekly_scoped', 20, 'Fable 5.2')])],
    ['stale: failed read whose Fable window already reset', claude([lim('weekly_all', 35, null, SOON),
      lim('weekly_scoped', 20, 'Fable 5.2', PAST)], { available: false, error: 'HTTP 429' })],
  ]
  for (const [name, u] of cases) {
    const view = await bars(t, u)
    assert.equal(pips(view.el).length, 0, `${name}: no pip`)
    await view.unmount()
  }
})

test('§3 only a Fable scope makes a pip', async (t) => {
  const others: [string, AccountUsage][] = [
    ['Gemini model group', { ...claude([lim('weekly_all', 30), lim('weekly_scoped', 20, 'Gemini 4 Argon')]), provider: 'Google' }],
    ['Codex named limit', { ...claude([lim('weekly_all', 30), lim('weekly_scoped', 20, 'GPT-5 Codex Spark')]), provider: 'Codex' }],
    ['a Claude model scope that is not Fable', claude([lim('weekly_all', 30), lim('weekly_scoped', 20, 'Opus')])],
  ]
  for (const [name, u] of others) {
    const view = await bars(t, u)
    assert.equal(pips(view.el).length, 0, `${name}: no pip`)
    await view.unmount()
  }
})

test('§4 a new Fable reading moves the pip', async (t) => {
  let set: (u: AccountUsage) => void = () => {}
  const { useState } = await import('react')
  function Live() { const [u, s] = useState(fableAt(20)); set = s; return <UsageBars u={u} /> }
  const view = await mountView(<Live />, el => el)
  t.after(() => view.unmount())
  assert.equal(pips(view.el)[0]?.style.left, '60%')
  await inAct(() => { set(fableAt(60)) })
  assert.equal(pips(view.el)[0]?.style.left, '80%', 'the pip follows the reading')
  await inAct(() => { set(fableAt(100)) })
  assert.equal(pips(view.el).length, 0, 'and leaves when Fable is used up')
})

test('§5 the stylesheet draws the pip neutral', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const rule = /\.usage-pip::after\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, 'a .usage-pip::after rule exists')
  assert.match(rule![1]!, /background:\s*var\(--ink-strong\)/, 'neutral ink')
  assert.doesNotMatch(rule![1]!, /--bad|--tier-fable|--warn/, 'never a warning or limit colour')
  assert.match(css, /\.usage-track\s*\{[^}]*position:\s*relative/, 'the track positions it')
})

test('§6 hovering shows the existing caption with the pip’s percentage after "this point"', async (t) => {
  // USER 2026-11-10 23:51:33Z ma05bce0c2983 "keep the existing caption just
  // add the percentage to the phrase"
  const caption = (pct: string) =>
    `Past this point (${pct}), the rest of this week's Fable allowance can't be used up before the weekly limit`
  for (const [f, pct] of [[52, '76%'], [53, '77%'], [0, '50%']] as const) {
    const view = await bars(t, fableAt(f))
    const pip = pips(view.el)[0]
    assert.ok(pip, `POSITIVE CONTROL: f=${f}% renders a pip`)
    assert.equal(pip!.getAttribute('title'), caption(pct), `f=${f}%: the caption with ${pct}`)
    assert.equal(pip!.getAttribute('aria-label'), caption(pct), 'assistive tech hears the same text')
    await view.unmount()
  }
  // no value: the original caption, unchanged and without any number
  const titleOf = (fablepip as unknown as { fablePipTitle?: (at: number | null) => string }).fablePipTitle
  assert.equal(typeof titleOf, 'function', 'fablePipTitle is exported')
  for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(titleOf!(bad),
      "Past this point, the rest of this week's Fable allowance can't be used up before the weekly limit",
      `${String(bad)}: the original caption`)
  }
})

test('§7 past the pip, the Fable bar’s unreachable end is red with its tooltip', async (t) => {
  // USER 2026-11-11 11:04:55Z m49c4c03b6da4; reachable Fable ceiling
  // c = f + 2(1 - w); red from max(f, c) to 100% only when w > pip
  const reds = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.usage-unreachable')]
  const tip = (pct: string) => `Can't be reached this week (past ${pct}): the weekly limit comes first`
  for (const [w, f, from, pct] of [[95, 83, 93, '93%'], [80, 52, 92, '92%'], [100, 53, 53, '53%'],
    [110, 53, 53, '53%'], [99.5, 0, 1, '1%']] as const) {
    const view = await bars(t, fableAt(f, w))
    const all = reds(view.el)
    assert.equal(all.length, 1, `w=${w}% f=${f}%: one red segment (got ${all.length})`)
    const fable = rowOf(view.el, /fable/i)
    assert.ok(fable?.querySelector('.usage-track')?.contains(all[0]!), 'on the Fable bar’s track')
    assert.equal(parseFloat(all[0]!.style.left), from, `starts at ${from}%`)
    assert.equal(parseFloat(all[0]!.style.width), 100 - from, 'runs to 100%')
    assert.equal(all[0]!.getAttribute('title'), tip(pct), 'its tooltip')
    assert.equal(all[0]!.getAttribute('aria-label'), tip(pct), 'assistive tech hears the same text')
    const fill = fable!.querySelector<HTMLElement>('.usage-fill')
    assert.equal(fill?.style.width, `${f}%`, 'the used fill is unchanged')
    await view.unmount()
  }
  const PAST = new Date(Date.now() - 60000).toISOString()
  const none: [string, AccountUsage][] = [
    ['before the pip', fableAt(52, 70)],
    ['exactly at the pip (w = (1 + f) / 2)', fableAt(52, 76)],
    ['Fable unknown', fableAt(null, 95)],
    ['Fable 100% used', fableAt(100, 100)],
    ['weekly unknown', claude([lim('weekly_all', null, null, SOON), lim('weekly_scoped', 50, 'Fable 5.2', SOON)])],
    ['stale: failed read whose Fable window already reset', claude([lim('weekly_all', 95, null, SOON),
      lim('weekly_scoped', 20, 'Fable 5.2', PAST)], { available: false, error: 'HTTP 429' })],
    ['not Fable', claude([lim('weekly_all', 95), lim('weekly_scoped', 20, 'Opus')])],
  ]
  for (const [name, u] of none) {
    const view = await bars(t, u)
    assert.equal(reds(view.el).length, 0, `${name}: no red segment`)
    await view.unmount()
  }
  // live: a new reading moves it
  let set: (u: AccountUsage) => void = () => {}
  const { useState } = await import('react')
  function Live() { const [u, s] = useState(fableAt(52, 70)); set = s; return <UsageBars u={u} /> }
  const live = await mountView(<Live />, el => el)
  t.after(() => live.unmount())
  assert.equal(reds(live.el).length, 0)
  await inAct(() => { set(fableAt(83, 95)) })
  assert.equal(parseFloat(reds(live.el)[0]?.style.left ?? ''), 93, 'appears once weekly passes the pip')
  // the danger colour the meters already use, no new colour
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const rule = /\.usage-unreachable\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, 'a .usage-unreachable rule exists')
  assert.match(rule![1]!, /background:\s*var\(--bad\)/, 'the meters’ limit colour')
  // no value: the sentence without the parenthesis
  const titleOf = (fablepip as unknown as { fableUnreachableTitle?: (from: number | null) => string }).fableUnreachableTitle
  assert.equal(typeof titleOf, 'function', 'fableUnreachableTitle is exported')
  assert.equal(titleOf!(null), "Can't be reached this week: the weekly limit comes first")
})
