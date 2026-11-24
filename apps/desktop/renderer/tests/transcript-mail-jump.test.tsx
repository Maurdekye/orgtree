// "View in transcript" (USER 2026-11-24 m3c9cf622c450: "messages need an additional view in transcript
// context menu action, which jumps to that agent's transcript"): the desk shows the row of one mail.
// The request rides the desk's existing external jump (the @user mention jump: agentmentions.tsx
// `mentionHighlights`, desk.tsx `centerMentionRef`), which pages older rows until the row is in.
//
//   - mail the agent wrote: the message whose send call wrote it (its tool chip carries the mail);
//   - mail the agent received: its delivery row (`data-reply-event="mail:<id>"`);
//   - neither in the transcript any more: the row nearest in time, and the desk says so.
//
// Run:  node apps/desktop/renderer/tests/run.mjs transcript-mail-jump

import './harness'
import { useState } from 'react'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, fireResize, flush, inAct, installFetch, mountView } from './harness'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { mentionHighlightOf, requestTranscriptMail, resetSeenMentions } from '../src/canvas/agentmentions'
import { refreshConvo, resetConvos } from '../src/convo'

const base: CanvasNode = { id: 'writer', generation: 1, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }

async function fixture(t: TestContext) {
  resetConvos(); resetSeenMentions(); localStorage.clear()
  const server = new FakeServer()
  server.assistantMsg('An early note', { event_id: 'ev-early', ts: '2026-11-20T08:00:00Z' })
  server.assistantMsg('Sending it now', { event_id: 'ev-send', ts: '2026-11-20T10:00:00Z',
    tools: [{ name: 'mcp__orgtree__orgtree_message', id: 'toolu_1', event_id: 'ev-send-tool', mail: { id: 'm-sent', to: 'user' } }] })
  server.assistantMsg('Later work', { event_id: 'ev-late', ts: '2026-11-20T12:00:00Z' })
  const inner = globalThis.fetch
  installFetch(server)
  const toasts: string[] = []
  function Host() {
    const [node] = useState<CanvasNode>(base)
    return <DeskChat node={node} map={new Map([[node.id, node]])} slug="org" op={async () => ({})} toast={(lines) => { toasts.push(...lines) }} />
  }
  const view = await mountView(<Host />, el => el)
  t.after(async () => { globalThis.fetch = inner; await view.unmount(); resetConvos(); resetSeenMentions() })
  await inAct(async () => { await refreshConvo('org', base.id, { force: true }); await flush(5) })
  const list = view.el.querySelector<HTMLElement>('.msgs-wrap .msgs')!
  assert.ok(list, 'real DeskChat transcript mounted')
  let top = 0
  Object.defineProperties(list, {
    clientHeight: { configurable: true, get: () => 400 },
    scrollHeight: { configurable: true, get: () => 1200 },
    scrollTop: { configurable: true, get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, 800)) } },
  })
  await inAct(() => { fireResize(list) })
  assert.equal(top, 800, 'fixture starts pinned to the tail')
  return { view, toasts, left: () => view.el.querySelector('.jumpbottom') !== null }
}

test('a mail the agent wrote: the desk goes to the message whose send call wrote it', async t => {
  const f = await fixture(t)
  assert.equal(f.view.el.textContent?.includes('Sending it now'), true, 'POSITIVE CONTROL: the sending message is drawn')
  assert.equal(f.left(), false, 'POSITIVE CONTROL: following the tail')
  await inAct(async () => { requestTranscriptMail('org', base.id, 'm-sent', '2026-11-20T10:00:05Z'); await flush(8) })
  assert.deepEqual(mentionHighlightOf('org', base.id)?.mailId, 'm-sent')
  assert.equal(f.left(), true, 'the desk left the tail for that row')
  assert.deepEqual(f.toasts, [], 'and found it: nothing to say')
})

test('a mail that is not in the transcript: the desk goes to the row nearest in time and says so, once', async t => {
  const f = await fixture(t)
  await inAct(async () => { requestTranscriptMail('org', base.id, 'm-gone', '2026-11-20T08:10:00Z'); await flush(8) })
  assert.equal(f.left(), true, 'the desk left the tail for the nearest row')
  assert.deepEqual(f.toasts, ['that message is not in writer\u2019s transcript any more: showing the nearest time'])
  await inAct(async () => { await refreshConvo('org', base.id, { force: true }); await flush(8) })
  assert.equal(f.toasts.length, 1, 'said once for one request')
})

test('a request names one agent\u2019s desk and a newer one replaces it', () => {
  resetSeenMentions()
  requestTranscriptMail('org', 'writer', 'm1', '2026-11-20T10:00:00Z')
  const first = mentionHighlightOf('org', 'writer')
  assert.deepEqual([first?.mentionId, first?.mailId, first?.at, first?.eventId], ['mail:m1', 'm1', '2026-11-20T10:00:00Z', undefined])
  assert.equal(mentionHighlightOf('org', 'other'), null)
  requestTranscriptMail('org', 'writer', 'm2')
  assert.equal(mentionHighlightOf('org', 'writer')?.mailId, 'm2')
  assert.equal((mentionHighlightOf('org', 'writer')?.seq ?? 0) > (first?.seq ?? 0), true, 'a new request, even for the same mail')
  resetSeenMentions()
})
