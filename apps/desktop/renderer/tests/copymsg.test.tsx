// copymsg.test.tsx — COPY A TRANSCRIPT MESSAGE FROM ITS CONTEXT MENU
// (user request 2026-09-11: transcript messages had no right-click action for
// copying their contents).
//
// Every test here drives the REAL desk: the real `DeskChat` against the fake
// server, the real `useContextMenu`, the real entry, the real
// `copyToClipboard`. Only the platform clipboard itself is stubbed, at the
// one boundary jsdom does not provide — the same `stubClipboard` the existing
// contextmenu suite uses.
//
// WHAT EACH SECTION IS FOR, and what it would catch:
//
//   §1  the action exists, is labelled, and puts the message on the clipboard.
//   §2  IT IS NOT READ FROM `data-reply-quote`. The server caps every reply
//       quote at 4000 chars, so a 4200-char message copied from the attribute
//       would paste 200 chars short and LOOK complete. The fixture makes the
//       two strings genuinely differ and asserts the DOM really does carry the
//       short one, so this cannot pass by accident.
//   §3  IT IS NOT READ FROM THE DOM. A compaction summary sits behind a click
//       and is not rendered at all until opened; §3 asserts it is absent from
//       the row's text and present on the clipboard.
//   §4  THE ENVELOPE STAYS OFF THE CLIPBOARD — an enveloped user turn copies
//       the user's own words and the mail it carried, never the org-state
//       block the desk hides. §4b IS ITS POSITIVE CONTROL: a machine segment
//       the desk DOES show (an idle-docket wake) is copied, so §4 cannot be
//       passing merely because state segments are dropped wholesale.
//   §5  granularity: the thought and a tool result are their own targets, so
//       right-clicking the thought copies the thought and not the message.
//   §6  a row with nothing to copy offers a DISABLED item — never an empty
//       clipboard write and never a fallback that would leak the envelope.
//   §7  a clipboard that is absent says so; it never reports a copy that did
//       not happen.
//   §8  existing interactions survive: a live selection still keeps the
//       browser's own menu (so ordinary select-and-copy is untouched), and
//       Reply is still the first entry and still works. §1 is §8's positive
//       control — the same press without a selection does open our menu.
//
// Run:  node apps/desktop/renderer/tests/run.mjs copymsg
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { DeskChat } from '../src/canvas/desk'
import { messageCopyText } from '../src/canvas/copytext'
import type { CanvasNode } from '../src/canvas/shared'
import { addPending, refreshConvo, resetConvos } from '../src/convo'
import type { ChatMessage, Segment } from '../src/types'
import type { Event } from '../src/generated/events'

declare const __SRC_DIR__: string
const fixture = (name: string) => JSON.parse(readFileSync(
  path.resolve(__SRC_DIR__, '../tests/fixtures/events/' + name + '.json'), 'utf8'))
const ORG_STATE = fixture('context.org_state')
const REMINDER = fixture('reminder.idle_docket')

const W = window as unknown as Window & typeof globalThis
const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }

const labels = () => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .map(b => b.textContent ?? '')
const itemNamed = (label: string) => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .find(b => b.textContent === label) as HTMLButtonElement | undefined

/** a right-click as the browser dispatches it. Returns whether the app took it. */
async function rightClick(el: Element): Promise<boolean> {
  const ev = new W.MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })
  await inAct(() => { el.dispatchEvent(ev) })
  await flush(2)
  return ev.defaultPrevented
}
async function pick(label: string) {
  const b = itemNamed(label)
  assert.ok(b, `menu item "${label}" present — have ${JSON.stringify(labels())}`)
  await inAct(() => { b!.click() })
  await flush(3)
}
function stubClipboard(): { writes: string[]; restore: () => void } {
  const writes: string[] = []
  const nav = W.navigator as unknown as Record<string, unknown>
  const had = Object.getOwnPropertyDescriptor(nav, 'clipboard')
  Object.defineProperty(nav, 'clipboard', { configurable: true,
    value: { writeText: (t: string) => { writes.push(t); return Promise.resolve() } } })
  return { writes, restore: () => {
    if (had) Object.defineProperty(nav, 'clipboard', had)
    else delete nav.clipboard
  } }
}
/** no clipboard at all — what a denied or absent platform clipboard looks like */
function noClipboard(): () => void {
  const nav = W.navigator as unknown as Record<string, unknown>
  const had = Object.getOwnPropertyDescriptor(nav, 'clipboard')
  Object.defineProperty(nav, 'clipboard', { configurable: true, value: undefined })
  return () => {
    if (had) Object.defineProperty(nav, 'clipboard', had)
    else delete nav.clipboard
  }
}

interface Mounted {
  el: HTMLElement
  toasts: string[][]
  unmount: () => Promise<void>
}
/** the real desk, loaded with `messages`, after its first poll has settled */
async function desk(messages: ChatMessage[]): Promise<Mounted> {
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.messages = messages
  installFetch(server)
  const toasts: string[][] = []
  const view = await mountView(
    <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org"
      op={async () => ({})} toast={lines => { toasts.push(lines) }} pub={false} bare />,
    el => el)
  await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
  return { el: view.el, toasts, unmount: async () => { await view.unmount(); resetConvos() } }
}
const rowOf = (m: Mounted, id: string) =>
  m.el.querySelector(`[data-transcript-row][data-reply-event="${id}"]`) as HTMLElement

// ────────────────────────────────────────────────────────── §1 the action

test('§1 right-clicking a message offers Copy contents and copies its text', async () => {
  const clip = stubClipboard()
  const m = await desk([
    { role: 'user', text: 'What did you do?', seq: 0, event_id: 'ask-1' },
    { role: 'assistant', text: 'I landed the branch.\n\n- rebased\n- merged', seq: 1, event_id: 'reply-1' },
  ])
  try {
    const row = rowOf(m, 'reply-1')
    assert.ok(row, 'fixture: the assistant row is on screen')
    const took = await rightClick(row.querySelector('.msgtext')!)
    assert.equal(took, true, 'the app takes the press')
    assert.deepEqual(labels(), ['Reply', 'Copy contents'],
      'Reply keeps its place and the new action follows it')
    assert.equal(itemNamed('Copy contents')!.disabled, false)
    await pick('Copy contents')
    assert.deepEqual(clip.writes, ['I landed the branch.\n\n- rebased\n- merged'],
      'the MARKDOWN SOURCE, exactly — not the rendered text')
    assert.deepEqual(m.toasts, [['copied the message']])
  } finally { clip.restore(); await m.unmount() }
})

// ─────────────────────────────────────── §2 not the capped reply quote

test('§2 a message longer than the 4000-char reply quote copies WHOLE', async () => {
  const clip = stubClipboard()
  // exactly the shape the server produces: reply_events.py caps the quote at
  // 4000 characters while the row keeps its full text
  const body = 'A'.repeat(4000) + 'THE-TAIL-THAT-THE-QUOTE-LOST'
  const m = await desk([
    { role: 'assistant', text: body, reply_quote: body.slice(0, 4000), seq: 0, event_id: 'long-1' },
  ])
  try {
    const row = rowOf(m, 'long-1')
    // the control: the DOM really does carry only the capped copy, so a
    // reader that trusted the attribute would truly lose the tail
    assert.equal(row.getAttribute('data-reply-quote')!.length, 4000)
    assert.doesNotMatch(row.getAttribute('data-reply-quote')!, /THE-TAIL/)
    await rightClick(row.querySelector('.msgtext')!)
    await pick('Copy contents')
    assert.equal(clip.writes.length, 1)
    assert.equal(clip.writes[0], body, 'the whole message, past the quote cap')
  } finally { clip.restore(); await m.unmount() }
})

// ────────────────────────────────────── §2b byte-for-byte, not a tidied copy

test('§2b the stored text is copied EXACTLY — indentation and trailing newlines survive', async () => {
  // coordinator-astra review of f910f75: the first cut ran every part through
  // trim(), which silently ate leading indentation and trailing blank lines.
  // For a message whose whole point is its layout — a fenced block, a YAML
  // fragment, a patch — that is not "the complete contents", it is a tidied
  // paraphrase, and pasting it back somewhere indentation-sensitive breaks it.
  const clip = stubClipboard()
  const body = '    four spaces in\n\tand a tab\n\n```\n  code\n```\n\n\n'
  const m = await desk([{ role: 'assistant', text: body, seq: 0, event_id: 'exact-1' }])
  try {
    await rightClick(rowOf(m, 'exact-1').querySelector('.msgtext')!)
    await pick('Copy contents')
    assert.equal(clip.writes[0], body, 'the stored source, byte for byte')
  } finally { clip.restore(); await m.unmount() }
})

test('§2c a segment keeps its own layout, and only distinct parts gain a separator', async () => {
  const indented = '  - one\n  - two\n\n'
  const copied = messageCopyText({ role: 'user', text: 'x', segments: [
    { kind: 'text', text: indented },
  ] } as ChatMessage, 'operator')
  assert.equal(copied, indented, 'one visible segment copies as itself, untouched')
  const two = messageCopyText({ role: 'user', text: 'x', segments: [
    { kind: 'mail', rows: [{ id: 'm', from: 'a', kind: 'message', body: '  from mail\n',
      at: '2026-09-11T17:00:00.000Z' }] },
    { kind: 'text', text: indented },
  ] } as ChatMessage, 'operator')
  assert.equal(two, '  from mail\n' + '\n\n' + indented,
    'two distinct parts keep the blank-line separator AND their own layout')
  // a wholly empty part is still dropped rather than contributing a separator
  assert.equal(messageCopyText({ role: 'user', text: 'x', segments: [
    { kind: 'text', text: '   \n ' },
    { kind: 'text', text: indented },
  ] } as ChatMessage, 'operator'), indented)
})

// ───────────────────────────────────────────── §3 not the rendered DOM

test('§3 a collapsed compaction summary is copied although it is not rendered', async () => {
  const clip = stubClipboard()
  const m = await desk([
    { role: 'system', text: 'Conversation compacted', summary: 'SUMMARY-BEHIND-THE-CLICK',
      seq: 0, event_id: 'sys-1' },
  ])
  try {
    const row = rowOf(m, 'sys-1')
    // the control: the summary is genuinely NOT in the document while folded,
    // so a textContent read could not have found it
    assert.doesNotMatch(row.textContent ?? '', /SUMMARY-BEHIND-THE-CLICK/)
    await rightClick(row.querySelector('.msg.sys')!)
    await pick('Copy contents')
    assert.equal(clip.writes[0], 'Conversation compacted\n\nSUMMARY-BEHIND-THE-CLICK')
  } finally { clip.restore(); await m.unmount() }
})

// ──────────────────────────────────────────────── §4 the envelope stays off

/** the composition an enveloped user turn actually carries */
const enveloped = (extra: Segment[] = []): Segment[] => ([
  { kind: 'state', event: ORG_STATE.private as Event, text: '[ORG STATE — SECRET-MACHINE-CONTEXT]' },
  ...extra,
  { kind: 'mail', rows: [{ id: 'mail-1', from: 'coordinator-astra', kind: 'message',
    body: 'Land it after approval.', at: '2026-09-11T17:00:00.000Z' }] },
  { kind: 'text', text: 'My own words to the agent.' },
] as Segment[])

test('§4 an enveloped user turn copies the visible body, never the machine envelope', async () => {
  const clip = stubClipboard()
  const segments = enveloped()
  const m = await desk([
    { role: 'user', text: '[ORG STATE — SECRET-MACHINE-CONTEXT]\n\nMy own words to the agent.',
      segments, seq: 0, event_id: 'turn-1' },
  ])
  try {
    const row = rowOf(m, 'turn-1')
    assert.ok(row.querySelector('.typed-input'), 'fixture: this turn renders through SegmentList')
    // the control: the row's own `text` — what would be copied by anything
    // reading the message body directly — DOES hold the envelope
    assert.match(row.getAttribute('data-reply-quote') ?? '', /SECRET-MACHINE-CONTEXT/)
    await rightClick(row.querySelector('.turn-mail-batch')!)
    await pick('Copy contents')
    const copied = clip.writes[0]!
    assert.doesNotMatch(copied, /SECRET-MACHINE-CONTEXT/, 'the hidden envelope never reaches the clipboard')
    assert.doesNotMatch(copied, /ORG STATE/)
    assert.equal(copied, 'Land it after approval.\n\nMy own words to the agent.')
  } finally { clip.restore(); await m.unmount() }
})

test('§4b POSITIVE CONTROL: a machine segment the desk SHOWS is copied', async () => {
  // without this, §4 would pass just as well if every state segment were
  // dropped — the gate has to be the desk's own visibility rule, not "state"
  const visible = messageCopyText({ role: 'user', text: 'x',
    segments: enveloped([{ kind: 'state', event: REMINDER.private as Event,
      text: '[AUTOMATIC IDLE DOCKET REMINDER] one item waits' }]) } as ChatMessage, 'operator')
  assert.match(visible, /AUTOMATIC IDLE DOCKET REMINDER/,
    'a human-visible wake is part of the message it drove')
  assert.doesNotMatch(visible, /SECRET-MACHINE-CONTEXT/,
    'and the hidden state beside it still is not')
})

// ──────────────────────────────────────────────────────── §5 granularity

test('§5 the thought and a tool result are their own copy targets', async () => {
  const clip = stubClipboard()
  const m = await desk([
    { role: 'assistant', text: 'Done.', seq: 0, event_id: 'reply-2',
      thinking: 'THE-PRIVATE-REASONING', thinking_event_id: 'think-2', think_secs: 3,
      tools: [{ name: 'Bash', arg: 'ls', event_id: 'tool-2', result_event_id: 'res-2',
        result: 'THE-TOOL-OUTPUT', reply_quote: 'Bash ls' }] },
  ])
  try {
    await rightClick(m.el.querySelector('[data-reply-event="think-2"]')!)
    await pick('Copy contents')
    assert.equal(clip.writes[0], 'THE-PRIVATE-REASONING', 'the thought, not the message')
    // the tool CALL line while its chip is still folded
    await rightClick(m.el.querySelector('[data-reply-event="tool-2"]')!)
    await pick('Copy contents')
    assert.equal(clip.writes[1], 'Bash ls', 'the call line, not the message')
    // the RESULT exists only once the chip is expanded — the chip's fold is
    // conditional rendering, so nothing was hiding in the DOM before this
    assert.equal(m.el.querySelector('[data-reply-event="res-2"]'), null)
    await inAct(() => { (m.el.querySelector('.tline') as HTMLElement).click() })
    await flush(2)
    await rightClick(m.el.querySelector('[data-reply-event="res-2"]')!)
    await pick('Copy contents')
    assert.equal(clip.writes[2], 'THE-TOOL-OUTPUT', 'the result, not the message')
    // …and the message itself still copies only its own body
    await rightClick(rowOf(m, 'reply-2').querySelector('.msgtext')!)
    await pick('Copy contents')
    assert.equal(clip.writes[3], 'Done.')
  } finally { clip.restore(); await m.unmount() }
})

// ───────────────────────────────────────────────────── §6 nothing to copy

test('§6 a row with no message text offers the action DISABLED', async () => {
  const clip = stubClipboard()
  const m = await desk([{ role: 'assistant', text: '', seq: 0, event_id: 'empty-1' }])
  try {
    const row = m.el.querySelector('[data-reply-event="empty-1"]') as HTMLElement
    assert.ok(row, 'fixture: the empty row is still on screen')
    await rightClick(row)
    const item = itemNamed('Copy contents')
    assert.ok(item, 'the action is offered rather than silently missing')
    assert.equal(item!.disabled, true, 'and disabled, because there is nothing to put on the clipboard')
    assert.match(item!.title, /no message text/)
    await pick('Copy contents')
    assert.deepEqual(clip.writes, [], 'a disabled item writes nothing')
  } finally { clip.restore(); await m.unmount() }
})

// ──────────────────────────────────────────── §6b a row with no durable id

test('§6b an undelivered ghost copies the words the user typed', async () => {
  // A ghost is the one row with NOTHING on the server behind it — no id to
  // look up — so its text travels with the press instead. Without this it
  // would be the only message on screen you could not copy.
  const clip = stubClipboard()
  const m = await desk([])
  try {
    await inAct(async () => { addPending('org', 'writer', 'THE-UNSENT-WORDS'); await flush(2) })
    const ghost = m.el.querySelector('.pendghost') as HTMLElement
    assert.ok(ghost, 'fixture: the ghost row is on screen')
    assert.equal(ghost.getAttribute('data-reply-event'), '', 'and it genuinely has no id')
    await rightClick(ghost.querySelector('.turn-mail')!)
    await pick('Copy contents')
    assert.equal(clip.writes[0], 'THE-UNSENT-WORDS')
  } finally { clip.restore(); await m.unmount() }
})

// ────────────────────────────────────────────── §7 an unavailable clipboard

test('§7 an absent clipboard is reported, never reported as a copy', async () => {
  const restore = noClipboard()
  const m = await desk([{ role: 'assistant', text: 'Some text', seq: 0, event_id: 'reply-3' }])
  try {
    await rightClick(rowOf(m, 'reply-3').querySelector('.msgtext')!)
    await pick('Copy contents')
    assert.deepEqual(m.toasts, [['could not copy — clipboard unavailable']])
  } finally { restore(); await m.unmount() }
})

// ─────────────────────────────────────── §8 the interactions that existed

test('§8 a live selection still keeps the browser menu, and Reply still works', async () => {
  const clip = stubClipboard()
  const m = await desk([{ role: 'assistant', text: 'Selectable text', seq: 0, event_id: 'reply-4' }])
  try {
    const body = rowOf(m, 'reply-4').querySelector('.msgtext')!
    const sel = W.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(body)
    sel.removeAllRanges(); sel.addRange(range)
    assert.equal(sel.isCollapsed, false, 'fixture: the selection is live')
    assert.equal(await rightClick(body), false, 'the press is not taken')
    assert.equal(document.querySelector('.ctxmenu'), null,
      'no app menu: ordinary select-and-copy keeps the browser’s own')
    sel.removeAllRanges()
    // …and the pre-existing action is untouched by the new neighbour
    assert.equal(await rightClick(body), true)
    assert.equal(labels()[0], 'Reply')
    await pick('Reply')
    assert.ok(m.el.querySelector('.reply-preview'), 'Reply still starts a reply')
    assert.deepEqual(clip.writes, [], 'and copies nothing on the way')
  } finally { clip.restore(); await m.unmount() }
})
