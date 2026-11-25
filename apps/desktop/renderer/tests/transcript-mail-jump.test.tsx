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

declare const __SRC_DIR__: string

const base: CanvasNode = { id: 'writer', generation: 1, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }

async function fixture(t: TestContext, prepare?: (server: FakeServer) => void) {
  resetConvos(); resetSeenMentions(); localStorage.clear()
  const server = new FakeServer()
  server.assistantMsg('An early note', { event_id: 'ev-early', ts: '2026-11-20T08:00:00Z' })
  server.assistantMsg('Sending it now', { event_id: 'ev-send', ts: '2026-11-20T10:00:00Z',
    tools: [{ name: 'mcp__orgtree__orgtree_message', id: 'toolu_1', event_id: 'ev-send-tool', mail: { id: 'm-sent', to: 'user' } }] })
  server.assistantMsg('Later work', { event_id: 'ev-late', ts: '2026-11-20T12:00:00Z' })
  prepare?.(server)
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
  return { view, toasts, server, list, left: () => view.el.querySelector('.jumpbottom') !== null }
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

// ---- the row flashes as the desk lands on it (USER 2026-11-25 m6b1d486777c1: "the view in transcript
// should flash the message or tool call line when it arrives"): the located mail's own flash
// (styles.css `jflash`, the classic mailbox's jumped-to row), once for one request ----

const flashing = (root: Element) => [...root.querySelectorAll<HTMLElement>('.jflash')]

test('a mail the agent wrote: the tool call line that sent it flashes once, with the located mail\'s flash', async t => {
  const f = await fixture(t)
  const line = f.view.el.querySelector<HTMLElement>('.tline[data-reply-event="ev-send-tool"]')
  assert.ok(line, 'POSITIVE CONTROL: the send call\'s line is drawn')
  assert.deepEqual(flashing(f.view.el), [], 'POSITIVE CONTROL: nothing flashes before the request')
  await inAct(async () => { requestTranscriptMail('org', base.id, 'm-sent', '2026-11-20T10:00:05Z'); await flush(8) })
  assert.deepEqual(flashing(f.view.el), [line], 'that line and nothing else')
  // the animation's end takes the class away, so the same row can flash for the next request
  await inAct(async () => { line.dispatchEvent(new window.Event('animationend', { bubbles: true })); await flush(2) })
  assert.deepEqual(flashing(f.view.el), [], 'one flash')
  await inAct(async () => { await refreshConvo('org', base.id, { force: true }); fireResize(f.list); await flush(8) })
  assert.deepEqual(flashing(f.view.el), [], 'a redraw of the same request does not flash again')
  await inAct(async () => { requestTranscriptMail('org', base.id, 'm-sent', '2026-11-20T10:00:05Z'); await flush(8) })
  assert.deepEqual(flashing(f.view.el), [line], 'asking again flashes again')
  // the classic mailbox's own animation, not a new one
  const { readFileSync } = await import('node:fs')
  const { default: path } = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.mailrow\.jflash, \.msgs \.jflash \{ animation: jflash 1\.6s ease-out 1; \}/)
  assert.equal(css.match(/@keyframes jflash\b/g)?.length, 1)
})

test('a mail the agent received: its delivery row flashes', async t => {
  const f = await fixture(t, (server) => {
    server.pending_mail = [{ id: 'm-in', from: 'lead', body: 'Please look at the build.', at: '2026-11-20T12:30:00Z' }]
  })
  const row = f.view.el.querySelector<HTMLElement>('[data-reply-event="mail:m-in"]')
  assert.ok(row, 'POSITIVE CONTROL: the delivery row is drawn')
  await inAct(async () => { requestTranscriptMail('org', base.id, 'm-in', '2026-11-20T12:30:00Z'); await flush(8) })
  assert.deepEqual(flashing(f.view.el), [row])
  assert.deepEqual(f.toasts, [])
})

test('a mail whose row is not in the transcript: the nearest row does not flash, it is not that message', async t => {
  const f = await fixture(t)
  await inAct(async () => { requestTranscriptMail('org', base.id, 'm-gone', '2026-11-20T08:10:00Z'); await flush(8) })
  assert.equal(f.toasts.length, 1, 'POSITIVE CONTROL: the desk said the message is not there')
  assert.deepEqual(flashing(f.view.el), [])
})

test('a row that only arrives after older pages load flashes when it is in', async t => {
  const f = await fixture(t, (server) => {
    server.cursorPages = true
    // 20 rows; the first window holds the newest ones, the send call is in row 2
    server.messages = Array.from({ length: 20 }, (_, i) => {
      const seq = i + 1
      return seq === 2
        ? { role: 'assistant', seq, event_id: 'e2', text: 'Sending the old one', ts: '2026-11-19T10:00:00Z',
            tools: [{ name: 'mcp__orgtree__orgtree_message', id: 'toolu_old', event_id: 'e2-tool', mail: { id: 'm-old', to: 'user' } }] }
        : { role: 'assistant', seq, event_id: `e${seq}`, text: `Progress ${seq}`, ts: `2026-11-20T${String(seq).padStart(2, '0')}:00:00Z` }
    }) as never
  })
  assert.equal(f.view.el.querySelector('[data-reply-event="e2"]'), null, 'POSITIVE CONTROL: the row is outside the first window')
  await inAct(async () => { requestTranscriptMail('org', base.id, 'm-old', '2026-11-19T10:00:05Z'); await flush(8) })
  assert.deepEqual(flashing(f.view.el), [], 'nothing flashes while the row is not in')
  for (let page = 0; page < 8; page++) await inAct(async () => { await flush(6) })
  assert.ok(f.server.requests.some(r => r.before), 'older pages were asked for')
  const line = f.view.el.querySelector<HTMLElement>('.tline[data-reply-event="e2-tool"]')
  assert.ok(line, 'the send call\'s line came in with its page')
  assert.deepEqual(flashing(f.view.el), [line])
  assert.deepEqual(f.toasts, [])
})
