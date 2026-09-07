// usage.test.ts — the header usage button's near-the-wall glow.
//
// The glow is a second reader of the standing the modal already renders, and
// the failure mode of a second reader is silent DISAGREEMENT: a button that
// says gold over a red bar is only visible to someone who opens the modal to
// check it, which is exactly the person who did not need the button. So the
// rule is shared (`usageSeverity`) and pinned here, together with the peak
// selection that decides WHICH lane the one button speaks for.
//
// Run:  cd frontend && node tests/run.mjs usage

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { usagePeak, usageSeverity } from '../src/App'
import type { UsageLimit, UsagePeek } from '../src/types'

const lane = (o: Partial<UsageLimit>): UsageLimit => ({
  kind: 'session', group: 'g', percent: 0, severity: 'normal',
  resets_at: null, is_active: true, model: null, ...o,
})
const peek = (...limits: UsageLimit[]): UsagePeek => ({ available: true, limits })

test('①  the thresholds are the bars\' own: gold ≥75, red ≥90', () => {
  assert.equal(usageSeverity(lane({ percent: 74.9 })), '')
  assert.equal(usageSeverity(lane({ percent: 75 })), 'warn')
  assert.equal(usageSeverity(lane({ percent: 89.9 })), 'warn')
  assert.equal(usageSeverity(lane({ percent: 90 })), 'crit')
  // upstream outranks the percent fallback in both directions of surprise:
  // a named severity colors a low lane, and `critical` is red whatever the
  // number says (an account can be walled before the bar looks full)
  assert.equal(usageSeverity(lane({ percent: 3, severity: 'warning' })), 'warn')
  assert.equal(usageSeverity(lane({ percent: 3, severity: 'critical' })), 'crit')
  assert.equal(usageSeverity(lane({ percent: null })), '')
})

test('②  no glow without a live readout', () => {
  assert.equal(usagePeak(null), null, 'nothing fetched yet')
  assert.equal(usagePeak({ available: false }), null, 'no subscription / stale')
  assert.equal(usagePeak(peek()), null, 'available but no lanes')
  assert.equal(usagePeak(peek(lane({ percent: 40 }), lane({ percent: 12 }))), null,
    'a quiet account must not glow at all')
})

test('③  the button wears the WORST lane, not the first', () => {
  const p = usagePeak(peek(
    lane({ kind: 'session', percent: 78 }),
    lane({ kind: 'weekly_all', percent: 96 })))
  assert.equal(p?.sev, 'crit')
  assert.match(p!.title, /weekly \(7 day\) at 96%/)
  // …and severity outranks the number: a lane upstream calls `critical` at
  // 5% still beats a lane sitting at 88%. Ordering by percent alone would
  // have the button report the calmer of the two.
  const q = usagePeak(peek(
    lane({ kind: 'session', percent: 88 }),
    lane({ kind: 'weekly_all', percent: 5, severity: 'critical' })))
  assert.equal(q?.sev, 'crit')
})

test('④  ties inside a band break on percent, so the tooltip names the lane '
  + 'actually closest to the wall', () => {
  const p = usagePeak(peek(
    lane({ kind: 'session', percent: 76 }),
    lane({ kind: 'weekly_scoped', percent: 83, model: 'Fable' })))
  assert.equal(p?.sev, 'warn')
  assert.match(p!.title, /weekly Fable at 83%/)
})

test('⑤  the tooltip carries the reset when there is one', () => {
  const resets = new Date(Date.now() + 2 * 3600_000 + 5 * 60_000).toISOString()
  const p = usagePeak(peek(lane({ percent: 92, resets_at: resets })))
  assert.match(p!.title, /session \(5hr\) at 92% · resets in 2h \d+m/)
  const q = usagePeak(peek(lane({ percent: 92 })))
  assert.match(q!.title, /^session \(5hr\) at 92% — Claude subscription usage$/)
})
