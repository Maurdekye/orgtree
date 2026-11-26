// attachonly.test.tsx — a message that is only files carries no placeholder
// text (USER 2026-11-26 14:08:28Z m2b7a281ca223, chats panel on
// 4.7.0-alpha.8: "if i send just a picture with no message, dont say "(file
// attached)" in the message"; docket
// chats-panel-a-picture-sent-with-no-text-shows-fi). The chats panel's own
// send and bubbles are in dmparity.test.tsx §8.
//
//   §1  the desk: sending only a staged file posts an empty text
//   §2  the desk transcript: a files-only message has no text line, whether its
//       body is empty or the old "(file attached)", typed or untyped
//   §3  the mailbox reading pane (MailMessageBody, shared with the chats
//       bubbles) does the same; a message that SAYS "(file attached)" with no
//       file keeps its words
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs attachonly

import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { MailMessageBody } from '../src/canvas/mail'
import type { CanvasNode, MailRow } from '../src/canvas/shared'
import { refreshConvo, resetConvos } from '../src/convo'
import { draftKey, storeAttachments } from '../src/draftstore'

const W = window as unknown as Window & typeof globalThis
const g = globalThis as unknown as { fetch: typeof fetch }
const PLACEHOLDER = '(file attached)'

const writer: CanvasNode = {
  id: 'writer', generation: 2, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
}
const desk = (node: CanvasNode = writer) => <DeskChat node={node}
  map={new Map([[node.id, node]])} slug="org" op={async () => ({})} toast={() => {}} bare />

const ev = (body: string) => ({ v: 1, variant: 'ordinary.message', actor: { kind: 'user', id: '@user' }, object: null,
  engine_authored: false, body })
const pic = [{ path: 'uploads/image.png', name: 'image.png', bytes: 2048 }]

test('§1 the desk: a staged picture sent with no text posts an empty text, not a placeholder', async (t: TestContext) => {
  localStorage.clear(); resetConvos()
  storeAttachments(draftKey('org', 'writer', 2), pic)
  installFetch(new FakeServer())
  const inner = g.fetch
  const posts: { text?: string; attachments?: string[] }[] = []
  g.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (/\/nodes\/writer\/message$/.test(String(url)) && (init?.method ?? 'GET').toUpperCase() === 'POST') {
      posts.push(JSON.parse(String(init!.body)))
      return new Response(JSON.stringify({ accepted: true, id: 'm-new' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return inner(url, init)
  }) as typeof fetch
  const view = await mountView(desk(), el => el)
  t.after(async () => { await view.unmount(); resetConvos(); localStorage.clear() })
  await inAct(async () => { await flush(3) })
  assert.match(view.el.querySelector('.attach-row')?.textContent ?? '', /image\.png/, 'the picture is staged')
  const box = view.el.querySelector('textarea') as HTMLTextAreaElement
  assert.equal(box.value, '', 'with no text')
  await inAct(async () => {
    box.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flush(6)
  })
  assert.equal(posts.length, 1, 'it is sent')
  assert.equal(posts[0]!.text, '', 'with an empty text')
  assert.deepEqual(posts[0]!.attachments, ['uploads/image.png'], 'and the picture')
  assert.doesNotMatch(view.el.textContent ?? '', /\(file attached\)/, 'no placeholder anywhere on the desk')
})

for (const [label, body, typed] of [
  ['an empty body', '', false], ['an empty body, typed', '', true],
  ['the old placeholder', PLACEHOLDER, false], ['the old placeholder, typed', PLACEHOLDER, true],
] as const) {
  test(`§2 the desk transcript: a files-only message with ${label} has no text line`, async (t: TestContext) => {
    localStorage.clear(); resetConvos()
    const s = new FakeServer()
    s.userMsg('x').segments = [{ kind: 'mail', rows: [{
      id: 'pic-mail', from: '@user', kind: 'message', at: '2026-11-26T14:00:00Z', body,
      ...(typed ? { ev: ev(body) } : {}), attachments: pic,
    }] }]
    installFetch(s)
    await refreshConvo('org', 'writer')
    const view = await mountView(desk(), el => el)
    t.after(async () => { await view.unmount(); resetConvos() })
    await inAct(async () => { await flush(3) })
    const card = view.el.querySelector('[data-mail-id="pic-mail"]')
    assert.ok(card, 'the message is in the transcript')
    assert.ok(card!.querySelector('img.attach-thumb'), 'with its picture')
    assert.doesNotMatch(card!.textContent ?? '', /\(file attached\)/, 'no placeholder')
    assert.equal(card!.querySelector('.event-prose, [data-event-field="body"]'), null, 'and no empty text line')
  })
}

async function pane(t: TestContext, m: MailRow) {
  const view = await mountView(<MailMessageBody m={m} org="org" sender={(id) => id} />, el => el)
  t.after(async () => { await view.unmount() })
  await inAct(async () => { await flush(2) })
  return view.el
}

for (const [label, body, typed] of [
  ['an empty body', '', false], ['an empty body, typed', '', true],
  ['the old placeholder', PLACEHOLDER, false], ['the old placeholder, typed', PLACEHOLDER, true],
] as const) {
  test(`§3 the reading pane: a files-only message with ${label} has no text line`, async (t) => {
    const el = await pane(t, { id: 'pic', from: '@user', to: 'writer', at: '2026-11-26T14:00:00Z', kind: 'message', body,
      ...(typed ? { ev: ev(body) } : {}), attachments: pic } as unknown as MailRow)
    assert.doesNotMatch(el.textContent ?? '', /\(file attached\)/, 'no placeholder')
    assert.equal(el.querySelector('.mailer-body'), null, 'and no empty text line')
  })
}

test('§3 the reading pane: "(file attached)" with no file is the sender\'s words and stays', async (t) => {
  const el = await pane(t, { id: 'said', from: 'writer', at: '2026-11-26T14:00:00Z', kind: 'message', body: PLACEHOLDER } as unknown as MailRow)
  assert.match(el.textContent ?? '', /\(file attached\)/)
})

test('§3 the reading pane: a picture with words keeps the words', async (t) => {
  const el = await pane(t, { id: 'both', from: '@user', at: '2026-11-26T14:00:00Z', kind: 'message', body: 'look',
    ev: ev('look'), attachments: pic } as unknown as MailRow)
  assert.match(el.textContent ?? '', /look/)
})
