// freezewakecountdown.test.tsx — the badge counts down TWICE (user ruling
// 2026-09-17 18:00), because a countdown that reaches zero and then does
// nothing for a minute is the bug being fixed.
//
// The report: "i have auto-rwsume on, but the flash didnt wake when its timer
// hit 0". Measured on `notice-toggle`: 300-second probe freezes at 16:57,
// 17:03 and 17:10, each waking about 360 seconds later. The wake adds a
// clock-skew allowance that the badge did not.
//
// The user chose to keep BOTH numbers rather than move one:
//
//   "badge shows reset time (what it does now) until hitting zero, then a new
//    60s countdown until wake"
//
// So `until_ts` still means the provider's stated reset — their 2026-09-12
// ruling, "what's shown should always take precedence from the 429 error",
// is untouched and the 72 tests in test_frozen_wake_estimate.py stay green —
// and `wake_ts` is the instant the wake may actually fire.
//
// ⚠ ANTI-VACUITY. "Shows a countdown" passes whether or not the second phase
// exists, so every § below pins the TEXT for a specific clock position, and
// §4 is the negative control: a freeze with no `wake_ts` must still say
// "reset due" exactly as it always did. If §4 ever fails the same way §2
// passes, the second phase is being shown where it was not asked for.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs freezewakecountdown

import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageFreezeStatus } from '../src/canvas/desk'
import type { TreeFrozen } from '../src/types'

const SEC = 1000

function frozen(f: { untilTs?: number | null; wakeTs?: number | null }): TreeFrozen {
  return {
    at: '2026-09-17T16:57:00Z',
    until: 'capacity resets shortly',
    until_ts: f.untilTs === undefined ? null : f.untilTs,
    wake_ts: f.wakeTs === undefined ? null : f.wakeTs,
    error: 'Individual quota reached.',
    limit: true,
  } as unknown as TreeFrozen
}

const show = (fz: TreeFrozen) =>
  mountView(<UsageFreezeStatus frozen={fz} />, el => el.textContent || '')

// ── §1 before the stated reset: the provider's number, unchanged ──────────
test('counts down to the stated reset while it is still ahead', async () => {
  const now = Date.now()
  const v = await show(frozen({ untilTs: (now + 120 * SEC) / 1000,
                          wakeTs: (now + 180 * SEC) / 1000 }))
  const text = v.last()
  assert.match(text, /1:5\d|2:00/,
    'the badge must show the ~120s countdown to the STATED reset, not the '
    + 'later wake instant: ' + text)
  await v.unmount()
})

// ── §2 the minute the report is about ────────────────────────────────────
test('after the stated reset it counts down to the wake instead of stalling', async () => {
  const now = Date.now()
  const v = await show(frozen({ untilTs: (now - 5 * SEC) / 1000,
                          wakeTs: (now + 55 * SEC) / 1000 }))
  const text = v.last()
  assert.doesNotMatch(text, /reset due/,
    'this is precisely the minute that used to read "reset due" while nothing '
    + 'happened: ' + text)
  assert.match(text, /0:5\d/, 'expected the ~55s countdown to the wake: ' + text)
  await v.unmount()
})

test('the waking phase says so in its title, not just in the number', async () => {
  const now = Date.now()
  const v = await show(frozen({ untilTs: (now - 5 * SEC) / 1000,
                          wakeTs: (now + 55 * SEC) / 1000 }))
  const el = v.el.querySelector('.usage-freeze-status')
  assert.ok(el, 'the badge should render')
  assert.match(el!.getAttribute('title') || '', /waking in/,
    'the tooltip must explain WHY there is a second countdown')
  await v.unmount()
})

// ── §3 both elapsed: back to the old wording ─────────────────────────────
test('once the wake instant has also passed it reads reset due', async () => {
  const now = Date.now()
  const v = await show(frozen({ untilTs: (now - 300 * SEC) / 1000,
                          wakeTs: (now - 240 * SEC) / 1000 }))
  assert.match(v.last(), /reset due/,
    'with nothing left to count down to, the old wording is correct')
  await v.unmount()
})

// ── §4 NEGATIVE CONTROL ──────────────────────────────────────────────────
test('a freeze carrying no wake instant is untouched', async () => {
  // A connection backoff gets no allowance — its deadline is the backend's
  // OWN timer, so there is no foreign clock to be early against and
  // `wake_ts` is null. It must behave exactly as it did before this change.
  const now = Date.now()
  const v = await show(frozen({ untilTs: (now - 5 * SEC) / 1000, wakeTs: null }))
  assert.match(v.last(), /reset due/,
    'no second phase was published, so none may be shown')
  await v.unmount()
})

test('a freeze with no deadline at all still shows no countdown', async () => {
  const v = await show(frozen({ untilTs: null, wakeTs: null }))
  const text = v.last()
  assert.doesNotMatch(text, /\d:\d\d/, 'nothing to count: ' + text)
  await v.unmount()
})
