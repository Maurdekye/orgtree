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

async function cacheTitle(zone: string,
  overrides: Partial<CacheForecast> = {}): Promise<string> {
  setDisplayZone(zone)
  const view = await mountView(
    <CacheForecastMark forecast={{ ...forecast, ...overrides }} />, (el) => el)
  try {
    return view.el.querySelector<HTMLElement>('.cache-forecast')?.getAttribute('aria-label') ?? ''
  } finally { await view.unmount() }
}

/** the fixture's `expires_at` is a fixed 2026-09-05 instant, so on any machine
 *  running this after that date the badge is EXPIRED and never reaches the
 *  ready branch. The ready branch is the one that still derives text from
 *  `last_receipt_at`, so it is the one that could still leak a zone — this
 *  keeps it live without touching the fixed receipt stamp it reads. */
const LIVE = { expires_at: new Date(Date.now() + 3600_000).toISOString() }

/* ⚠ THE CACHE CHIP NO LONGER PRINTS AN INSTANT AT ALL (user ruling
   2026-09-17). The two tests below used to assert that its "last
   authoritative inference receipt" and "expires at" lines rendered in the
   display zone rather than as raw `Z`. The tooltip cut removed both lines —
   and the eight others around them — leaving one short phrase and, when the
   cache is ready, an ELAPSED DURATION ("receipt observed 4m ago"), which is
   not an instant in any zone.

   That satisfies the no-visible-UTC rule by having nothing to format, which
   is a weaker proof than the one these tests used to give. So they are
   REPLACED rather than deleted, by the stronger claim the new tooltip can
   actually support: no instant of any kind, in any zone, reachable through
   this surface. If an instant is ever put back, that is the moment the zone
   question returns, and the first assertion here is what will say so. */
test('cache chip tooltip shows no instant at all — nothing left to leak as UTC', async () => {
  // BOTH BRANCHES, because only one of them reads a stamp. The READY branch
  // turns `last_receipt_at` into an elapsed duration; the expired branch
  // reads no stamp at all. A leak could only come from the first, so testing
  // only the fixture's (long-expired) instant would prove nothing.
  for (const [label, over] of [['ready', LIVE], ['expired', {}]] as const) {
    const local = await cacheTitle('Asia/Jerusalem', over)
    assert.doesNotMatch(local, RAW_Z, `${label}: raw UTC instant survives:\n${local}`)
    // no FORMATTED instant either — not a date, not a zone
    assert.doesNotMatch(local, /\d{4}-\d\d-\d\d/, `${label}: a date reappeared:\n${local}`)
    assert.doesNotMatch(local, /GMT|UTC|[A-Z][a-z]+\/[A-Z]/, `${label}: a zone reappeared:\n${local}`)
    // ⚠ A WALL-CLOCK CHECK HAS TO EXCLUDE THE COUNTDOWN. "expires in 59:58"
    // is an h:mm:ss DURATION, user-specified (2026-09-02) and zone-free; it
    // is the one `\d\d:\d\d` in this string that is not a time of day, so it
    // is removed before the check rather than the check being dropped.
    const withoutCountdown = local.replace(/, expires in [\d:]+$/, '')
    assert.doesNotMatch(withoutCountdown, /\d\d:\d\d/,
      `${label}: a wall-clock time reappeared:\n${local}`)
    // ⚠ THE CONTROL, INVERTED. It used to require the two zones to read
    // DIFFERENTLY, because text that read the same in both was the signature
    // of an unformatted UTC stamp. With no instant left, reading the SAME in
    // both zones is the correct result — and this is the assertion that fails
    // the day an instant is reintroduced without going through `timefmt`.
    const utc = await cacheTitle('UTC', over)
    assert.equal(utc.replace(/, expires in [\d:]+$/, ''), withoutCountdown,
      `${label}: the tooltip is zone-sensitive again — it carries an instant`)
  }
  // …and "how recently" is still answered, as an elapsed DURATION
  assert.match(await cacheTitle('Asia/Jerusalem', LIVE), /receipt observed \d+[smhd] ago/)
})

test('cache chip tooltip needs no words for missing instants — it names none', async () => {
  setDisplayZone('Asia/Jerusalem')
  const view = await mountView(<CacheForecastMark
    forecast={{ ...forecast, last_receipt_at: null, expires_at: null } as unknown as CacheForecast} />, (el) => el)
  try {
    const title = view.el.querySelector<HTMLElement>('.cache-forecast')?.getAttribute('aria-label') ?? ''
    // the "none" / "not authoritatively known" placeholders existed because
    // the tooltip had two instant SLOTS to fill. There are no slots now, so a
    // ready forecast with no receipt stamp says the short phrase and stops —
    // it must not print an empty observation clause or the word "none"
    assert.equal(title, 'cache ready')
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
