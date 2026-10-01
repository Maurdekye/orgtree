// inboxdot.test.tsx — the header mail dot and the user inbox must agree
// (docket v3-mail-icon-says-a-request-is-waiting-on-the-us, 2026-09-30).
//
// The case that caused the report: the dot counted requests waiting in EVERY
// organization, and the one lighting it was an unread terminal failure in
// ANOTHER organization (maurdekye-works), which the open organization's inbox
// never lists. So the user saw a lit dot and an inbox with nothing unread.
// The user's ruling (08:37Z): the dot is ORG-SCOPED — a request in another
// organization must not light the dot in this organization's window.
//
// The user's addendum (08:08Z): after answering a question the icon still
// glowed. A submitted card must leave the dot, the count and the glow on the
// click, not when the agent or the next poll catches up.
//
// Run:  node apps/desktop/renderer/tests/run.mjs inboxdot

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AskBell, InboxPanel } from '../src/App'
import { CurrentOrg } from '../src/popout'
import type { DesktopNotice } from '../src/notifications'
import { publishPending, resetPending, startPendingMirror, summarizePending } from '../src/pending-attention'
import { resetSubmittedAsks, submitAsk } from '../src/asksubmitted'
import type { TreePayload } from '../src/types'

const W = window as unknown as Window & typeof globalThis
if (!W.HTMLElement.prototype.scrollIntoView) W.HTMLElement.prototype.scrollIntoView = () => {}

// the live row from the report, shape as /api/desktop/notifications served it
const stopped: DesktopNotice = { id: '0703f9d8', org: 'maurdekye-works', kind: 'terminal-failure',
  source_id: '47adf8b1', agent: '@system', title: 'Message from @system',
  body: 'coordinator-opus (coordinator-opus) stopped: its turn failed in a way orgtree does not retry.\nIt is idle now.' }
// the same kind of row in the window's own organization
const stoppedHere: DesktopNotice = { ...stopped, id: '1a2b3c4d', org: 'orgtree', source_id: '5e6f7a8b' }
const question: DesktopNotice = { id: 'e257', org: 'orgtree', kind: 'question', source_id: 'qa',
  agent: 'coordinator-opus', title: 'Question from coordinator-opus', body: 'Which colour?' }

const TREE = {
  slug: 'orgtree', name: 'Orgtree', tiers: { opus: { name: 'Opus' } }, roots: [], nodes: [],
  default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
  default_visibility: 'full',
} as unknown as TreePayload

const reset = () => { localStorage.clear(); resetPending(); resetSubmittedAsks() }

async function inbox(t: TestContext) {
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    const path = String(url)
    // the open organization's own box: nothing unread, as the user saw it
    const body = path.includes('/inbox') ? { pending: [], delivered: [], sent: [] }
      : path.includes('/audiences') ? { audiences: [], requests: [] }
        : path.includes('/events') ? { events: [] } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const view = await mountView(
    <CurrentOrg.Provider value="orgtree">
      <InboxPanel slug="orgtree" tree={TREE} toast={() => {}} close={() => {}} jumpTo={null} />
    </CurrentOrg.Provider>, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch })
  await inAct(async () => { await flush(10) })
  return view
}

test('the aggregate keeps each waiting row with its organization, docket rows excluded', () => {
  const all = summarizePending([stopped, question,
    { id: 'w-1', org: 'unity', kind: 'work-attention', item: 't', title: 'T', body: 'b' }])
  assert.equal(all.mail, 2)
  assert.deepEqual(all.waiting.map((w) => [w.org, w.kind, w.source]), [
    ['maurdekye-works', 'terminal-failure', '47adf8b1'],
    ['orgtree', 'question', 'qa'],
  ])
})

test('the reported case: a stopped agent in another organization does not light this window\'s dot', async (t) => {
  reset()
  t.after(reset)
  const view = await inbox(t)
  const bell = await mountView(<AskBell tree={TREE} onOpen={() => {}} />, el => el)
  t.after(() => bell.unmount())
  const button = () => bell.el.querySelector<HTMLElement>('button.ask-bell')!

  await inAct(async () => { publishPending(summarizePending([stopped])) })
  assert.equal(!!bell.el.querySelector('.attn-dot'), false, 'maurdekye-works does not light orgtree')
  assert.doesNotMatch(button().title, /still waiting/, 'nor claims it in words')
  assert.doesNotMatch(view.el.textContent ?? '', /maurdekye-works/,
    'and the inbox lists only its own organization')

  await inAct(async () => { publishPending(summarizePending([stopped, stoppedHere])) })
  assert.ok(bell.el.querySelector('.attn-dot'), 'the same kind of row in THIS organization does')
  assert.match(button().title, /1 request\(s\) still waiting on you/, 'counting only this organization')

  await inAct(async () => { publishPending(summarizePending([stopped])) })
  assert.equal(!!bell.el.querySelector('.attn-dot'), false, 'and clears when only the other remains')
})

test('a window that only mirrors the aggregate scopes it the same way (e.g. after a restart)', async (t) => {
  reset()
  t.after(reset)
  const stopOwner = startPendingMirror(true)
  await inAct(async () => { publishPending(summarizePending([stopped])) })
  stopOwner()
  resetPending()
  const stopFollower = startPendingMirror(false)
  t.after(stopFollower)
  const bell = await mountView(<AskBell tree={TREE} onOpen={() => {}} />, el => el)
  t.after(() => bell.unmount())
  assert.equal(!!bell.el.querySelector('.attn-dot'), false, 'another organization\'s row, mirrored: no dot')

  const stopOwner2 = startPendingMirror(true)
  await inAct(async () => { publishPending(summarizePending([stoppedHere])) })
  stopOwner2()
  assert.ok(bell.el.querySelector('.attn-dot'), 'its own organization\'s row, mirrored: dot')
})

test('an answered question leaves the dot on the click, and a failed submit brings it back', async (t) => {
  reset()
  t.after(reset)
  const bell = await mountView(<AskBell tree={TREE} onOpen={() => {}} />, el => el)
  t.after(() => bell.unmount())
  await inAct(async () => { publishPending(summarizePending([question])) })
  assert.ok(bell.el.querySelector('.attn-dot'))

  let fail: (e: Error) => void = () => {}
  let sent: Promise<void> = Promise.resolve()
  await inAct(async () => {
    sent = submitAsk({ slug: 'orgtree', nid: 'coordinator-opus', askId: 'qa', sections: null },
      () => new Promise((_, reject) => { fail = reject }))
  })
  assert.equal(!!bell.el.querySelector('.attn-dot'), false, 'gone before the server or the feed answers')
  assert.doesNotMatch(bell.el.querySelector<HTMLElement>('button.ask-bell')!.title, /still waiting/)

  await inAct(async () => { fail(new Error('conflict')); await sent.catch(() => {}) })
  assert.ok(bell.el.querySelector('.attn-dot'), 'the card is back, so the request is still waiting')
})

test('an answered question leaves the bell\'s count and glow on the click too', async (t) => {
  reset()
  t.after(reset)
  const node = { id: 'coordinator-opus', children: [],
    ask: { id: 'qa', node: 'coordinator-opus', kind: 'batch', status: 'open', at: '2026-09-30T08:06:50Z',
      tabs: [{ kind: 'question', question: 'Which colour?' }], revs: { ask: 1 } } }
  const tree = { ...TREE, asks_open: 1, user_inbox_count: 0, roots: [node] } as unknown as TreePayload
  const bell = await mountView(<AskBell tree={tree} onOpen={() => {}} />, el => el)
  t.after(() => bell.unmount())
  const button = () => bell.el.querySelector<HTMLElement>('button.ask-bell')!
  assert.match(button().className, /\bglow\b/)
  assert.equal(bell.el.querySelector('.eye-count')?.textContent, '1')

  await inAct(async () => {
    void submitAsk({ slug: 'orgtree', nid: 'coordinator-opus', askId: 'qa', sections: null },
      () => new Promise(() => {}))
  })
  assert.doesNotMatch(button().className, /\bglow\b/, 'no glow once answered')
  assert.equal(!!bell.el.querySelector('.eye-count'), false, 'and no count')
})
