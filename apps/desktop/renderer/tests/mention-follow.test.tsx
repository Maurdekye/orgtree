// A new @user mention must never change the transcript's follow state (user
// 2026-10-18, 4.4.0-alpha.9): "when an agent that I'm in a chat with mentions me
// in their most recent message, I lose the scroll lock and the jump to bottom
// button appears, even when it's already at the bottom".
//
// The desk's own observation of a mention (it is on screen, so it counts as
// seen) went through the EXPLICIT jump-to-mention path (highlight: true), whose
// layout effect calls leaveBottom() + centers the line. So:
//   §1 a following transcript stays following (no jump button, stays pinned)
//      when a mention arrives, and the seen acknowledgement is still POSTed;
//   §2 a reader scrolled up is not moved by it (the jump button is the same
//      as for any new message);
//   §3 an EXPLICIT jump (the header "@" button / the attention row) still
//      navigates to the mention and leaves the bottom.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs mention-follow

import { FakeServer, flush, fireResize, inAct, installFetch, mountView } from './harness'
import { useState } from 'react'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { requestMentionHighlight, resetSeenMentions } from '../src/canvas/agentmentions'
import { refreshConvo, resetConvos } from '../src/convo'

const base: CanvasNode = { id: 'writer', generation: 1, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }
const MENTION = { id: 'turn:m1', event_id: 'ev-mention' }

let setNode: (n: CanvasNode) => void = () => {}
function Host() {
  const [node, set] = useState<CanvasNode>(base)
  setNode = set
  return <DeskChat node={node} map={new Map([[node.id, node]])} slug="org" op={async () => ({})} toast={() => {}} />
}

async function fixture(t: TestContext) {
  resetConvos(); resetSeenMentions(); localStorage.clear()
  const server = new FakeServer(); server.assistantMsg('First result'); installFetch(server)
  const seenPosts: string[] = []
  const inner = globalThis.fetch
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/mention-seen')) {
      seenPosts.push(String(url))
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true }) } as Response
    }
    return inner(url, init)
  }) as typeof fetch
  const view = await mountView(<Host />, el => el)
  t.after(async () => { globalThis.fetch = inner; await view.unmount(); resetConvos(); resetSeenMentions() })
  await inAct(async () => { await refreshConvo('org', base.id, { force: true }); await flush(5) })
  const list = view.el.querySelector<HTMLElement>('.msgs-wrap .msgs')!
  assert.ok(list, 'real DeskChat transcript mounted')
  let height = 1200, top = 0
  Object.defineProperties(list, {
    clientHeight: { configurable: true, get: () => 400 },
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: { configurable: true, get: () => top,
      set: (v: number) => { top = Math.max(0, Math.min(v, height - 400)) } },
  })
  await inAct(() => { fireResize(list) })
  assert.equal(top, 800, 'fixture starts pinned to the tail')
  const jump = () => view.el.querySelector('.jumpbottom') !== null
  const wheel = async (deltaY: number) => inAct(() => {
    list.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY }))
  })
  const scroll = async (next: number) => inAct(async () => {
    list.scrollTop = next; list.dispatchEvent(new window.Event('scroll', { bubbles: true })); await flush(3)
  })
  /** the agent's newest message mentions the user: the tree reports the mention and the row grows the list */
  const mention = async () => inAct(async () => {
    height += 200
    server.assistantMsg('Ready for you, @user.', { event_id: MENTION.event_id })
    setNode({ ...base, user_mention: MENTION } as CanvasNode)
    await refreshConvo('org', base.id, { force: true }); await flush(8)
  })
  return { list, jump, wheel, scroll, mention, seenPosts, bottom: () => height - 400, view }
}

test('§1 a mention arriving while the reader follows the tail keeps follow on and the jump button hidden', async t => {
  const f = await fixture(t)
  assert.equal(f.jump(), false, 'fixture: following, no jump button')
  await f.mention()
  assert.equal(f.view.el.textContent?.includes('Ready for you'), true, 'positive control: the mention message rendered')
  assert.equal(f.jump(), false, 'the mention must not show "jump to bottom"')
  assert.equal(f.list.scrollTop, f.bottom(), 'and the view stays pinned to the new tail')
  assert.equal(f.seenPosts.length, 1, 'the seen acknowledgement is still sent')
  // follow is still on: the next ordinary message is followed too
  await inAct(async () => { await flush(1) })
})

test('§2 a mention arriving while the reader is scrolled up does not move them', async t => {
  const f = await fixture(t)
  await f.wheel(-1); await f.scroll(400)
  assert.equal(f.jump(), true, 'fixture: the reader left the tail, the jump button is up')
  await f.mention()
  assert.equal(f.list.scrollTop, 400, 'the mention did not scroll the reader to itself')
  assert.equal(f.jump(), true, 'the jump button behaves as for any new message')
  assert.equal(f.seenPosts.length, 1)
})

test('§3 an explicit jump to the mention still navigates and leaves the bottom', async t => {
  const f = await fixture(t)
  await f.mention()
  assert.equal(f.jump(), false)
  await inAct(async () => { requestMentionHighlight('org', base.id, 'turn:m2', MENTION.event_id); await flush(6) })
  assert.equal(f.jump(), true, 'the explicit mention jump leaves the bottom, as it always did')
})
