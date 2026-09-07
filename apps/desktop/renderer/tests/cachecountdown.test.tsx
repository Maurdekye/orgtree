/** The green cache badge's live expiry countdown (user spec 2026-09-02).
 *
 * The countdown REPLACES the ✓ — never both — and it only ever counts to an
 * authoritative expiry the backend actually stamped beside a positive receipt.
 * Everything here runs against a FROZEN clock, because a badge that reads the
 * wall clock is exactly the kind of thing that passes at 10:00 and fails at
 * 11:00 (which is how `cacheforecast.test.tsx`'s fixture had to be repaired).
 */
import './harness'
import { mountView } from './harness'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'

declare const __SRC_DIR__: string
import { CacheForecastMark } from '../src/canvas/desk'
import type { CacheForecast } from '../src/types'

/** A fixed instant with nothing special about it. */
const NOW = Date.parse('2026-09-02T12:00:00Z')

// D-226: a real payload always carries the readiness triple, so the fixture
// does too. Tests that want a row WITHOUT it override it explicitly — see
// "a payload with no readiness is grey, never green".
const green = (overrides: Partial<CacheForecast> = {}): CacheForecast => ({
  generation: 'opaque-generation',
  state: 'compatible_observed',
  readiness: 'ready',
  readiness_cause: 'receipt_valid',
  readiness_detail: 'A positive cache receipt for this exact prefix is still '
    + "inside the lane's TTL. A provider hit is likely but never guaranteed.",
  reason: 'observed',
  source: 'provider receipts',
  lane: 'subscription',
  last_receipt_at: '2026-09-02T11:30:00Z',
  ttl_seconds: 3600,
  expires_at: new Date(NOW + 5 * 60_000).toISOString(),
  changed_inputs: [],
  precompact_action: 'not_applicable',
  precompact_reason: '',
  ...overrides,
})

const freeze = (at: number = NOW) => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: at })
}

const badge = (el: HTMLElement) => el.querySelector<HTMLElement>('.cache-forecast')
const state = (el: HTMLElement) => [...(badge(el)?.classList ?? [])][1]
const text = (el: HTMLElement) => badge(el)?.textContent?.trim() ?? ''

test('the countdown replaces the check — never both', async () => {
  freeze()
  const view = await mountView(<CacheForecastMark forecast={green()} />, (el) => el)
  try {
    assert.equal(state(view.el), 'compatible')
    assert.equal(text(view.el), 'cache 5:00')
    assert.doesNotMatch(text(view.el), /✓/,
      'the check survived alongside the countdown')
  } finally { await view.unmount(); mock.timers.reset() }
})

test('it ticks down once a second, and crosses the hour boundary in h:mm:ss',
  async () => {
    freeze()
    const view = await mountView(
      <CacheForecastMark forecast={green({
        expires_at: new Date(NOW + 3600_000 + 2 * 60_000 + 59_000).toISOString(),
      })} />, (el) => el)
    try {
      assert.equal(text(view.el), 'cache 1:02:59')
      await view.tick(1000, (ms) => mock.timers.tick(ms))
      assert.equal(text(view.el), 'cache 1:02:58')
      await view.tick(2 * 60_000 + 58_000, (ms) => mock.timers.tick(ms))
      assert.equal(text(view.el), 'cache 1:00:00')
      // …and one second later it drops OUT of h:mm:ss into mm:ss, rather than
      // rendering a permanently zero hour field.
      await view.tick(1000, (ms) => mock.timers.tick(ms))
      assert.equal(text(view.el), 'cache 59:59')
    } finally { await view.unmount(); mock.timers.reset() }
  })

test('at the boundary the badge stops being green by itself', async () => {
  freeze()
  const view = await mountView(
    <CacheForecastMark forecast={green({
      expires_at: new Date(NOW + 2000).toISOString(),
    })} />, (el) => el)
  try {
    assert.equal(state(view.el), 'compatible')
    assert.equal(text(view.el), 'cache 0:02')
    await view.tick(2000, (ms) => mock.timers.tick(ms))
    // ⚠ NOT grey. An elapsed known entry is `expired_known_entry`, which this
    // badge has always rendered red; the same fact must not change colour
    // depending on whether the UI or the backend noticed it first.
    assert.equal(state(view.el), 'cold')
    assert.equal(text(view.el), 'cache ×')
    assert.match(badge(view.el)?.getAttribute('aria-label') ?? '',
      /passed its derived expiry/)
  } finally { await view.unmount(); mock.timers.reset() }
})

test('a receipt that is already stale renders cold, never a stale countdown',
  async () => {
    freeze()
    const view = await mountView(
      <CacheForecastMark forecast={green({
        expires_at: new Date(NOW - 60_000).toISOString(),
      })} />, (el) => el)
    try {
      assert.equal(state(view.el), 'cold')
      assert.equal(text(view.el), 'cache ×')
    } finally { await view.unmount(); mock.timers.reset() }
  })

test('no confident countdown without an authoritative expiry', async () => {
  freeze()
  // With no completed turn there is no cache at all; renders no flag (and no timer).
  const noTurnView = await mountView(<CacheForecastMark forecast={green({
    state: 'uncertain', source: 'no_completed_fingerprint',
    readiness: 'none', readiness_cause: 'no_completed_fingerprint',
    expires_at: null,
  })} />, (el) => el)
  try {
    assert.equal(badge(noTurnView.el), null, 'no completed turn renders no flag')
  } finally { await noTurnView.unmount() }

  // Each of these is a reason the countdown cannot be trusted. None may show
  // a timer; each keeps the presentation it had before this feature existed.
  const cases: Array<[string, CacheForecast, string, string]> = [
    ['no expiry stamped', green({ expires_at: null }), 'compatible', 'cache ✓'],
    ['lane has no TTL semantics',
      green({ ttl_seconds: null }), 'compatible', 'cache ✓'],
    ['a zero TTL is not a TTL',
      green({ ttl_seconds: 0 }), 'compatible', 'cache ✓'],
    ['an unparseable stamp',
      green({ expires_at: 'not-a-timestamp' }), 'compatible', 'cache ✓'],
    ['no positive receipt is red, not grey', green({
      state: 'uncertain', source: 'no_positive_receipt',
      readiness: 'not_ready', readiness_cause: 'no_positive_receipt',
      expires_at: null,
    }), 'cold', 'cache ×'],
    ['known incompatible', green({
      state: 'known_incompatible', readiness: 'not_ready',
      readiness_cause: 'prefix_changed', expires_at: null,
    }), 'cold', 'cache ×'],
    // The ONLY grey left: an enumerated fault, not an opinion about the cache.
    ['an unsupported lane is a named grey diagnostic', green({
      state: 'uncertain', source: 'capability_unsupported',
      readiness: 'diagnostic', readiness_cause: 'unsupported_capability',
      lane: 'provider_unsupported', ttl_seconds: null, expires_at: null,
    }), 'uncertain', 'cache ?'],
  ]
  for (const [label, row, cls, body] of cases) {
    const view = await mountView(<CacheForecastMark forecast={row} />, (el) => el)
    try {
      assert.equal(state(view.el), cls, label)
      assert.equal(text(view.el), body, label)
      assert.doesNotMatch(text(view.el), /\d:\d\d/, `${label} showed a timer`)
    } finally { await view.unmount() }
  }
  mock.timers.reset()
})

test('a replacement receipt restarts the countdown from the new expiry',
  async () => {
    freeze()
    // A resumed session, a fresh turn, or a provider/account/model namespace
    // change all arrive as a NEW expires_at on the same node. The badge must
    // follow the new value immediately rather than continuing an old run-out.
    const view = await mountView(
      <CacheForecastMark forecast={green({
        expires_at: new Date(NOW + 30_000).toISOString(),
      })} />, (el) => el)
    try {
      assert.equal(text(view.el), 'cache 0:30')
      await view.tick(20_000, (ms) => mock.timers.tick(ms))
      assert.equal(text(view.el), 'cache 0:10')
      await view.render(<CacheForecastMark forecast={green({
        expires_at: new Date(NOW + 20_000 + 3600_000).toISOString(),
      })} />)
      assert.equal(text(view.el), 'cache 1:00:00',
        'the badge stayed on the superseded expiry')
      assert.equal(state(view.el), 'compatible')
    } finally { await view.unmount(); mock.timers.reset() }
  })

test('a clock that jumps forward lands on the truth, not on a drifted count',
  async () => {
    freeze()
    const view = await mountView(
      <CacheForecastMark forecast={green({
        expires_at: new Date(NOW + 600_000).toISOString(),
      })} />, (el) => el)
    try {
      assert.equal(text(view.el), 'cache 10:00')
      // One pulse, but nine minutes of wall clock — a slept machine or a
      // throttled background tab. A decremented counter would read 9:59.
      await view.tick(540_000, (ms) => mock.timers.tick(ms))
      assert.equal(text(view.el), 'cache 1:00')
    } finally { await view.unmount(); mock.timers.reset() }
  })

test('unmounting releases the shared clock and nothing keeps pulsing',
  async () => {
    freeze()
    const view = await mountView(<CacheForecastMark forecast={green()} />, (el) => el)
    assert.equal(text(view.el), 'cache 5:00')
    await view.unmount()
    // The shared clock clears its interval when its subscriber set empties.
    // Ticking well past expiry must not fire a subscriber into an unmounted
    // tree — that throws, and it is how a leaked subscription announces itself.
    assert.doesNotThrow(() => mock.timers.tick(600_000))
    mock.timers.reset()
  })

test('a badge with no countdown never subscribes to the per-second clock',
  async () => {
    // The common case is a card that is NOT counting down, and on a large
    // canvas there are many of them. Subscribing them all to a 1 Hz pulse to
    // redraw an unchanging glyph is the whole-app rerender the spec ruled out.
    // Pinned at the source, because the cost is a subscription rather than
    // anything observable in one badge's DOM.
    const src = readFileSync(
      path.join(__SRC_DIR__, 'canvas/desk.tsx'), 'utf8')
    assert.match(src,
      /useSyncExternalStore\(expiresAt === null \? noAgeClock : subscribeAgeClock/,
      'the countdown subscribes unconditionally — every badge now ticks')
    assert.match(src, /const noAgeClock = \(\) => \(\) => \{\}/,
      'the no-op store went missing')
    assert.equal((src.match(/setInterval\(/g) ?? []).length, 1,
      'the countdown added a second desk timer (see derived.test.mjs ⑧)')
  })
