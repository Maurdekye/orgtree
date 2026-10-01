// attnqueuedswitch.test.tsx — the Attention view's agents list shows a QUEUED
// model switch (docket v3-changing-an-agent-s-model-does-not-show-at-on).
//
// Switching a busy agent's model is queued until its turn ends (D-234): the
// tree keeps the old `tier` and carries `pending_switch`. The canvas card and
// the desk header wear a `→X` mark for it; the Attention list row did not, so
// there the switch looked as if it had not happened at all.
//
//   §1 a row with a pending switch wears the mark, with the shared wording
//   §2 a row without one wears nothing (the control)
//
// Run:  node apps/desktop/renderer/tests/run.mjs attnqueuedswitch

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { CanvasNode } from '../src/canvas/shared'
import { queuedSwitchTitle, USER } from '../src/canvas/shared'
import type { OpFn, TreePayload } from '../src/types'
import { forgetAttentionMode } from '../src/attention/mode'
import { AgentDeskPanel } from '../src/attention/AgentDeskPanel'

const SLUG = 'org1'

const node = (id: string, parent: string | null, o: Partial<CanvasNode> = {}): CanvasNode => ({
  id, parent, tier: 'opus', state: 'live', generation: 0, children: [],
  seat: 1, grant: 10, free: 4, ...o,
} as CanvasNode)

const switching = node('alpha', USER, { busy: true, pending_switch: { tier: 'sonnet', by: USER } } as Partial<CanvasNode>)
const map = (): Map<string, CanvasNode> => new Map([
  node(USER, null, { tier: null, state: 'user' }),
  switching,
  node('beta', USER),
].map((n) => [n.id, n] as [string, CanvasNode]))

const tree = (): TreePayload => ({
  slug: SLUG, name: 'Org 1', epoch: 1, rev: 1, roots: [],
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0,
  max_top_grant: 1000,
} as unknown as TreePayload)

const op: OpFn = () => Promise.resolve({ ok: true } as never)

test('the agents list marks a queued model switch, and only that row', async () => {
  localStorage.clear()
  forgetAttentionMode()
  ;(globalThis as unknown as { fetch: unknown }).fetch = () => Promise.resolve({
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve({ ok: true, messages: [], pending: [], delivered: [], sent: [] }),
  })
  const v = await mountView(<AgentDeskPanel slug={SLUG} tree={tree()} op={op} toast={() => {}}
    map={map()} />, () => '')
  await inAct(() => flush(8))
  try {
    const row = (id: string) => v.el.querySelector(`[data-attn-agent="${id}"]`) as HTMLElement | null
    assert.ok(row('alpha') && row('beta'), 'both rows are drawn')
    // §1
    const mark = row('alpha')!.querySelector('.queued-mark')
    assert.ok(mark, 'the switching agent wears the queued mark')
    assert.equal(mark!.textContent, '→S')
    assert.equal(mark!.getAttribute('title'), queuedSwitchTitle(switching))
    assert.ok(row('alpha')!.querySelector('.tier.t-opus'), 'and still shows the model it is on now')
    // §2
    assert.equal(row('beta')!.querySelector('.queued-mark'), null, 'no switch, no mark')
  } finally { await v.unmount() }
})
