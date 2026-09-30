// answeredstays.test.tsx — an answered question stays in the user's inbox
// (docket v3-an-answered-question-vanishes-from-the-inbox, user 2026-09-30:
// "the respective mail vanished completely from the list").
//
// Point 31 closes a question card on the click. It never asked for the inbox
// ENTRY to go: the row stays where it was, marked answered with the user's
// answer, no longer counted as waiting, and opening it shows the question and
// the answer read-only. When the tree's own resolved row arrives it replaces
// the stand-in, so the entry is listed exactly once.
//
// Run:  node apps/desktop/renderer/tests/run.mjs answeredstays

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { InboxPanel } from '../src/App'
import { CurrentOrg } from '../src/popout'
import { resetSubmittedAsks, submitAsk } from '../src/asksubmitted'
import type { AskInfo, TreePayload } from '../src/types'

const W = window as unknown as Window & typeof globalThis
if (!W.HTMLElement.prototype.scrollIntoView) W.HTMLElement.prototype.scrollIntoView = () => {}

const ASK: AskInfo = {
  id: 'ask-1', node: 'alpha', kind: 'batch', status: 'open', at: '2026-09-30T09:00:00Z',
  revs: { ask: 1 }, tabs: [{ kind: 'question', header: 'Colour', question: 'Which colour?',
    options: [{ label: 'Neutral accent' }, { label: 'Provider' }] }],
} as AskInfo

const node = (ask?: AskInfo) => ({
  id: 'alpha', title: 'alpha', tier: 'opus', model_id: 'opus', state: 'live', seat: 1,
  grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null, context_window: null,
  charter: null, mail_pending: 0, limit_locked: false, last_status: null, prev_status: null,
  inflight_at: null, last_denials: [], turns: [], frozen: null, audiences_held: [],
  bearer_state: null, generation: 0, children: [], lineage: [],
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  ...(ask ? { ask } : {}),
})

const tree = (ask: AskInfo | undefined, asks: AskInfo[] = []) => ({
  slug: 'mine', name: 'Mine', tiers: { opus: { name: 'Opus' } }, roots: [node(ask)], nodes: [],
  asks, default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
  default_visibility: 'full',
} as unknown as TreePayload)

const panel = (t: TreePayload) => (
  <CurrentOrg.Provider value="mine">
    <InboxPanel slug="mine" tree={t} toast={() => {}} close={() => {}} jumpTo={null} />
  </CurrentOrg.Provider>)

async function mount(tc: TestContext, t: TreePayload) {
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    const path = String(url)
    const body = path.includes('/inbox') ? { pending: [], delivered: [], sent: [] }
      : path.includes('/audiences') ? { audiences: [], requests: [] }
        : path.includes('/events') ? { events: [] } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const view = await mountView(panel(t), el => el)
  tc.after(async () => { await view.unmount(); globalThis.fetch = oldFetch; resetSubmittedAsks() })
  await inAct(async () => { await flush(10) })
  return view
}

const askRows = (el: HTMLElement) => [...el.querySelectorAll('.mailrow')]
  .filter((r) => /alpha/.test(r.textContent ?? ''))

const submit = () => inAct(async () => {
  void submitAsk({ slug: 'mine', nid: 'alpha', askId: 'ask-1', sections: [{ kind: 'ask', ask_id: 'ask-1',
    questions: [{ label: 'Colour', question: 'Which colour?', answer: 'Neutral accent' }] }] },
  () => new Promise(() => {}))
  await flush(3)
})

test('the answered entry stays in the list, marked answered, not waiting', async (tc) => {
  resetSubmittedAsks()
  const view = await mount(tc, tree(ASK))
  assert.equal(askRows(view.el).length, 1, 'the open request is listed')
  assert.ok(askRows(view.el)[0]!.classList.contains('unread'), 'and counted as waiting')

  await submit()
  const rows = askRows(view.el)
  assert.equal(rows.length, 1, 'the entry is still listed after the submit')
  assert.equal(rows[0]!.classList.contains('unread'), false, 'but no longer as waiting')
  assert.match(rows[0]!.textContent ?? '', /Which colour\?/, 'filed by what it asked')
  assert.doesNotMatch(rows[0]!.textContent ?? '', /awaiting one submit/)

  await inAct(async () => { (rows[0] as HTMLElement).click(); await flush(3) })
  const card = view.el.querySelector('.askcard.nulled')
  assert.ok(card, 'opening it shows the resolved card, read-only')
  assert.match(card!.textContent ?? '', /answered/)
  assert.match(card!.textContent ?? '', /Which colour\?/)
  assert.match(card!.textContent ?? '', /Neutral accent/, 'with the user\'s answer')
  assert.equal(view.el.querySelectorAll('.askcard:not(.nulled)').length, 0, 'no live card to answer again')
})

test('a resolved row already listed while the card still reads open: one entry, not two', async (tc) => {
  // a primed card (askprime) can still read open on the node while the
  // tree's asks list already carries the resolution
  resetSubmittedAsks()
  const resolved = { id: 'ask-1', node: 'alpha', kind: 'question', status: 'answered',
    at: ASK.at, question: 'Which colour?', answer: { selected: ['Neutral accent'] } } as AskInfo
  const view = await mount(tc, tree(ASK, [resolved]))
  await submit()
  assert.equal(askRows(view.el).length, 1, 'listed exactly once')
})

test('when the tree lists the resolved ask it replaces the stand-in: one entry, not two', async (tc) => {
  resetSubmittedAsks()
  const view = await mount(tc, tree(ASK))
  await submit()
  const resolved = { id: 'ask-1', node: 'alpha', kind: 'question', status: 'answered',
    at: ASK.at, question: 'Which colour?', answer: { selected: ['Neutral accent'] } } as AskInfo
  await view.render(panel(tree(undefined, [resolved])))
  await inAct(async () => { await flush(3) })
  const rows = askRows(view.el)
  assert.equal(rows.length, 1, 'listed exactly once')
  assert.equal(rows[0]!.classList.contains('unread'), false)
})
