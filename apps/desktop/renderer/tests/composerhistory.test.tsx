// ARROW-KEY HISTORY IN THE MESSAGE BOX (user request 2026-09-18, design
// settled 2026-09-19). Up and Down walk what you have sent to THIS agent, the
// way PowerShell and bash do, and the unsent-drafts recovery system is retired
// into it.
//
// ⚠ THE ONE CONSTRAINT THAT MUST NOT BE QUIETLY UNDONE, pinned by §1 and its
// negative control: THE HISTORY KEY CARRIES NO GENERATION. The draft key
// beside it does. Copying that here would wipe the history at a compaction,
// rehire or rename — precisely the event this feature exists to rescue you
// from, because that is when a half-written message gets eaten. A history that
// evaporates when the agent is replaced is worse than none, because by then
// the user has learned to rely on it.
//
// The interaction tests below drive the REAL composer through real keydown
// events with a real caret position, not the store functions. "The store can
// step backwards" is not evidence that pressing Up does anything, and the
// caret guard in §5 is the only thing standing between a user writing a
// multi-line message and having it replaced out from under them.

import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'
import { draftKey, preserveRemovedDrafts, renameDrafts, storeAttachments } from '../src/draftstore'
import { storeReply } from '../src/eventReply'
import {
  MAX_ENTRIES, MAX_ENTRY_CHARS, MAX_TOTAL_CHARS,
  absorbStrandedDrafts, historyKey, readHistory, recordSent, recordStranded,
} from '../src/composerhistory'

const W = window as unknown as Window & typeof globalThis

const writer: CanvasNode = {
  id: 'writer', generation: 2, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
}
const desk = (node: CanvasNode = writer) => <DeskChat node={node}
  map={new Map([[node.id, node]])} slug="org"
  op={async () => ({})} toast={() => {}} pub={false} bare />

/** Seed the stored history directly. Entries are OLDEST FIRST, so the last
 *  element is what a single Up must reach. */
const seed = (entries: { text: string; delivered: boolean }[], id = 'writer') =>
  localStorage.setItem(historyKey('org', id), JSON.stringify(entries))

const sent = (...texts: string[]) => texts.map(text => ({ text, delivered: true }))

const box = (el: HTMLElement) => el.querySelector('textarea') as HTMLTextAreaElement

/** Put the caret somewhere and press a key for real. Returns the event so a
 *  test can ask whether the composer CONSUMED it — which is the difference
 *  between "history moved" and "the caret moved". */
async function press(el: HTMLTextAreaElement, key: string, caret?: number, init: KeyboardEventInit = {}) {
  if (caret !== undefined) { el.selectionStart = caret; el.selectionEnd = caret }
  const event = new W.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  await inAct(async () => { el.dispatchEvent(event); await flush(3) })
  return event
}

/** Type into the composer the way a user does — through React's onChange. */
async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!
  await inAct(async () => {
    setter.call(el, value)
    el.dispatchEvent(new W.Event('input', { bubbles: true }))
    await flush(3)
  })
}

async function openDesk(node: CanvasNode = writer) {
  installFetch(new FakeServer())
  const view = await mountView(desk(node), el => el)
  await inAct(async () => { await flush(3) })
  return view
}

// ─────────────────────────────────────────────────────────── §1 the key

test('§1 the history key is per agent and carries NO generation, so a new generation still reads it', () => {
  localStorage.clear()
  recordSent('org', 'writer', 'written at generation 2')

  // The key the feature actually uses, spelled out so a refactor that starts
  // interpolating a generation into it fails here rather than in the field.
  assert.equal(historyKey('org', 'writer'), 'orgtree-composer-history-["org","writer"]')
  assert.ok(!historyKey('org', 'writer').includes('2'), 'no generation anywhere in the key')

  // The same agent, several generations later, reads the same history.
  assert.deepEqual(readHistory('org', 'writer'), [{ text: 'written at generation 2', delivered: true }])

  // NEGATIVE CONTROL: this is what a generation-scoped key would have done.
  // The draft key IS generation-scoped, and at generation 5 it is empty while
  // the history is not. If this assertion ever starts failing because the two
  // behave alike, the constraint above has been undone.
  assert.equal(localStorage.getItem(draftKey('org', 'writer', 5)), null)
  assert.equal(readHistory('org', 'writer').length, 1)

  // And it is per AGENT: another agent in the same org has its own.
  assert.deepEqual(readHistory('org', 'other'), [])
})

test('§1b a rename carries the history with it — same agent, new name', () => {
  localStorage.clear()
  recordSent('org', 'writer', 'before the rename')
  renameDrafts('org', 'writer', 'renamed')
  assert.deepEqual(readHistory('org', 'renamed'), [{ text: 'before the rename', delivered: true }])
  assert.deepEqual(readHistory('org', 'writer'), [], 'and nothing is left under the old name')
})

// ──────────────────────────────────────────────────────── §2 the bounds

test('§2 history is capped by entry count and by total size, evicting oldest first', () => {
  localStorage.clear()
  for (let i = 0; i < MAX_ENTRIES + 20; i++) recordSent('org', 'writer', `message ${i}`)
  const kept = readHistory('org', 'writer')
  assert.equal(kept.length, MAX_ENTRIES, 'the entry cap is a real bound, not a large one')
  assert.equal(kept[kept.length - 1]!.text, `message ${MAX_ENTRIES + 19}`, 'newest survives')
  assert.equal(kept[0]!.text, `message 20`, 'oldest is what was evicted')

  localStorage.clear()
  const big = 'x'.repeat(MAX_ENTRY_CHARS)
  // Four of these exceed the total budget; the newest must still be there.
  for (let i = 0; i < 6; i++) recordSent('org', 'writer', big.slice(0, MAX_ENTRY_CHARS - 1) + String(i))
  const bounded = readHistory('org', 'writer')
  const total = bounded.reduce((sum, e) => sum + e.text.length, 0)
  assert.ok(total <= MAX_TOTAL_CHARS, `stored ${total} chars, budget is ${MAX_TOTAL_CHARS}`)
  assert.ok(bounded[bounded.length - 1]!.text.endsWith('5'), 'the newest message is the one kept')
})

test('§2b one enormous message is refused rather than evicting the whole history', () => {
  localStorage.clear()
  recordSent('org', 'writer', 'worth keeping')
  assert.equal(recordSent('org', 'writer', 'y'.repeat(MAX_ENTRY_CHARS + 1)), false)
  assert.deepEqual(readHistory('org', 'writer'), [{ text: 'worth keeping', delivered: true }],
    'the existing history is untouched by the message that was too big to store')
})

test('§2c repeating the newest message replaces it instead of growing the history', () => {
  localStorage.clear()
  recordStranded('org', 'writer', 'same text')
  recordSent('org', 'writer', 'same text')
  assert.deepEqual(readHistory('org', 'writer'), [{ text: 'same text', delivered: true }],
    'and actually sending it clears the never-delivered mark')
})

// ────────────────────────────────────────────────── §3 Up and Down walk

test('§3 Up walks back most-recent-first and Down walks forward again', async () => {
  localStorage.clear(); resetConvos()
  seed(sent('oldest', 'middle', 'newest'))
  const view = await openDesk()
  try {
    const el = box(view.el)
    assert.equal(el.value, '', 'the composer starts empty')

    assert.equal((await press(el, 'ArrowUp', 0)).defaultPrevented, true, 'Up is consumed by history')
    assert.equal(box(view.el).value, 'newest')
    await press(box(view.el), 'ArrowUp', 0)
    assert.equal(box(view.el).value, 'middle')
    await press(box(view.el), 'ArrowUp', 0)
    assert.equal(box(view.el).value, 'oldest')

    // Past the oldest, nothing moves — the box does not wrap round.
    await press(box(view.el), 'ArrowUp', 0)
    assert.equal(box(view.el).value, 'oldest')

    await press(box(view.el), 'ArrowDown', box(view.el).value.length)
    assert.equal(box(view.el).value, 'middle')
    await press(box(view.el), 'ArrowDown', box(view.el).value.length)
    assert.equal(box(view.el).value, 'newest')
  } finally { await view.unmount(); resetConvos() }
})

test('§3b recall puts the caret at the END of the recalled message', async () => {
  localStorage.clear(); resetConvos()
  seed(sent('a recalled message'))
  const view = await openDesk()
  try {
    const el = box(view.el)
    await press(el, 'ArrowUp', 0)
    const after = box(view.el)
    assert.equal(after.value, 'a recalled message')
    assert.equal(after.selectionStart, 'a recalled message'.length,
      'so the next keystroke appends rather than landing in the middle')
  } finally { await view.unmount(); resetConvos() }
})

test('§3c an empty history leaves Up alone entirely', async () => {
  localStorage.clear(); resetConvos()
  const view = await openDesk()
  try {
    const el = box(view.el)
    await type(el, 'half a thought')
    const event = await press(box(view.el), 'ArrowUp', 0)
    assert.equal(event.defaultPrevented, false, 'nothing to recall, so the key stays the caret\'s')
    assert.equal(box(view.el).value, 'half a thought', 'and what was typed is untouched')
  } finally { await view.unmount(); resetConvos() }
})

// ─────────────────────────────────────── §4 what you typed is not lost

test('§4 text typed but not sent is preserved, and Down past the newest entry brings it back', async () => {
  localStorage.clear(); resetConvos()
  seed(sent('an older message'))
  const view = await openDesk()
  try {
    await type(box(view.el), 'the thing I was actually writing')
    await press(box(view.el), 'ArrowUp', 0)
    assert.equal(box(view.el).value, 'an older message', 'history replaced the box…')

    await press(box(view.el), 'ArrowDown', box(view.el).value.length)
    assert.equal(box(view.el).value, 'the thing I was actually writing',
      '…and stepping forward past the newest entry gives the unsent text back')
  } finally { await view.unmount(); resetConvos() }
})

// ──────────────────────────────── §5 the multi-line caret guard

test('§5 in a multi-line message the arrows move the caret and do NOT replace it', async () => {
  localStorage.clear(); resetConvos()
  seed(sent('history that must not appear'))
  const view = await openDesk()
  try {
    const multi = 'first line\nsecond line\nthird line'
    await type(box(view.el), multi)

    // Caret on the SECOND line: Up is the caret's, not history's.
    const up = await press(box(view.el), 'ArrowUp', multi.indexOf('second'))
    assert.equal(up.defaultPrevented, false, 'the composer did not consume it')
    assert.equal(box(view.el).value, multi, 'and the message is still there')

    // Caret on the SECOND line: Down is the caret's too.
    const down = await press(box(view.el), 'ArrowDown', multi.indexOf('second'))
    assert.equal(down.defaultPrevented, false)
    assert.equal(box(view.el).value, multi)

    // POSITIVE CONTROL: from the FIRST line, the same key does recall — so the
    // two assertions above are the guard working, not history being broken.
    const first = await press(box(view.el), 'ArrowUp', 3)
    assert.equal(first.defaultPrevented, true)
    assert.equal(box(view.el).value, 'history that must not appear')
  } finally { await view.unmount(); resetConvos() }
})

test('§5b a selection, and a modified arrow, are never history', async () => {
  localStorage.clear(); resetConvos()
  seed(sent('history that must not appear'))
  const view = await openDesk()
  try {
    await type(box(view.el), 'one line only')
    const el = box(view.el)

    // Shift+Up is "extend the selection upwards", in every text box there is.
    const shifted = await press(el, 'ArrowUp', 0, { shiftKey: true })
    assert.equal(shifted.defaultPrevented, false)
    assert.equal(box(view.el).value, 'one line only')

    // A live selection means the user is selecting, not navigating.
    el.selectionStart = 0; el.selectionEnd = 3
    const spanning = new W.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    await inAct(async () => { el.dispatchEvent(spanning); await flush(3) })
    assert.equal(spanning.defaultPrevented, false)
    assert.equal(box(view.el).value, 'one line only')
  } finally { await view.unmount(); resetConvos() }
})

// ───────────────────────────── §6 history is a record, not a buffer

test('§6 editing a recalled message leaves the stored history entry untouched', async () => {
  localStorage.clear(); resetConvos()
  seed(sent('the original wording'))
  const view = await openDesk()
  try {
    await press(box(view.el), 'ArrowUp', 0)
    assert.equal(box(view.el).value, 'the original wording')
    await type(box(view.el), 'the original wording, heavily edited')

    assert.deepEqual(readHistory('org', 'writer'), [{ text: 'the original wording', delivered: true }],
      'the stored entry is what was SENT and editing the box does not rewrite it')
  } finally { await view.unmount(); resetConvos() }
})

// ────────────────────── §7 messages eaten by an agent state change

test('§7 a draft stranded by a generation change lands in the history and Up reaches it', async () => {
  localStorage.clear(); resetConvos()
  // A draft written at generation 2, and the agent has since moved to 3.
  localStorage.setItem(draftKey('org', 'writer', 2), 'the message that got eaten')
  const view = await openDesk({ ...writer, generation: 3 })
  try {
    assert.deepEqual(readHistory('org', 'writer'),
      [{ text: 'the message that got eaten', delivered: false }],
      'absorbed on mount, and marked as never delivered')
    assert.equal(localStorage.getItem(draftKey('org', 'writer', 2)), null, 'the stale draft key is gone')

    await press(box(view.el), 'ArrowUp', 0)
    assert.equal(box(view.el).value, 'the message that got eaten', 'and Up reaches it like anything else')

    // Marked, not silently mixed in with things that were actually sent.
    assert.match(view.el.textContent!, /this message was never sent/)
  } finally { await view.unmount(); resetConvos() }
})

test('§7b the CURRENT generation\'s draft is never eaten', async () => {
  localStorage.clear(); resetConvos()
  localStorage.setItem(draftKey('org', 'writer', 2), 'still being written')
  const view = await openDesk()
  try {
    assert.deepEqual(readHistory('org', 'writer'), [], 'nothing was absorbed')
    assert.equal(box(view.el).value, 'still being written', 'and it is still in the composer')
  } finally { await view.unmount(); resetConvos() }
})

test('§7c a draft belonging to a node that left the org goes into that agent\'s history', () => {
  localStorage.clear()
  const key = draftKey('org', 'writer', 2)
  localStorage.setItem(key, 'written to an agent that was then retired')
  storeAttachments(key, [{ name: 'note.txt', path: 'note.txt', bytes: 4 }])
  storeReply(key, { org: 'org', agent: 'writer', generation: 2, eventId: 'e1', quote: 'q' })

  preserveRemovedDrafts('org', new Map())

  assert.deepEqual(readHistory('org', 'writer'),
    [{ text: 'written to an agent that was then retired', delivered: false }])
  // Recall is TEXT ONLY (decision 2): a recalled attachment can point at a
  // file since deleted, and something that looks ready to send and is not is
  // worse than nothing. So the sibling keys are cleared, not carried.
  assert.equal(localStorage.getItem(key), null)
  assert.equal(localStorage.getItem(`${key}-attachments`), null)
  assert.equal(localStorage.getItem(`${key}-reply`), null)
})

// ───────────────────────── §8 the old recovery surfaces are retired

test('§8 the old recovery keys are migrated into history, not stranded, and the panel is gone', async () => {
  localStorage.clear(); resetConvos()
  // Exactly what an existing installation has sitting in localStorage.
  localStorage.setItem('orgtree-draft-recovery-["org","writer",1]', 'stranded at generation 1')
  localStorage.setItem(draftKey('org', 'writer', 2), 'stranded at generation 2')
  localStorage.setItem('orgtree-draft-["org","writer"]-ignored', 'not this key')
  localStorage.setItem('orgtree-draft-org-writer', 'the pre-generation draft')
  localStorage.setItem('orgtree-draft-recovery-dismissed-["org","writer"]', '[1]')

  const view = await openDesk({ ...writer, generation: 3 })
  try {
    assert.deepEqual(readHistory('org', 'writer').map(e => e.text),
      ['the pre-generation draft', 'stranded at generation 1', 'stranded at generation 2'],
      'oldest first, so Up reaches the most recent first')
    assert.ok(readHistory('org', 'writer').every(e => !e.delivered), 'none of them was ever sent')

    for (const gone of [
      'orgtree-draft-recovery-["org","writer",1]',
      draftKey('org', 'writer', 2),
      'orgtree-draft-org-writer',
      'orgtree-draft-recovery-dismissed-["org","writer"]',
    ]) assert.equal(localStorage.getItem(gone), null, `${gone} must not survive the migration`)

    // The two surfaces the ticket retires must not render, even though the
    // storage they used to read was populated a moment ago.
    assert.doesNotMatch(view.el.textContent!, /Older unsent drafts/)
    assert.doesNotMatch(view.el.textContent!, /An older saved draft is available/)
    assert.doesNotMatch(view.el.textContent!, /Restore draft/)
    assert.equal(view.el.querySelector('.popout-draft-recovery'), null)
  } finally { await view.unmount(); resetConvos() }
})

test('§8b absorbing is idempotent — a remount cannot duplicate an entry', () => {
  localStorage.clear()
  localStorage.setItem(draftKey('org', 'writer', 1), 'absorbed once')
  assert.equal(absorbStrandedDrafts('org', 'writer', 2), 1)
  assert.equal(absorbStrandedDrafts('org', 'writer', 2), 0, 'the second pass finds nothing left')
  assert.equal(absorbStrandedDrafts('org', 'writer', 2), 0)
  assert.deepEqual(readHistory('org', 'writer'), [{ text: 'absorbed once', delivered: false }])
})

test('§8c a stale draft with attachments but no text still gets its keys cleared', () => {
  localStorage.clear()
  const stale = draftKey('org', 'writer', 1)
  storeAttachments(stale, [{ name: 'a.txt', path: 'a.txt', bytes: 1 }])
  assert.equal(absorbStrandedDrafts('org', 'writer', 2), 0, 'no text, so nothing to recall')
  assert.equal(localStorage.getItem(`${stale}-attachments`), null, 'but the orphan key does not live forever')
})

// ───────────────────────────────────────────── §9 sending feeds history

test('§9 sending a message appends it to the history and returns to the newest end', async () => {
  localStorage.clear(); resetConvos()
  seed(sent('an earlier message'))
  const view = await openDesk()
  try {
    await type(box(view.el), 'a brand new message')
    await press(box(view.el), 'Enter')
    await inAct(async () => { await flush(6) })

    assert.equal(box(view.el).value, '', 'the composer clears on send')
    assert.deepEqual(readHistory('org', 'writer').map(e => e.text),
      ['an earlier message', 'a brand new message'])
    assert.ok(readHistory('org', 'writer').every(e => e.delivered))

    // Position reset to the newest: one Up is the message just sent.
    await press(box(view.el), 'ArrowUp', 0)
    assert.equal(box(view.el).value, 'a brand new message')
  } finally { await view.unmount(); resetConvos() }
})
