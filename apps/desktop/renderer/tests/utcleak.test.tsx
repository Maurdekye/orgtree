// utcleak.test.tsx — the LAST raw UTC instants a user could see, found by
// looking at the deployed build (2026-09-05) rather than by any suite: the
// desk's cache chip tooltip printed `forecast.last_receipt_at` / `expires_at`
// verbatim, and the primed-restart chip did the same with its ISO stamps.
// Both predate timefmt.ts, so the local-time sweep (857ff9d) never saw them.
//
// The rule under test (user ruling 2026-09-04): no visible UTC timestamps.
// A positive control runs each surface in TWO zones — if the text were UTC it
// would read the same in both, and that is exactly what the old code did.
//
// Run:  cd frontend && node tests/run.mjs utcleak

import './harness'
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CacheForecastMark } from '../src/canvas/desk'
import { primedRestartChip } from '../src/canvas/shared'
import { setDisplayZone } from '../src/timefmt'
import type { CacheForecast } from '../src/types'

const RAW_Z = /\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?Z/

const forecast: CacheForecast = {
  generation: 'g', state: 'compatible_observed', readiness: 'ready', readiness_cause: 'receipt_valid',
  reason: 'observed', source: 'provider receipts', lane: 'subscription',
  last_receipt_at: '2026-09-05T06:45:34.400844Z', ttl_seconds: 3600,
  expires_at: '2026-09-05T07:45:34.400844Z',
  changed_inputs: [], precompact_action: 'not_applicable', precompact_reason: '',
} as CacheForecast

test.afterEach(() => { setDisplayZone(null) })

async function cacheTitle(zone: string): Promise<string> {
  setDisplayZone(zone)
  const view = await mountView(<CacheForecastMark forecast={forecast} />, (el) => el)
  try {
    return view.el.querySelector<HTMLElement>('.cache-forecast')?.getAttribute('aria-label') ?? ''
  } finally { await view.unmount() }
}

test('cache chip tooltip renders its two instants in the display zone, never as raw Z', async () => {
  const local = await cacheTitle('Asia/Jerusalem')
  assert.doesNotMatch(local, RAW_Z, `raw UTC instant survives in the tooltip:\n${local}`)
  assert.match(local, /last authoritative inference receipt: 2026-09-05 09:45:34 GMT\+3/)
  assert.match(local, /expires at: 2026-09-05 10:45:34 GMT\+3/)
  // CONTROL: a UTC display zone must read differently — a formatter that
  // ignored the zone would print the same text twice and this would not catch it
  const utc = await cacheTitle('UTC')
  assert.match(utc, /last authoritative inference receipt: 2026-09-05 06:45:34 UTC/)
  assert.notEqual(utc, local)
})

test('cache chip tooltip keeps its "none" / "not authoritatively known" words for missing instants', async () => {
  setDisplayZone('Asia/Jerusalem')
  const view = await mountView(<CacheForecastMark
    forecast={{ ...forecast, last_receipt_at: null, expires_at: null } as unknown as CacheForecast} />, (el) => el)
  try {
    const title = view.el.querySelector<HTMLElement>('.cache-forecast')?.getAttribute('aria-label') ?? ''
    assert.match(title, /last authoritative inference receipt: none/)
    assert.match(title, /expires at: not authoritatively known/)
  } finally { await view.unmount() }
})

test('primed-restart chip tooltips render armed/triggered instants locally', () => {
  const pr = { target: 'org' as const, by_org: 'orgtree', by_node: 'coordinator',
    at: '2026-09-05T06:00:00Z', at_ts: 0, state: 'armed' as const, triggered_at: '2026-09-05T06:30:00Z' }
  setDisplayZone('Asia/Jerusalem')
  const armed = primedRestartChip(pr)!.title
  const executing = primedRestartChip({ ...pr, state: 'executing' })!.title
  assert.doesNotMatch(armed, RAW_Z, armed)
  assert.doesNotMatch(executing, RAW_Z, executing)
  assert.match(armed, /at 2026-09-05 09:00:00 GMT\+3/)
  assert.match(executing, /triggered at 2026-09-05 09:30:00 GMT\+3/)
  setDisplayZone('UTC')
  assert.match(primedRestartChip(pr)!.title, /at 2026-09-05 06:00:00 UTC/, 'control: UTC zone reads differently')
  // a record with no stamp still says so instead of printing "undefined"
  assert.match(primedRestartChip({ ...pr, at: undefined as unknown as string })!.title, /at \?/)
})
