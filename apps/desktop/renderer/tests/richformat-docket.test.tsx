// C5-C12 (spec §2.2): docket prose. Each piece renders Markdown, LaTeX and mentions.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DocketAcceptance, DocketAttentionReason, DocketEvidenceNotes, DocketList, DocketPostCompletion,
  DocketReviewState, DocketStateReason, DocketVerification,
} from '../src/canvas/docket'
import type { WorkItem } from '../src/types'
import { RICH, expectRich, onOpen, world } from './fixtures/richformat'

const refIndex = new Map() as never
const mount = async (node: React.ReactNode) => {
  const view = await mountView(node, el => el)
  await inAct(async () => { await flush(2) })
  return view
}
const item = (over: Record<string, unknown>) => over as unknown as WorkItem

test('RT-C5 done-so-far and working-on lists render rich text (inline)', async t => {
  for (const mark of ['done', 'next'] as const) {
    const view = await mount(<DocketList heading="X" items={[RICH]} mark={mark} refIndex={refIndex} refWorld={world} onOpenRef={onOpen} />)
    t.after(() => view.unmount())
    const li = view.el.querySelector('.docket-list-items li')!
    assert.ok(li, mark)
    expectRich(li)
  }
})

test('RT-C6 the blocked / dropped reason renders rich text', async t => {
  const view = await mount(<DocketStateReason field="blocked_reason" text={RICH} refWorld={world} onOpenRef={onOpen} />)
  t.after(() => view.unmount())
  expectRich(view.el.querySelector('.docket-desc-body')!)
})

test('RT-C7 evidence notes render rich text (inline)', async t => {
  const view = await mount(<DocketEvidenceNotes item={item({ evidence: [{ ref: 'abc123', note: RICH }] })} refWorld={world} onOpenRef={onOpen} />)
  t.after(() => view.unmount())
  expectRich(view.el.querySelector('li')!)
})

test('RT-C8 the review note and its evidence notes render rich text', async t => {
  const view = await mount(<DocketReviewState item={item({ candidate_verdict: { candidate: 'abc123', note: RICH,
    evidence: [{ ref: 'r1', note: RICH }] } })} refWorld={world} onOpenRef={onOpen} />)
  t.after(() => view.unmount())
  expectRich(view.el.querySelector('.docket-review-note')!)
  expectRich(view.el.querySelector('.docket-review-evidence li')!)
})

test('RT-C9 finding detail and decision notes render rich text', async t => {
  const view = await mount(<DocketVerification slug="x" refWorld={world} onOpenRef={onOpen}
    item={item({ findings: [{ id: 'F1', disposition: 'open', title: 'T', detail: RICH, decisions: [{ disposition: 'fixed', note: RICH }] }],
      findings_summary: { open: ['F1'] } })} />)
  t.after(() => view.unmount())
  expectRich(view.el.querySelector('.docket-finding-detail')!)
  expectRich(view.el.querySelector('.docket-finding-decisions li')!)
})

test('RT-C10 acceptance condition text renders rich text (inline)', async t => {
  const view = await mount(<DocketAcceptance item={item({ acceptance: [{ text: RICH }] })} refWorld={world} onOpenRef={onOpen} />)
  t.after(() => view.unmount())
  expectRich(view.el.querySelector('.docket-acceptance-item')!)
})

test('RT-C11 the post-completion addendum note renders rich text', async t => {
  const view = await mount(<DocketPostCompletion item={item({ status: 'done', post_completion: { note: RICH, at: '2026-11-03T10:00:00Z', count: 1, by: 'alpha' } })}
    refWorld={world} onOpenRef={onOpen} />)
  t.after(() => view.unmount())
  expectRich(view.el.querySelector('.docket-post-completion-detail')!)
})

test('RT-C12 the manual attention reason renders rich text', async t => {
  const view = await mount(<DocketAttentionReason reason={RICH} refWorld={world} onOpenRef={onOpen} refIndex={refIndex} />)
  t.after(() => view.unmount())
  expectRich(view.el.querySelector('.docket-attention-body')!)
})

test('RT-14 render time of the done and next lists with 40 entries each (measured and reported, not asserted)', async t => {
  const entries = Array.from({ length: 40 }, (_, i) => `entry ${i}: ${RICH}`)
  const began = performance.now()
  const view = await mount(<><DocketList heading="DONE" items={entries} mark="done" refIndex={refIndex} refWorld={world} onOpenRef={onOpen} />
    <DocketList heading="NEXT" items={entries} mark="next" refIndex={refIndex} refWorld={world} onOpenRef={onOpen} /></>)
  t.after(() => view.unmount())
  console.log(`RT-14 docket lists 40+40 rendered in ${(performance.now() - began).toFixed(0)} ms`)
  assert.equal(view.el.querySelectorAll('.docket-list-items li').length, 80)
})
