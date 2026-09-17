/** A QUEUED, UNDELIVERED NOTICE MUST DRAW EXACTLY ONE FRAME.
 *
 *  User bug 2026-09-17, with a screenshot: "when a queued and unsent notice is
 *  sitting in the transcript, it has a double-border like this. it fixes
 *  itself once it actually enters the transcript."
 *
 *  WHAT WAS ACTUALLY WRONG — worth stating, because the obvious reading is
 *  wrong. The two frames were NOT two different signals composing badly ("this
 *  is a notice" outside, "this is not delivered yet" inside). They were the
 *  SAME signal drawn twice. `.notice-bubble`'s third selector in styles.css is
 *  BARE, so it dresses any element carrying the class; `MailMessage` puts the
 *  class on the CARD (from `row.kind`), and the two pending WRAPPERS in
 *  desk.tsx used to put it on themselves as well, around a card that was
 *  already wearing it.
 *
 *  The pending state draws no border at all — it is the `.pending-divider`
 *  label, the `.pend-tag` receipt and the dim — so suppressing the wrapper's
 *  copy loses no information. That is what these tests pin: the count of
 *  bordered elements, not the presence of a border.
 *
 *  ⚠ These assert on the RENDERED DOM, not on the returned element's
 *  className. The whole defect lived in the relationship between a wrapper and
 *  the card nested inside it, and a shallow check of either one alone reports
 *  a single correct border while the pair is still wrong.
 */
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PendingGhostRow, PendingMailRow, pendTag } from '../src/canvas/desk'
import { MailMessage } from '../src/events/segments'
import type { PendingMail } from '../src/types'
import type { PendingGhost } from '../src/convo'
import { createElement } from 'react'

/** Every delivery stage `pendTag` enumerates. The user screenshotted `acked`;
 *  the wrapper class keyed off `kind` and never off `stage`, so the doubling
 *  was stage-independent and every one of these has to be checked. The
 *  `undefined` entry is the mid-task default branch. */
const STAGES: (string | undefined)[] = [
  'stranded', 'queued', 'requested', 'claimed', 'acked', 'turn', undefined,
]

const frames = (el: HTMLElement) => el.querySelectorAll('.notice-bubble').length

const mail = (kind: string, stage: string | undefined): PendingMail => ({
  id: 'm1', from: 'user', kind, body: 'Backend restarted', delivering: true,
  at: '2026-09-17T08:19:27Z', ...(stage ? { stage } : {}),
} as PendingMail)

const ghost = (notice: boolean, failed: boolean): PendingGhost => ({
  id: 1, op: 'op-1', text: 'Backend restarted', at: 1758097167000,
  ...(notice ? { notice: true } : {}), ...(failed ? { failed: true } : {}),
} as PendingGhost)

const row = (m: PendingMail) =>
  createElement(PendingMailRow, { m, slug: 'org', nid: 'agent-a' })
const ghostRow = (p: PendingGhost) =>
  createElement(PendingGhostRow, { p, slug: 'org', nid: 'agent-a' })

// ── the reported defect, at every stage that can produce it ──────────────────

for (const stage of STAGES) {
  const label = stage ?? 'mid-task default'
  test(`pending notice draws ONE frame at stage: ${label}`, async () => {
    const view = await mountView(row(mail('notice', stage)), frames)
    try {
      assert.equal(view.last(), 1,
        `a pending notice at stage "${label}" must draw exactly one notice `
        + 'frame; 2 is the double-border the user reported, 0 means the kind '
        + 'marker was lost entirely')
    } finally { await view.unmount() }
  })
}

test('the receipt line really is present — these are delivering rows', () => {
  // Guards the tests above from passing vacuously: if `delivering` stopped
  // being honoured the wrapper would render a settled-looking row and the
  // frame count would be trivially 1 for the wrong reason.
  for (const stage of STAGES) {
    assert.ok(pendTag(mail('notice', stage)).length > 0)
  }
})

// ── the optimistic ghost, the second path to the same presentation ───────────

test('pending notice GHOST draws one frame', async () => {
  const view = await mountView(ghostRow(ghost(true, false)), frames)
  try {
    assert.equal(view.last(), 1, 'notice ghost must draw exactly one frame')
  } finally { await view.unmount() }
})

test('FAILED notice ghost draws one notice frame', async () => {
  // A failed ghost additionally wears `.pending.failed`'s warn border on its
  // `.event-surface` wrapper. That is a DIFFERENT fact (it has stopped
  // waiting) and is allowed to show; what must not come back is a second
  // NOTICE frame. Before the fix the wrapper's `!important` notice border also
  // beat the warn border-color, so the failure signal was being hidden.
  const view = await mountView(ghostRow(ghost(true, true)), frames)
  try {
    assert.equal(view.last(), 1, 'failed notice ghost must draw one notice frame')
  } finally { await view.unmount() }
})

// ── the three distinctions the fix must not flatten ──────────────────────────

test('a pending notice is still distinguishable from a pending ordinary message', async () => {
  const notice = await mountView(row(mail('notice', 'acked')), frames)
  const plain = await mountView(row(mail('message', 'acked')), frames)
  try {
    assert.equal(notice.last(), 1, 'pending notice wears the kind marker')
    assert.equal(plain.last(), 0, 'pending ordinary mail wears no kind marker')
  } finally { await notice.unmount(); await plain.unmount() }
})

test('a pending notice is still distinguishable from a DELIVERED notice', async () => {
  // Same card, same one frame — the difference is the pending furniture around
  // it, which is where the pending signal has always lived.
  const settled = await mountView(
    createElement(MailMessage, {
      row: { id: 'm1', from: 'user', kind: 'notice', body: 'Backend restarted',
        at: '2026-09-17T08:19:27Z' },
      profile: 'operator', slug: 'org', nid: 'agent-a',
    } as never), (el: HTMLElement) => el)
  const pending = await mountView(row(mail('notice', 'acked')), (el: HTMLElement) => el)
  try {
    assert.equal(pending.el.querySelectorAll('.notice-bubble').length, 1)
    assert.equal(settled.el.querySelectorAll('.notice-bubble').length, 1)
    // the distinction: the receipt line, present only while undelivered
    assert.equal(pending.el.querySelectorAll('.pend-tag').length, 1,
      'the pending copy carries its delivery receipt')
    assert.equal(settled.el.querySelectorAll('.pend-tag').length, 0,
      'the delivered copy carries none')
  } finally { await settled.unmount(); await pending.unmount() }
})

// ── the parity guard: the fix must not touch the card's box ──────────────────

test('the pending wrapper adds no dress of its own around the card', async () => {
  // `pendparity_probe.py` measures that a pending card computes what its
  // settled twin does. This is the cheap structural half of the same promise:
  // the wrapper is a plain block, and the regression that started this ticket
  // was precisely a wrapper that had grown a border and a 9px left pad.
  const view = await mountView(row(mail('notice', 'acked')), (el: HTMLElement) => el)
  try {
    const wrapper = view.el.querySelector('.pendrow')!
    assert.ok(wrapper, 'the pending wrapper renders')
    assert.equal(wrapper.classList.contains('notice-bubble'), false,
      'the WRAPPER must not carry the kind marker — the card it wraps already '
      + 'draws it, and a copy here is the double border')
    assert.ok(wrapper.querySelector('.notice-bubble'),
      'the marker lives on the card inside')
  } finally { await view.unmount() }
})
