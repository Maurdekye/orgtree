import './harness'
import { mountView } from './harness'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ReactElement } from 'react'
import { CacheForecastMark, CacheForecastWarning } from '../src/canvas/desk'
import type { CacheForecast, CacheForecastState } from '../src/types'

declare const __SRC_DIR__: string

const forecast = (
  state: CacheForecastState,
  action: CacheForecast['precompact_action'] = 'not_applicable',
  overrides: Partial<CacheForecast> = {},
): CacheForecast => ({
  generation: 'opaque-generation', state,
  // D-226: readiness is what the badge renders, and the backend derives it
  // from the same branch that produced `state`. The fixture mirrors that
  // pairing so these rows stay realistic; `uncertain` maps to the enumerated
  // capability diagnostic rather than to a bare unknown, because after D-226
  // there is no such thing as an unexplained grey.
  ...(state === 'compatible_observed'
    ? { readiness: 'ready' as const, readiness_cause: 'receipt_valid' }
    : state === 'uncertain'
      ? { readiness: 'diagnostic' as const,
          readiness_cause: 'unsupported_capability' }
      : { readiness: 'not_ready' as const,
          readiness_cause: state === 'expired_known_entry'
            ? 'receipt_expired' : 'prefix_changed' }),
  reason: state === 'known_incompatible' ? 'three identity components changed' : 'observed',
  source: 'provider receipts', lane: 'subscription',
  last_receipt_at: '2026-09-01T10:00:00Z', ttl_seconds: 3600,
  // ⚠ RELATIVE, not a fixed instant. The green badge now counts down to this
  // value and stops being green once it passes (user spec 2026-09-02), so a
  // hard-coded stamp made every `compatible_observed` fixture render as an
  // EXPIRED entry the moment that date went by — the state mapping below
  // started failing on its own, with nothing changed. A fixture that decays
  // into a different test than the one that was written is worse than no
  // fixture. Countdown behaviour itself is pinned against a frozen clock in
  // `cachecountdown.test.tsx`; this one only needs the entry to be live.
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  changed_inputs: state === 'known_incompatible'
    ? ['system prompt', 'callable tools', 'credential lane'] : [],
  precompact_action: action,
  precompact_reason: action === 'will_compact'
    ? 'context is above the configured minimum'
    : action === 'miss_expected' ? 'automatic policy is off' : '',
  ...overrides,
})

test('cache badge has exactly the selected green/red/grey state mapping', async () => {
  const view = await mountView(<>
    <CacheForecastMark forecast={forecast('compatible_observed')} />
    <CacheForecastMark forecast={forecast('expired_known_entry')} />
    <CacheForecastMark forecast={forecast('known_incompatible')} />
    <CacheForecastMark forecast={forecast('uncertain')} />
  </>, (el) => el)
  try {
    const marks = [...view.el.querySelectorAll<HTMLElement>('.cache-forecast')]
    assert.deepEqual(marks.map((m) => [...m.classList][1]),
      ['compatible', 'cold', 'cold', 'uncertain'])
    // ⚠ The green badge no longer carries a ✓ when it has a live expiry to
    // count down to — the countdown REPLACES it (user spec 2026-09-02), and
    // showing both was explicitly ruled out. The remaining three glyphs are
    // unchanged. Asserted as a shape, not a string: the exact figure depends
    // on how long this file took to get here, and pinning it would make the
    // test fail on a slow machine. Countdown behaviour proper is pinned
    // against a frozen clock in `cachecountdown.test.tsx`.
    assert.match(marks[0]?.textContent?.trim() ?? '', /^cache \d+:\d\d(:\d\d)?$/)
    assert.deepEqual(marks.slice(1).map((m) => m.textContent?.trim()),
      ['cache ×', 'cache ×', 'cache ?'])
    const incompatible = marks[2]?.getAttribute('aria-label') ?? ''
    for (const item of ['system prompt', 'callable tools', 'credential lane']) {
      assert.match(incompatible, new RegExp(item), `tooltip omitted ${item}`)
    }
    assert.match(incompatible, /60 minutes \(subscription authentication\)/)
    assert.match(incompatible, /last authoritative inference receipt: 2026/)
    // D-226: the grey slot no longer says "unknown" — it names the fault that
    // stopped a verdict being formed, and carries a machine-readable cause so
    // a screenshot of the tooltip is enough to triage it.
    const grey = marks[3]?.getAttribute('aria-label') ?? ''
    assert.doesNotMatch(grey, /compatibility: unknown/)
    assert.match(grey, /no verdict — unsupported capability/)
    assert.match(grey, /readiness: diagnostic \(unsupported_capability\)/)
  } finally { await view.unmount() }
})

test('Codex subscription tooltip names the fixed estimate without promising a hit', async () => {
  const row = {
    ...forecast('compatible_observed'),
    ttl_seconds: 1800,
    source: 'codex_subscription_fixed_estimate',
    lane: 'subscription',
  }
  const view = await mountView(<CacheForecastMark forecast={row} />, (el) => el)
  try {
    const title = view.el.querySelector<HTMLElement>('.cache-forecast')
      ?.getAttribute('aria-label') ?? ''
    assert.match(title, /30 minutes \(Codex subscription estimate\)/)
    assert.match(title, /provider hit not guaranteed/)
  } finally { await view.unmount() }
})

test('a supported lane with no completed turn renders NO cache flag', async () => {
  // A cache flag is a statement about an existing cache. When there has been
  // no completed turn there is no cache at all, so neither "ready" nor
  // "not ready" is true. The UI renders NO flag at all.
  const view = await mountView(<>
    <CacheForecastMark forecast={forecast('uncertain', 'not_applicable', {
      source: 'no_completed_fingerprint', lane: 'subscription',
      readiness: 'none', readiness_cause: 'no_completed_fingerprint',
      readiness_detail: 'No completed turn has been observed for this agent '
        + 'yet, so there is nothing to establish cache readiness from.',
    })} />
    <CacheForecastMark forecast={forecast('uncertain', 'not_applicable', {
      source: 'no_completed_fingerprint', lane: 'api_key', ttl_seconds: 300,
      readiness: 'none', readiness_cause: 'no_completed_fingerprint',
      readiness_detail: 'No completed turn has been observed for this agent '
        + 'yet, so there is nothing to establish cache readiness from.',
    })} />
  </>, (el) => el)
  try {
    const marks = [...view.el.querySelectorAll<HTMLElement>('.cache-forecast')]
    assert.equal(marks.length, 0, 'no cache flag rendered when there is no completed turn')
  } finally { await view.unmount() }
})

test('D-226: every grey is a NAMED diagnostic; ordinary uncertainty is red', async () => {
  // The old contract lumped all four of these into one "unknown" grey. The
  // user ruled that out: a provider that cannot report and a session that
  // simply has no receipt yet are different facts and must not share a colour.
  const view = await mountView(<>
    {/* a real capability gap — the only legitimate grey here */}
    <CacheForecastMark forecast={forecast('uncertain', 'not_applicable', {
      source: 'capability_unsupported', lane: 'provider_unsupported',
      readiness: 'diagnostic', readiness_cause: 'unsupported_capability',
      readiness_detail: 'Provider google on the provider_unsupported lane '
        + 'reports no cache TTL.',
    })} />
    {/* lane not observed YET: red, and it resolves itself */}
    <CacheForecastMark forecast={forecast('uncertain', 'not_applicable', {
      source: 'ttl_unobserved', lane: 'unobserved',
      readiness: 'not_ready', readiness_cause: 'lane_unobserved',
    })} />
    {/* no receipt yet on a supported lane: red, not grey */}
    <CacheForecastMark forecast={forecast('uncertain', 'not_applicable', {
      source: 'no_positive_receipt', lane: 'subscription',
      readiness: 'not_ready', readiness_cause: 'no_positive_receipt',
    })} />
    {/* a backend clock fault: grey, because no opinion can be formed */}
    <CacheForecastMark forecast={forecast('uncertain', 'not_applicable', {
      source: 'clock_skew', lane: 'subscription',
      readiness: 'diagnostic', readiness_cause: 'clock_anomaly',
      readiness_detail: 'Receipt stamped ahead of the backend clock by 5.0s.',
    })} />
  </>, (el) => el)
  try {
    const marks = [...view.el.querySelectorAll<HTMLElement>('.cache-forecast')]
    assert.deepEqual(marks.map((m) => [...m.classList][1]),
      ['uncertain', 'cold', 'cold', 'uncertain'])
    assert.deepEqual(marks.map((m) => m.textContent?.trim()),
      ['cache ?', 'cache ×', 'cache ×', 'cache ?'])
    // ⚠ NO BARE "unknown" ANYWHERE. Every grey names its cause, and the two
    // reds say they are unestablished rather than claiming a proven miss.
    for (const mark of marks) {
      const title = mark.getAttribute('aria-label') ?? ''
      assert.doesNotMatch(title, /compatibility: unknown/)
      assert.match(title, /readiness: (diagnostic|not_ready) \([a-z_]+\)/)
    }
    assert.match(marks[0]?.getAttribute('aria-label') ?? '',
      /unsupported_capability/)
    assert.match(marks[3]?.getAttribute('aria-label') ?? '', /clock_anomaly/)
  } finally { await view.unmount() }
})

test('D-226: the badge FAILS CLOSED — no readiness is grey, never green', async () => {
  // ⚠ THE MOST EXPENSIVE LIE THIS COMPONENT COULD TELL is a green badge on a
  // payload it did not understand: the user would withhold a compaction, or
  // send a large turn, on a promise nothing made. A field that arrives
  // misspelled or a verdict nothing can read lands on the named
  // internal_error diagnostic — grey, explained, and greppable. A row with NO
  // triple and an unrecognised source (a hand-built object) is re-derived as
  // legacy residue: RED, never green — see the pre-D-226 test below.
  const noReadiness = { ...forecast('compatible_observed') }
  delete (noReadiness as Partial<CacheForecast>).readiness
  delete (noReadiness as Partial<CacheForecast>).readiness_cause
  const cases: Array<[string, CacheForecast]> = [
    ['readiness absent entirely, source unrecognised', noReadiness as CacheForecast],
    ['readiness is an unrecognised value', {
      ...forecast('compatible_observed'),
      readiness: 'probably-fine' as unknown as CacheForecast['readiness'],
    }],
    // Even a state that WOULD have been green is overruled by its readiness:
    // readiness is the single authority for what the badge renders.
    ['state says green but readiness says otherwise', {
      ...forecast('compatible_observed'),
      readiness: 'not_ready', readiness_cause: 'prefix_changed',
    }],
  ]
  for (const [label, row] of cases) {
    const view = await mountView(<CacheForecastMark forecast={row} />, (el) => el)
    try {
      const mark = view.el.querySelector<HTMLElement>('.cache-forecast')
      assert.notEqual([...(mark?.classList ?? [])][1], 'compatible', label)
      // and never a live countdown, which would imply a trusted expiry
      assert.doesNotMatch(mark?.textContent ?? '', /\d+:\d\d/, label)
    } finally { await view.unmount() }
  }
})

/** A row exactly as a pre-D-226 backend sends it: state/source/lane and no
 * readiness triple at all. */
const legacy = (
  state: CacheForecastState, overrides: Partial<CacheForecast> = {},
): CacheForecast => {
  const row = { ...forecast(state, 'not_applicable', overrides) }
  delete (row as Partial<CacheForecast>).readiness
  delete (row as Partial<CacheForecast>).readiness_cause
  delete (row as Partial<CacheForecast>).readiness_detail
  return row
}

test('a pre-D-226 payload (no triple) re-derives its verdict from state/source — never internal_error', async () => {
  // ⚠ THIS IS WHAT A BACKEND OLDER THAN THE UI SENDS. A deployed build that
  // predates D-226 emits no readiness triple for any node; the first version
  // of this badge answered that with `internal_error` on EVERY node — a
  // brand-new agent with no first turn, a known-cold seat, an unexpired
  // receipt — all grey, all "internal error", none of them a fault. INV-002
  // is explicit that a row predating the schema migration must not render
  // grey, so the badge now applies `legacy_readiness`'s own table and says so.
  const past = new Date(Date.now() - 60_000).toISOString()
  // A pre-D-226 row with no completed turn re-derives readiness 'none' and renders NO flag
  const noFirstTurn = legacy('uncertain', {
    source: 'no_completed_fingerprint', lane: 'subscription' })
  const nftView = await mountView(<CacheForecastMark forecast={noFirstTurn} />, (el) => el)
  try {
    const mark = nftView.el.querySelector<HTMLElement>('.cache-forecast')
    assert.equal(mark, null, 'no first turn renders no cache flag')
  } finally { await nftView.unmount() }

  const rows: Array<[string, CacheForecast, string, string, RegExp?]> = [
    ['known cold', legacy('known_incompatible', {
      source: 'fingerprint_and_receipt_mismatch' }), 'cold', 'prefix_changed'],
    ['no positive receipt yet', legacy('uncertain', {
      source: 'no_positive_receipt', lane: 'subscription' }),
      'cold', 'no_positive_receipt'],
    ['elapsed entry', legacy('expired_known_entry', {
      source: 'authoritative_receipt' }), 'cold', 'receipt_expired'],
    ['live receipt', legacy('compatible_observed', {
      source: 'authoritative_receipt' }), 'compatible', 'receipt_valid',
      /^cache \d+:\d\d(:\d\d)?$/],
    // D-B7: a persisted `compatible_observed` decays — an entry that was live
    // when the row was written and has since passed its expiry is RED.
    ['receipt that died since it was written', legacy('compatible_observed', {
      source: 'authoritative_receipt', expires_at: past }),
      'cold', 'receipt_expired'],
    ['real capability gap', legacy('uncertain', {
      source: 'capability_unsupported', lane: 'provider_unsupported' }),
      'uncertain', 'unsupported_capability', /lane 'provider_unsupported'/],
    ['lane not observed yet', legacy('uncertain', {
      source: 'ttl_unobserved', lane: 'unobserved' }), 'cold', 'lane_unobserved'],
    ['ambiguous ttl_unobserved on a real lane', legacy('uncertain', {
      source: 'ttl_unobserved', lane: 'subscription' }),
      'cold', 'legacy_forecast_unmigrated'],
    ['a source this table has never heard of', legacy('uncertain', {
      source: 'something_new' }), 'cold', 'legacy_forecast_unmigrated'],
  ]
  for (const [label, row, cls, cause, extra] of rows) {
    const view = await mountView(<CacheForecastMark forecast={row} />, (el) => el)
    try {
      const mark = view.el.querySelector<HTMLElement>('.cache-forecast')
      assert.equal([...(mark?.classList ?? [])][1], cls, label)
      const title = mark?.getAttribute('aria-label') ?? ''
      assert.match(title, new RegExp(`readiness: (ready|not_ready|diagnostic) \\(${cause}\\)`), label)
      assert.doesNotMatch(title, /internal_error/, `${label}: called a migration a fault`)
      // …and the tooltip says the verdict was derived here and why, so a
      // screenshot still tells the reader the backend is behind the UI.
      assert.match(title, /Re-derived in the UI from a pre-D-226 forecast/, label)
      assert.match(title, /predates D-226/, label)
      if (extra) {
        const haystack = cls === 'compatible' ? (mark?.textContent?.trim() ?? '') : title
        assert.match(haystack, extra, label)
      }
    } finally { await view.unmount() }
  }
})

test('internal_error is reserved for a verdict nothing can read, and it always says what it could not read', async () => {
  const noCause = { ...forecast('compatible_observed') }
  delete (noCause as Partial<CacheForecast>).readiness_cause
  delete (noCause as Partial<CacheForecast>).readiness_detail
  const cases: Array<[string, CacheForecast, RegExp]> = [
    ['unrecognised readiness value', {
      ...forecast('compatible_observed'),
      readiness: 'probably-fine' as unknown as CacheForecast['readiness'],
    }, /Unrecognised readiness value "probably-fine"/],
    // A green verdict with no cause is not a green verdict: the cause is the
    // half that makes a triple auditable, and a badge must not fail open on
    // half a payload.
    ['verdict without a cause', noCause as CacheForecast,
      /A 'ready' verdict arrived with no readiness_cause/],
    ['neither a triple nor a recognised state', legacy(
      'mystery' as unknown as CacheForecastState),
      /neither a readiness verdict nor a recognised state/],
  ]
  for (const [label, row, evidence] of cases) {
    const view = await mountView(<CacheForecastMark forecast={row} />, (el) => el)
    try {
      const mark = view.el.querySelector<HTMLElement>('.cache-forecast')
      assert.equal([...(mark?.classList ?? [])][1], 'uncertain', label)
      assert.equal(mark?.textContent?.trim(), 'cache ?', label)
      const title = mark?.getAttribute('aria-label') ?? ''
      assert.match(title, /readiness: diagnostic \(internal_error\)/, label)
      assert.match(title, /no verdict — internal error/, label)
      assert.match(title, evidence, `${label}: grey arrived without its evidence`)
    } finally { await view.unmount() }
  }
})

// The original past-threshold warning is UNCHANGED by the mid-turn case; it is
// simply not mid-turn. `idle` spells that out at every call so the two cases
// stay visibly distinct in these tests.
const idle = { midTurn: false, composerFocused: false, cheapCompactOn: false,
  cheapCompactOcc: null, contextRatio: 0.6 }
// A gate that is OPEN under both policies (above the 25% floor and at or
// above a 0.5 threshold), so tests about the SENTENCE are not also tests
// about the gate. The gate has its own test below.
const gateOpen = { cheapCompactOcc: 0.5, contextRatio: 0.6 }

test('only known-cold states warn at send time with policy-owned colour', async () => {
  const view = await mountView(<>
    <CacheForecastWarning {...idle} forecast={forecast('compatible_observed')} />
    <CacheForecastWarning {...idle} forecast={forecast('expired_known_entry')} />
    <CacheForecastWarning {...idle} forecast={forecast('uncertain')} />
    <CacheForecastWarning {...idle} forecast={forecast('known_incompatible', 'miss_expected')} />
    <CacheForecastWarning {...idle} forecast={forecast('expired_known_entry', 'miss_expected')} />
    <CacheForecastWarning {...idle} forecast={forecast('known_incompatible', 'will_compact')} />
    <CacheForecastWarning {...idle} forecast={forecast('expired_known_entry', 'will_compact')} />
  </>, (el) => el)
  try {
    const warnings = [...view.el.querySelectorAll<HTMLElement>('.cache-send-warning')]
    assert.equal(warnings.length, 4)
    assert.equal(warnings[0]?.classList.contains('miss'), true)
    assert.match(warnings[0]?.textContent ?? '', /Cache miss expected/)
    assert.equal(warnings[1]?.classList.contains('miss'), true)
    assert.match(warnings[1]?.textContent ?? '', /Cache miss expected/)
    assert.equal(warnings[2]?.classList.contains('compact'), true)
    assert.match(warnings[2]?.textContent ?? '', /will cheap-compact/)
    assert.equal(warnings[3]?.classList.contains('compact'), true)
    assert.match(warnings[3]?.textContent ?? '', /will cheap-compact/)
  } finally { await view.unmount() }
})

test('mid-turn + invalid readiness + focused composer warns about the steer window', async () => {
  const mid = { midTurn: true, composerFocused: true, ...gateOpen }
  const view = await mountView(<>
    {/* compactor ON → the miss costs a cheap-compact */}
    <CacheForecastWarning {...mid} cheapCompactOn
      forecast={forecast('known_incompatible')} />
    {/* compactor OFF → the miss costs a cache miss */}
    <CacheForecastWarning {...mid} cheapCompactOn={false}
      forecast={forecast('known_incompatible')} />
    {/* compactor UNREPORTED (backend older than 2dc8cbb has no
        `cheap_compact_on`) → NOT "off". The cache-miss sentence asserts that
        auto-compact is disabled, and a missing field is not that verdict
        (D-226): the user saw exactly this false claim with the compactor on.
        So neither cost sentence — just the cold turn, honestly unknown. */}
    <CacheForecastWarning {...mid} cheapCompactOn={undefined}
      forecast={forecast('known_incompatible')} />
  </>, (el) => el)
  try {
    const w = [...view.el.querySelectorAll<HTMLElement>('.cache-send-warning')]
    assert.equal(w.length, 3)
    // ALWAYS yellow: the cost is conditional on missing the window, and red is
    // reserved for a cost that is actually expected.
    for (const el of w) {
      assert.equal(el.classList.contains('midturn'), true)
      assert.equal(el.classList.contains('miss'), false, 'must not be red')
    }
    assert.match(w[0]?.textContent ?? '', /misses the mid-turn steer window/)
    assert.match(w[0]?.textContent ?? '', /cheap-compact before delivery/)
    assert.match(w[1]?.textContent ?? '', /cache miss could occur before delivery/)
    assert.match(w[1]?.textContent ?? '', /automatic cheap compaction is off/)
    assert.doesNotMatch(w[1]?.textContent ?? '', /cheap-compact/)
    assert.match(w[2]?.textContent ?? '', /misses the mid-turn steer window/)
    assert.match(w[2]?.textContent ?? '', /does not report whether cheap-compact is on/)
    assert.doesNotMatch(w[2]?.textContent ?? '', /cache miss/, 'absent is not "off"')
    assert.doesNotMatch(w[2]?.textContent ?? '', /trigger a cheap-compact/, 'absent is not "on"')
  } finally { await view.unmount() }
})

test('the mid-turn warning needs all three conditions, and overrides the original', async () => {
  const cold = forecast('known_incompatible', 'will_compact')   // actionable too
  const cases: Array<[string, ReactElement, 'midturn' | 'compact' | 'none']> = [
    ['all three → mid-turn banner, overriding the threshold banner',
      <CacheForecastWarning forecast={cold} midTurn composerFocused
        cheapCompactOn {...gateOpen} />, 'midturn'],
    // ⚠ the override direction matters: this same forecast WOULD have produced
    // the original yellow "sending will cheap-compact" banner. Mid-turn it must
    // not, because that sentence describes a send that starts a turn.
    // ⚠ MID-TURN IS SILENT UNLESS THE COMPOSER IS FOCUSED. The original banner
    // is a false positive in EVERY mid-turn state, not merely the focused one:
    // its sentence describes a send that starts a turn, and mid-turn a send
    // steers instead. `cold` here is deliberately actionable — it WOULD have
    // produced the original yellow banner — so this pins the suppression
    // rather than trivially passing on a forecast that warns about nothing.
    ['mid-turn but unfocused → silence, not the original banner',
      <CacheForecastWarning forecast={cold} midTurn composerFocused={false}
        cheapCompactOn {...gateOpen} />, 'none'],
    ['not mid-turn → falls back to the ORIGINAL banner, unchanged',
      <CacheForecastWarning forecast={cold} midTurn={false} composerFocused
        cheapCompactOn {...gateOpen} />, 'compact'],
    // grey is the ABSENCE of a verdict, not a negative one (D-226) — warning
    // on it would assert something the backend declined to say.
    ['grey diagnostic readiness is not "confirmed invalid"',
      <CacheForecastWarning forecast={forecast('uncertain')} midTurn
        composerFocused cheapCompactOn {...gateOpen} />, 'none'],
    ['a ready forecast never warns',
      <CacheForecastWarning forecast={forecast('compatible_observed')} midTurn
        composerFocused cheapCompactOn {...gateOpen} />, 'none'],
    // User ruling 2026-09-03: mid-turn, "confirmed invalid" is prefix_changed
    // and ONLY prefix_changed. Every other red cause compares against an entry
    // the running turn is about to write or refresh, so a message that misses
    // the window lands WARM and the warning was a false alarm.
    ['an expired entry mid-turn → silence: the running turn refreshes it',
      <CacheForecastWarning forecast={forecast('expired_known_entry', 'miss_expected')}
        midTurn composerFocused cheapCompactOn {...gateOpen} />, 'none'],
    ['no positive receipt mid-turn → silence: the running turn produces one',
      <CacheForecastWarning midTurn composerFocused cheapCompactOn {...gateOpen}
        forecast={forecast('uncertain', 'not_applicable',
          { readiness: 'not_ready', readiness_cause: 'no_positive_receipt' })} />, 'none'],
    ['the in-flight projection (readiness none) mid-turn → silence',
      <CacheForecastWarning midTurn composerFocused cheapCompactOn {...gateOpen}
        forecast={forecast('uncertain', 'not_applicable',
          { readiness: 'none', readiness_cause: 'turn_in_flight' })} />, 'none'],
  ]
  for (const [label, el, want] of cases) {
    const view = await mountView(el, (v) => v)
    try {
      const w = view.el.querySelector<HTMLElement>('.cache-send-warning')
      if (want === 'none') { assert.equal(w, null, label); continue }
      assert.ok(w, label)
      assert.equal(w?.classList.contains(want), true, label)
    } finally { await view.unmount() }
  }
})

// User ruling 2026-09-02 19:19Z: "if compactor off, only show sentence above
// 25% context usage. if on, show only above compact threshold." This is the
// backend's own case-2 policy (`_cache_precompact_decision`: strict 25% floor
// when off, the compactor's inclusive threshold when on) applied to the
// mid-turn banner from the node's own numbers. Every case below is otherwise
// fully armed — mid-turn, focused, confirmed-invalid — so the gate is the
// only thing deciding.
test('the mid-turn warning is gated on measured context by the compactor policy', async () => {
  const armed = { forecast: forecast('known_incompatible'), midTurn: true,
    composerFocused: true }
  const cases: Array<[string, ReactElement, boolean]> = [
    // compactor OFF: strict 25% floor, exactly as the backend applies it
    ['off, 25% exactly → shut (strict, like the backend)',
      <CacheForecastWarning {...armed} cheapCompactOn={false}
        cheapCompactOcc={null} contextRatio={0.25} />, false],
    ['off, just above 25% → open',
      <CacheForecastWarning {...armed} cheapCompactOn={false}
        cheapCompactOcc={null} contextRatio={0.251} />, true],
    ['off, 10% → shut',
      <CacheForecastWarning {...armed} cheapCompactOn={false}
        cheapCompactOcc={null} contextRatio={0.1} />, false],
    // compactor ON: the node's OWN threshold, inclusive (the destructive
    // gate's minimum) — not the 25% floor, and not a hard-coded 50%
    ['on, threshold 0.5, 49% → shut',
      <CacheForecastWarning {...armed} cheapCompactOn
        cheapCompactOcc={0.5} contextRatio={0.49} />, false],
    ['on, threshold 0.5, 50% exactly → open (inclusive)',
      <CacheForecastWarning {...armed} cheapCompactOn
        cheapCompactOcc={0.5} contextRatio={0.5} />, true],
    ['on, threshold 0.9, 60% → shut (above the floor is not enough)',
      <CacheForecastWarning {...armed} cheapCompactOn
        cheapCompactOcc={0.9} contextRatio={0.6} />, false],
    ['on, threshold 0.9, 95% → open',
      <CacheForecastWarning {...armed} cheapCompactOn
        cheapCompactOcc={0.9} contextRatio={0.95} />, true],
    ['on, threshold unreported → the compactor default 0.5 (49% shut)',
      <CacheForecastWarning {...armed} cheapCompactOn
        cheapCompactOcc={undefined} contextRatio={0.49} />, false],
    ['on, threshold unreported → the compactor default 0.5 (50% open)',
      <CacheForecastWarning {...armed} cheapCompactOn
        cheapCompactOcc={undefined} contextRatio={0.5} />, true],
    // compactor UNREPORTED (older backend): the 25% floor, the lower bar
    ['unreported, 20% → shut',
      <CacheForecastWarning {...armed} cheapCompactOn={undefined}
        cheapCompactOcc={undefined} contextRatio={0.2} />, false],
    ['unreported, 30% → open',
      <CacheForecastWarning {...armed} cheapCompactOn={undefined}
        cheapCompactOcc={undefined} contextRatio={0.3} />, true],
    // no trustworthy measurement: neither policy warns on a number it does
    // not have (the backend refuses the same way — "empty or unmeasured",
    // "only estimated")
    ['unmeasured context → shut, whatever the compactor',
      <CacheForecastWarning {...armed} cheapCompactOn={false}
        cheapCompactOcc={null} contextRatio={null} />, false],
  ]
  for (const [label, el, want] of cases) {
    const view = await mountView(el, (v) => v)
    try {
      const w = view.el.querySelector<HTMLElement>('.cache-send-warning')
      if (!want) { assert.equal(w, null, label); continue }
      assert.ok(w, label)
      assert.equal(w?.classList.contains('midturn'), true, label)
    } finally { await view.unmount() }
  }
})

test('manual compaction warning uses forecast evidence, never generic idle age', () => {
  const source = readFileSync(path.join(__SRC_DIR__, 'canvas', 'desk.tsx'), 'utf8')
  const start = source.indexOf('{askCompact && (() => {')
  const end = source.indexOf('{/* last_error moved', start)
  assert.ok(start >= 0 && end > start, 'manual compact modal source seam moved')
  const modal = source.slice(start, end)
  assert.match(modal, /node\.cache_forecast/)
  assert.match(modal, /expired_known_entry/)
  assert.match(modal, /known_incompatible/)
  assert.doesNotMatch(modal, /Date\.parse|60\s*\*\s*60e3|lastAt/)
})

test('mid-turn, the badge is the yellow steer warning for a moved prefix, and otherwise absent', async () => {
  // User ruling 2026-09-03. Hiding the whole card while a turn runs threw
  // away the one claim that is settled mid-turn: a changed prefix is a
  // comparison the running turn's outcome cannot undo, and it is what tells
  // the user to let a queued message steer NOW rather than pay a cold open
  // after the turn ends. Everything else — green, the other reds, AND grey —
  // is a prediction about how the running turn ends, which the UI must not
  // make, so it renders nothing: the yellow steer warning or no card, never a
  // placeholder. (D-235 made that one shown state yellow rather than red —
  // red and green are guarantees, and a steered message pays neither.)
  const at = (ms: number) => new Date(Date.now() + ms).toISOString()
  const rows: Array<[string, CacheForecast, boolean]> = [
    ['ready + countdown', forecast('compatible_observed', 'not_applicable', {
      source: 'authoritative_receipt', readiness: 'ready',
      readiness_cause: 'receipt_valid', expires_at: at(1800_000) }), false],
    ['not_ready/prefix_changed', forecast('known_incompatible', 'miss_expected', {
      source: 'fingerprint_and_receipt_mismatch', readiness: 'not_ready',
      readiness_cause: 'prefix_changed' }), true],
    ['not_ready/receipt_expired', forecast('expired_known_entry', 'miss_expected', {
      source: 'authoritative_receipt', readiness: 'not_ready',
      readiness_cause: 'receipt_expired', expires_at: at(-60_000) }), false],
    ['not_ready/no_positive_receipt', forecast('uncertain', 'not_applicable', {
      source: 'no_positive_receipt', readiness: 'not_ready',
      readiness_cause: 'no_positive_receipt', last_receipt_at: null,
      ttl_seconds: null, expires_at: null }), false],
    // grey says "cannot tell", which mid-turn is the default, not a card
    ['diagnostic/unsupported_capability', forecast('uncertain', 'not_applicable', {
      source: 'capability_unsupported', lane: 'provider_unsupported',
      readiness: 'diagnostic', readiness_cause: 'unsupported_capability' }), false],
    ['diagnostic/clock_anomaly', forecast('uncertain', 'not_applicable', {
      source: 'clock_skew', readiness: 'diagnostic',
      readiness_cause: 'clock_anomaly' }), false],
  ]
  for (const [label, f, shown] of rows) {
    const idle = await mountView(<CacheForecastMark forecast={f} />, (v) => v)
    try {
      assert.ok(idle.el.querySelector('.cache-forecast'),
        `${label}: idle rendered no mark`)
    } finally { await idle.unmount() }
    const busy = await mountView(<CacheForecastMark forecast={f} busy />, (v) => v)
    try {
      const mark = busy.el.querySelector<HTMLElement>('.cache-forecast')
      if (!shown) {
        assert.equal(mark, null, `${label}: mid-turn rendered a mark`)
      } else {
        assert.ok(mark, `${label}: mid-turn dropped a settled claim`)
        const title = mark.getAttribute('title') ?? ''
        assert.match(title, /a turn is running/,
          `${label}: the mid-turn tooltip does not say a turn is running`)
        // A send mid-turn steers; the "pre-turn compaction" policy line
        // describes a send that STARTS a turn and is vacuous here.
        assert.doesNotMatch(title, /pre-turn compaction/,
          `${label}: vacuous send-policy line rendered mid-turn`)
      }
    } finally { await busy.unmount() }
  }
  // Mid-turn the mark is the yellow steer-window WARNING (user, 10:36Z): red
  // and green are guarantees about the next message, this is conditional on
  // missing the window. It still names every changed component — the
  // actionable part — and idle the same forecast is the red ×.
  const cold = rows[1][1]
  const coldView = await mountView(<CacheForecastMark forecast={cold} busy />, (v) => v)
  try {
    const mark = coldView.el.querySelector<HTMLElement>('.cache-forecast.steer')
    assert.ok(mark, 'mid-turn prefix_changed is not the yellow steer warning')
    assert.equal(mark.textContent?.trim(), 'cache !')
    assert.equal(coldView.el.querySelector('.cache-forecast.cold'), null,
      'mid-turn must never wear the red that promises a miss')
    assert.match(mark.getAttribute('title') ?? '', /misses the steer window/)
    for (const item of cold.changed_inputs ?? []) {
      assert.match(mark.getAttribute('aria-label') ?? '', new RegExp(item),
        `mid-turn tooltip dropped changed component ${item}`)
    }
  } finally { await coldView.unmount() }
})


// ── INV-002 (ratified 2026-09-03) ────────────────────────────────────────
// The user's wording is the invariant: "if a turn is running, it can only
// either show yellow or not show at all. if no turn is running, it can only
// show either green or red." The two tests below are the impossibility half —
// they assert the states the invariant FORBIDS cannot be produced, rather
// than that the states it permits happen to appear today.
//
// Every cause in the backend's closed table (`cachecontinuity.READINESS`).
// Listed rather than derived because the point is to notice when the two
// drift: a cause added there and not here leaves a rendering unproven.
const EVERY_CAUSE: Array<[string, CacheForecast]> = [
  ['receipt_valid', forecast('compatible_observed', 'not_applicable', {
    readiness: 'ready', readiness_cause: 'receipt_valid' })],
  ['receipt_valid_codex_estimate', forecast('compatible_observed', 'not_applicable', {
    readiness: 'ready', readiness_cause: 'receipt_valid_codex_estimate' })],
  ['no_completed_fingerprint', forecast('uncertain', 'not_applicable', {
    readiness: 'none', readiness_cause: 'no_completed_fingerprint' })],
  ['turn_in_flight', forecast('uncertain', 'not_applicable', {
    readiness: 'none', readiness_cause: 'turn_in_flight' })],
  ['history_unobserved', forecast('uncertain', 'not_applicable', {
    readiness: 'not_ready', readiness_cause: 'history_unobserved' })],
  ['no_positive_receipt', forecast('uncertain', 'not_applicable', {
    readiness: 'not_ready', readiness_cause: 'no_positive_receipt',
    last_receipt_at: null, ttl_seconds: null, expires_at: null })],
  ['receipt_prefix_unobserved', forecast('uncertain', 'not_applicable', {
    readiness: 'not_ready', readiness_cause: 'receipt_prefix_unobserved' })],
  ['prefix_changed', forecast('known_incompatible', 'miss_expected', {
    readiness: 'not_ready', readiness_cause: 'prefix_changed' })],
  ['receipt_expired', forecast('expired_known_entry', 'miss_expected', {
    readiness: 'not_ready', readiness_cause: 'receipt_expired',
    expires_at: new Date(Date.now() - 60_000).toISOString() })],
  ['lane_unobserved', forecast('uncertain', 'not_applicable', {
    readiness: 'not_ready', readiness_cause: 'lane_unobserved' })],
  ['legacy_forecast_unmigrated', forecast('uncertain', 'not_applicable', {
    readiness: 'not_ready', readiness_cause: 'legacy_forecast_unmigrated' })],
  ['unsupported_capability', forecast('uncertain', 'not_applicable', {
    readiness: 'diagnostic', readiness_cause: 'unsupported_capability' })],
  ['receipt_timestamp_unreadable', forecast('uncertain', 'not_applicable', {
    readiness: 'diagnostic', readiness_cause: 'receipt_timestamp_unreadable' })],
  ['clock_anomaly', forecast('uncertain', 'not_applicable', {
    readiness: 'diagnostic', readiness_cause: 'clock_anomaly' })],
  ['internal_error', forecast('uncertain', 'not_applicable', {
    readiness: 'diagnostic', readiness_cause: 'internal_error' })],
]

test('INV-002 · mid-turn the card is yellow or nothing — never red, green or grey', async () => {
  // Red and green are GUARANTEES about the next message, and mid-turn the turn
  // that decides it is still running. Grey mid-turn is "cannot tell", which is
  // the default there and not a card. So for EVERY cause the only permitted
  // renderings are the yellow steer warning and no card at all.
  for (const [cause, f] of EVERY_CAUSE) {
    const view = await mountView(<CacheForecastMark forecast={f} busy />, (v) => v)
    try {
      const mark = view.el.querySelector<HTMLElement>('.cache-forecast')
      if (mark) {
        assert.equal(mark.className, 'cache-forecast steer',
          `${cause}: mid-turn rendered a card that is not the yellow steer warning`)
        assert.equal(mark.textContent?.trim(), 'cache !', `${cause}: wrong glyph`)
      }
      for (const forbidden of ['cold', 'compatible', 'uncertain']) {
        assert.equal(view.el.querySelector(`.cache-forecast.${forbidden}`), null,
          `${cause}: mid-turn wore .${forbidden} — a claim the running turn can still change`)
      }
    } finally { await view.unmount() }
  }
})

test('INV-002 · idle the card is never the yellow steer warning', async () => {
  // Yellow asserts a steer window that could be missed. With no turn running
  // there is no window, so the conditional it states cannot arise — idle must
  // resolve to the green/red (or the accounted grey / no-card) verdict.
  for (const [cause, f] of EVERY_CAUSE) {
    const view = await mountView(<CacheForecastMark forecast={f} />, (v) => v)
    try {
      assert.equal(view.el.querySelector('.cache-forecast.steer'), null,
        `${cause}: idle rendered the yellow steer warning`)
      const mark = view.el.querySelector<HTMLElement>('.cache-forecast')
      assert.doesNotMatch(mark?.textContent ?? '', /cache !/,
        `${cause}: idle wore the steer glyph`)
    } finally { await view.unmount() }
  }
})

test('INV-002 · the turn ending leaves no stale yellow behind', async () => {
  // The window an invariant violation would live in: a card showing yellow
  // when the turn ends. `steer` is derived from `busy` on every render with no
  // memo or state behind it, so the flip must be immediate — this pins that,
  // because a future refactor that caches the class would reintroduce exactly
  // the idle-yellow the invariant forbids and nothing else would catch it.
  const moved = forecast('known_incompatible', 'miss_expected', {
    readiness: 'not_ready', readiness_cause: 'prefix_changed' })
  const view = await mountView(<CacheForecastMark forecast={moved} busy />, (v) => v)
  try {
    assert.ok(view.el.querySelector('.cache-forecast.steer'), 'did not start yellow')
    // the turn ends: same component, same forecast, `busy` goes false
    await view.render(<CacheForecastMark forecast={moved} />)
    assert.equal(view.el.querySelector('.cache-forecast.steer'), null,
      'the yellow survived the turn ending — a steer warning with no steer window')
    // and it lands on RED, which is the whole point of the yellow: it predicted
    // a miss, and the prediction has to come true (user, 2026-09-03).
    const mark = view.el.querySelector<HTMLElement>('.cache-forecast.cold')
    assert.ok(mark, 'a yellow card did not become red when the turn ended')
    assert.equal(mark.textContent?.trim(), 'cache ×')
  } finally { await view.unmount() }
})
