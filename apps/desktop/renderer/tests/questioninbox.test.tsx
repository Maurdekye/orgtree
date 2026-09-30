// questioninbox.test.tsx — a question attached to a ticket lights only the
// Inbox, where it is answered, and not the Work button too (user 2026-09-30:
// both lit, "two things" for one). What is pinned here:
//
//   • a ticket held only by an open question adds nothing to the Work glow or
//     its badge; a manually flagged ticket still glows, and so does a ticket
//     with both (two real things);
//   • the docket row of a question-only ticket keeps its own status and shows
//     a small `question waiting` marker, which leaves on the click of an
//     answer and comes back if the answer is refused;
//   • the status grouping files a question-only ticket under its own status.
//
// Run:  node apps/desktop/renderer/tests/run.mjs questioninbox
import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSections, DocketRow, DocketToolbarButton } from '../src/canvas/docket'
import { resetDismissedAttention } from '../src/attndismiss'
import { publishPending, resetPending, summarizePending } from '../src/pending-attention'
import { resetSubmittedAsks, submitAsk } from '../src/asksubmitted'
import type { DesktopNotice } from '../src/notifications'
import type { WorkItem } from '../src/types'

const ORG = 'orgtree'
const flagRow = (slug: string): DesktopNotice => ({
  id: `work:${slug}:1`, org: ORG, kind: 'work-attention', item: slug, title: slug, body: 'look', rev: 1 })
type Raise = [string, number]
/** the tree: `attention` counts flag-or-question tickets, `raises` lists the
 *  manual raises only */
const button = (attention: number, raises: Raise[], active = 3) =>
  <DocketToolbarButton org={ORG} summary={{ attention, active, raises }} />
const glows = (el: HTMLElement) => !!el.querySelector('.docket-bell.glow')
const badge = (el: HTMLElement) => el.querySelector('.docket-bell .eye-count')?.textContent ?? ''

const reset = () => { resetDismissedAttention(); resetPending(); resetSubmittedAsks() }

const workItem = (slug: string, sources: ('manual' | 'question')[], askId = 'q1'): WorkItem => ({
  slug, rev: 1, kind: 'code', title: slug, objective: 'x', status: 'in_progress',
  blocked_reason: null, archived: false, archived_at: null,
  owner: { node: 'agent1', generation: 1 }, owner_current: true, owner_state: 'live',
  reviewer: null, participants: [], created_by: { node: 'agent1', generation: 1 },
  at: '2026-09-30T08:00:00.000Z', updated_at: '2026-09-30T09:00:00.000Z',
  done_so_far: [], working_on_next: [], docket_at: '2026-09-30T09:00:00.000Z',
  last_updater: { node: 'agent1', generation: 1 },
  manual_attention: sources.includes('manual')
    ? { reason: 'look', at: '2026-09-30T09:00:00Z', by: { node: 'agent1', generation: 1 }, set_rev: 1 }
    : null,
  dismissals: [],
  questions: sources.includes('question')
    ? [{ ask_id: askId, node: 'agent1', rev: 1, at: '2026-09-30T09:00:00Z',
        tabs: [{ index: 0, question: 'Which one?' }] }]
    : [],
  effective_attention: sources.length > 0, attention_sources: sources,
  acceptance: [], dependencies: [], evidence: [], delivery: null, accepted: null,
  superseded_by: null, history: [],
} as unknown as WorkItem)

const row = (item: WorkItem) =>
  <div className="docket-modal"><DocketRow item={item} selected={false} ageTick={0}
    onClick={() => {}} onDismiss={() => {}} facts={new Map()} /></div>

test('§1 a question-only ticket does not light the Work button', async () => {
  reset()
  const v = await mountView(button(1, []), (el) => el)
  try {
    assert.equal(glows(v.el), false, 'the question lights the Inbox, not this')
    assert.equal(badge(v.el), '3', 'the badge falls back to the muted active count')
  } finally { await v.unmount() }
})

test('§2 a manual flag still glows; a question-only ticket beside it adds nothing', async () => {
  reset()
  await inAct(async () => { publishPending(summarizePending([flagRow('t-m')])) })
  const v = await mountView(button(2, [['t-m', 1]]), (el) => el)
  try {
    assert.equal(glows(v.el), true)
    assert.equal(badge(v.el), '1', 'only the flagged ticket counts')
  } finally { await v.unmount() }
})

test('§3 a ticket with both a manual flag and a question glows for its flag', async () => {
  reset()
  await inAct(async () => { publishPending(summarizePending([flagRow('t-b')])) })
  const v = await mountView(button(1, [['t-b', 1]]), (el) => el)
  try {
    assert.equal(glows(v.el), true, 'two real things: the Work button for the flag')
    assert.equal(badge(v.el), '1')
  } finally { await v.unmount() }
})

test('§5 the question-only row keeps its status and says "question waiting" until answered', async () => {
  reset()
  const v = await mountView(row(workItem('t-q', ['question'])), (el) => el)
  try {
    const r = v.el.querySelector('.docket-row')!
    assert.equal(r.classList.contains('attention'), false, 'not an attention row')
    assert.equal(r.querySelector('.docket-status')?.textContent?.trim(), 'In progress')
    assert.equal(r.querySelector('.docket-qwait')?.textContent, 'question waiting')
    // answered: the marker leaves on the click, before the server answers
    let fail!: (e: Error) => void
    let failed = false
    await inAct(async () => {
      void submitAsk({ slug: ORG, nid: 'agent1', askId: 'q1', sections: null },
        () => new Promise((_resolve, reject) => { fail = reject })).catch(() => { failed = true })
    })
    assert.equal(v.el.querySelector('.docket-qwait'), null, 'gone on the click')
    // refused: it comes back
    await inAct(async () => { fail(new Error('refused')); await flush(4) })
    assert.equal(failed, true)
    assert.ok(v.el.querySelector('.docket-qwait'), 'a refused answer brings it back')
  } finally { await v.unmount() }
})

test('§6 a manually flagged row is still an attention row; with a question it says both', async () => {
  reset()
  const v = await mountView(row(workItem('t-m', ['manual'])), (el) => el)
  try {
    const r = v.el.querySelector('.docket-row')!
    assert.equal(r.classList.contains('attention'), true)
    assert.equal(r.querySelector('.docket-qwait'), null)
    await v.render(row(workItem('t-b', ['manual', 'question'])))
    const b = v.el.querySelector('.docket-row')!
    assert.equal(b.classList.contains('attention'), true)
    assert.ok(b.querySelector('.docket-qwait'))
  } finally { await v.unmount() }
})

test('§7 the status grouping files a question-only ticket under its own status', () => {
  const sections = buildSections('status', [workItem('t-q', ['question']), workItem('t-m', ['manual'])],
    [], [], () => 'agent1')
  const where = (slug: string) => sections.find((s) => s.items.some((i) => i.slug === slug))?.key
  assert.equal(where('t-m'), 'st:attention')
  assert.equal(where('t-q'), 'st:in_progress')
})
