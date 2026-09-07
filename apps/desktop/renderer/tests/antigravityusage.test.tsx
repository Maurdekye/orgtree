// antigravityusage.test.tsx — the shared header usage modal shows the
// Antigravity standing too: the last wall a turn hit (100%, with the reset
// the CLI named) or, with no wall on record, the settled "no readout" note —
// never a blank section and never a spurious error. And a walled Google
// account drives the header glow like any other lane.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AntigravityEstimateNote, UsageModal, usagePeak } from '../src/App'
import type {
  AccountUsage, AntigravityEstimate, UsageAllPayload, UsagePeek,
} from '../src/types'

const CLAUDE: UsageAllPayload = { accounts: [{
  account: 'primary', label: 'claude@example.test', available: true,
  plan: 'max', limits: [{ kind: 'session', group: 'session', percent: 17,
    severity: 'normal', resets_at: null, is_active: false, model: null }],
}] }

const CODEX: AccountUsage = {
  account: 'codex', provider: 'Codex', label: 'codex@example.test',
  available: true, limits: [
    { kind: 'weekly_all', group: 'codex', percent: 9, severity: 'normal',
      resets_at: null, is_active: false, model: null, label: '7 days' },
  ],
}

// the measured wall (2026-09-03): one 100% window, reset ~6d21h out
const WALLED: AccountUsage = {
  account: 'antigravity', provider: 'Antigravity', label: 'agy@example.test',
  available: true, limits: [
    { kind: 'provider_window', group: 'antigravity', percent: 100,
      severity: 'critical', resets_at: '2026-09-09T20:58:00Z',
      is_active: true, model: null, label: 'individual quota' },
  ],
}

// nothing observed: the settled note rides `unsupported`, not an error
const QUIET: AccountUsage = {
  account: 'antigravity', provider: 'Antigravity', label: 'agy@example.test',
  available: false, unsupported: true,
  error: 'Antigravity publishes no usage readout; a quota wall appears here '
    + 'when a turn hits one, with its reset',
}

// ONE measured interval, every receipt in it countable, and its two ends
// recorded and agreeing. `comparability` is 'unknown' on every answer this
// lane can produce; `limit_continuity` is about THIS interval's own two ends.
const MEASURED: AntigravityEstimate = {
  available: true, samples: 1, confidence: 'experimental',
  comparability: 'unknown', limit: 'individual quota', tier: 'flash',
  limit_continuity: 'consistent',
  limit_continuity_note: 'the account, tier and named metric recorded at the '
    + 'reset that opened this interval match those on the wall that closed it',
  estimate: { tokens: 267_127_077 },
  other_intervals: { reset_to_wall: 0, demonstrably_different: 0 },
  comparability_note: 'the CLI states the time REMAINING until a reset, not '
    + 'the window length',
  basis: 'tokens ORGTREE spent between an observed reset and the wall that '
    + 'followed it; the provider publishes no usage readout, so this is an '
    + 'inference from observed walls, not a reported limit',
  warning: 'a LOWER BOUND: the same account can be spent in the Antigravity '
    + 'IDE, which orgtree cannot observe, so any remaining-budget reading '
    + 'from this is optimistic',
  coverage: { windows_with_unobserved_gaps: 0, windows_partly_measured: 0,
              receipts: 33, unsummable_receipts: 0 },
}

const stubFetch = (agy: AccountUsage) => {
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = /\/accounts\/usage$/.test(path) ? CLAUDE
      : /\/codex\/usage$/.test(path) ? CODEX
      : /\/antigravity\/usage$/.test(path) ? agy : null
    if (!body) return Promise.reject(new Error(`unexpected fetch: ${path}`))
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body) })
  }
  return () => { delete g.fetch }
}

test('usage modal renders the Antigravity wall beside Claude and Codex', async () => {
  const restore = stubFetch(WALLED)
  try {
    const view = await mountView(<UsageModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const text = view.el.textContent ?? ''
    assert.match(text, /Antigravity · agy@example\.test/)
    assert.match(text, /individual quota/)
    assert.match(text, /100%/)
    // one Claude bar, one Codex bar, one Antigravity bar
    assert.equal(view.el.querySelectorAll('.usage-track').length, 3)
    assert.ok(!view.el.querySelector('.acct-unsupported'),
      'a walled account shows the bar, not the note')
  } finally {
    restore()
  }
})

test('with no wall on record the section carries the settled note', async () => {
  const restore = stubFetch(QUIET)
  try {
    const view = await mountView(<UsageModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const text = view.el.textContent ?? ''
    assert.match(text, /Antigravity · agy@example\.test/)
    assert.match(text, /publishes no usage readout/)
    assert.ok(view.el.querySelector('.acct-unsupported'),
      'the note wears the settled styling, not the error one')
    assert.equal(view.el.querySelectorAll('.usage-track').length, 2)
  } finally {
    restore()
  }
})

test('with no measurable interval the estimate prints the reason, not a number',
  async () => {
    const none: AntigravityEstimate = {
      available: false, samples: 0, estimate: null,
      reason: 'measuring needs an interval running from an OBSERVED RESET to '
        + 'a later wall, and the record holds none',
    }
    const view = await mountView(
      <AntigravityEstimateNote est={none} />, (el) => el)
    await inAct(async () => { await flush(2) })
    const text = view.el.textContent ?? ''
    assert.match(text, /no usage estimate yet/)
    assert.match(text, /an interval running from an OBSERVED RESET/)
    assert.ok(!/\d[\d.,]*[kMB]? tokens/.test(text),
      `a refusal must carry NO number: ${text}`)
    // CONTROL: the same component DOES print one when an interval supports it
    const ok = await mountView(
      <AntigravityEstimateNote est={MEASURED} />, (el) => el)
    await inAct(async () => { await flush(2) })
    assert.match(ok.el.textContent ?? '', /267\.1M tokens/)
  })

test('an estimate never renders as a bar and always carries its two caveats',
  async () => {
    const view = await mountView(
      <AntigravityEstimateNote est={MEASURED} />, (el) => el)
    await inAct(async () => { await flush(2) })
    const text = view.el.textContent ?? ''
    // a percentage would imply a denominator, and the ceiling is unreadable
    assert.equal(view.el.querySelectorAll('.usage-track').length, 0)
    assert.ok(!/%/.test(text), `no percentage: ${text}`)
    assert.match(text,
      /between an observed individual quota reset and the wall that followed/)
    assert.match(text, /experimental/)
    assert.match(text, /not a reported limit/)
    assert.match(text, /LOWER bound/)
    assert.match(text, /comparability to any other interval is UNKNOWN/)
  })

test('other recorded intervals are counted, never merged into a range',
  async () => {
    const withOthers: AntigravityEstimate = {
      ...MEASURED,
      other_intervals: { reset_to_wall: 2, demonstrably_different: 1 },
    }
    const view = await mountView(
      <AntigravityEstimateNote est={withOthers} />, (el) => el)
    await inAct(async () => { await flush(2) })
    const text = view.el.textContent ?? ''
    assert.match(text,
      /2 other recorded intervals are counted but never combined/)
    // exactly ONE token figure: a range would assert the intervals agree
    assert.equal((text.match(/tokens/g) ?? []).length, 1)
    assert.ok(!/across windows/.test(text), `no range: ${text}`)
    // CONTROL: with no others, the clause is absent rather than showing zero
    const alone = await mountView(
      <AntigravityEstimateNote est={MEASURED} />, (el) => el)
    await inAct(async () => { await flush(2) })
    assert.ok(!/other recorded interval/.test(alone.el.textContent ?? ''),
      'a lone observation must not print an empty "0 others" clause')
  })

test('an interval whose two ends are not known to be one limit says so',
  async () => {
    // the backend refuses a PROVEN mismatch outright, so a surface only ever
    // sees 'consistent' or 'unknown' - and an unknown must not read as a
    // measurement of one limit's window
    const unsure: AntigravityEstimate = {
      ...MEASURED, limit_continuity: 'unknown',
      limit_continuity_note: 'whether ONE limit spans this interval is '
        + 'unknown: something was not recorded at one of its two ends',
    }
    const view = await mountView(
      <AntigravityEstimateNote est={unsure} />, (el) => el)
    await inAct(async () => { await flush(2) })
    const text = view.el.textContent ?? ''
    assert.match(text, /one limit is not even known to span this interval/)
    // the number is still shown: unknown is not a reason to bin the evidence
    assert.match(text, /267\.1M tokens/)
    // CONTROL: the consistent case does NOT carry the clause, so the clause
    // is reporting the field rather than decorating every answer
    const sure = await mountView(
      <AntigravityEstimateNote est={MEASURED} />, (el) => el)
    await inAct(async () => { await flush(2) })
    assert.ok(!/not even known to span/.test(sure.el.textContent ?? ''),
      'a consistent boundary must not print the unknown-continuity clause')
  })

test('receipts that could not be counted are said out loud, and cap the '
  + 'confidence', async () => {
    const partial: AntigravityEstimate = {
      ...MEASURED, confidence: 'low',
      coverage: { ...MEASURED.coverage, windows_partly_measured: 1,
                  unsummable_receipts: 32 },
    }
    const view = await mountView(
      <AntigravityEstimateNote est={partial} />, (el) => el)
    await inAct(async () => { await flush(2) })
    const text = view.el.textContent ?? ''
    assert.match(text, /32 older receipts could not be counted/)
    assert.match(text, /low/)
    // CONTROL: the fully measured one says nothing of the kind
    const clean = await mountView(
      <AntigravityEstimateNote est={MEASURED} />, (el) => el)
    await inAct(async () => { await flush(2) })
    assert.ok(!/could not be counted/.test(clean.el.textContent ?? ''),
      'a fully measured window must not carry the shortfall wording')
  })

test('the modal shows the estimate under the Antigravity bars', async () => {
  const restore = stubFetch({ ...WALLED, usage_estimate: MEASURED })
  try {
    const view = await mountView(<UsageModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const text = view.el.textContent ?? ''
    assert.match(text, /267\.1M tokens/)
    // it is TEXT under the section, not a fourth bar
    assert.equal(view.el.querySelectorAll('.usage-track').length, 3)
    const note = view.el.querySelector('[data-testid="agy-estimate"]')
    assert.ok(note, 'the estimate is rendered')
    assert.ok(note?.closest('.usage-acct')?.textContent?.includes('Antigravity'),
      'and it sits inside the Antigravity section, not a stray div')
  } finally {
    restore()
  }
})

test('a walled Google account drives the shared near-limit glow', () => {
  const claude: UsagePeek = { available: true, limits: [] }
  const codex: UsagePeek = { available: true, provider: 'Codex', limits: [] }
  const agy: UsagePeek = { available: true, provider: 'Antigravity', limits: [
    { kind: 'provider_window', group: 'antigravity', percent: 100,
      severity: 'critical', resets_at: null, is_active: true, model: null,
      label: 'individual quota' },
  ] }
  const alert = usagePeak(claude, codex, agy)
  assert.equal(alert?.sev, 'crit')
  assert.match(alert?.title ?? '', /individual quota at 100%/)
  assert.match(alert?.title ?? '', /Antigravity usage$/)
  // and an unavailable peek (no wall) contributes nothing
  assert.equal(usagePeak(claude, codex, { available: false, provider: 'Antigravity' }), null)
})
