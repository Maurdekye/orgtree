// eventdedup.test.tsx — THE RENDER-BOUNDARY DUPLICATE GUARD (user request
// 2026-09-11: "intermittent double messages persist ... a final guard
// preventing a second rendered event with the same ID, even if the upstream
// duplicate source is unknown").
//
// The rule under test, and nothing wider:
//
//     within ONE view, one stable event id renders at most once.
//
// Everything here is counted STRUCTURALLY off the mounted desk — the rows
// carry their identity in `data-reply-event` and `data-native-event`, so a
// duplicate is a repeated attribute value, not a guess about the text.
//
// ⚠ WHICH ID IS WHICH, because a leg that compares the wrong one proves
// nothing (this suite has had that defect twice, both times found in review):
//   · `native_event_id` is the CLI/journal RECORD uuid. It identifies the
//     EVENT, never changes, and is the SAME string on a transcript row and on
//     its live twin — the singular durable id the user asked for.
//   · `event_id` is what reply_events._annotate puts on the wire: a snapshot
//     id hashed over the incarnation, the source AND THE QUOTED TEXT. Two
//     reads of one row whose text moved on arrive under DIFFERENT event_ids.
//     A live row and its durable twin never share one, their quotes differing
//     because the live copy is the capped one.
// So fixtures carry realistic `reply_…` event_ids and put the shared uuid
// where the backend really puts it. §7d is the leg that exists because an
// earlier draft deduplicated on the reply id alone and rendered both.
//
// ⚠ ANTI-VACUITY. A dedup suite passes trivially if its fixtures contain no
// duplicate to remove, so every suppression leg is paired with proof that the
// duplicate was really there:
//   · §7/§7b/§7d assert the STORE holds two rows for one event while the VIEW
//     shows one — the fixture is the real scrollback path through the real
//     store, not a hand-placed pair.
//   · §2/§3/§6/§7e/§11 are the controls in the other direction: identical text
//     under different ids, rows with no id at all, and distinct durable ids
//     must ALL still render. They fail if the guard ever widens into text
//     matching or treats "no id" as an identity.
//   · §7f fails if deduplicating costs a working reply link.
//   · §8 fails if the id set is ever shared between views.
//
// ⚠ DECLARED LIMIT. §5 drives a live row carrying a transcript row's *reply*
// id, which the wire cannot actually produce (the quote is in that hash). It
// exercises the guard's mechanism across the stream/history boundary; §10 is
// the leg for the shape the backend really sends. Said plainly rather than
// left to read as coverage it is not.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs eventdedup

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useEffect } from 'react'
import { loadOlder, refreshConvo, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'
import { eventDedup } from '../src/events/dedup'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import type { ChatMessage, OpResult } from '../src/types'

let _n = 0
const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const SL = 'org'

function node(id: string): CanvasNode {
  return {
    id, state: 'live', tier: 'haiku', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'haiku',
  } as CanvasNode
}

const deskEl = (nd: CanvasNode) =>
  <DeskChat node={nd} map={new Map([[nd.id, nd]])} op={op} slug={SL}
    toast={noop} pub={false} bare />

/** the store, beside the desk — so a test can assert what the VIEW shows
 *  against what the MODEL holds, which is what makes the suppression legs
 *  non-vacuous (the duplicate is proven present before it is proven absent) */
function Sink({ nid, sink }: { nid: string; sink: Convo[] }) {
  const c = useConvo(SL, nid)
  useEffect(() => { if (!c.loaded) void refreshConvo(SL, nid) }, [nid, c.loaded])
  sink.push(c)
  return null
}

// ------------------------------------------------------------- structure
/** identity of every durable transcript row on screen, in render order */
const rowIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('[data-transcript-row]')]
    .map((r) => r.getAttribute('data-reply-event') ?? '')

/** identity of every LIVE row on screen (the live tail wraps in .reply-event,
 *  which durable rows never carry) */
const liveIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('.reply-event[data-reply-event]')]
    .map((r) => r.getAttribute('data-reply-event') ?? '')
    .filter(Boolean)

const says = (el: HTMLElement, needle: string): number =>
  (el.textContent ?? '').split(needle).length - 1

const dup = (ids: string[]): string[] =>
  ids.filter((id, i) => id && ids.indexOf(id) !== i)

function domTest(name: string, body: (k: { ND: string; s: FakeServer;
  sink: Convo[];
  mount: (el: React.ReactElement) => Promise<HTMLElement> }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const ND = `ed${++_n}`
    const s = new FakeServer()
    installFetch(s)
    const sink: Convo[] = []
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      resetConvos()
      realClock()
    })
    await body({ ND, s, sink, mount: async (el) => {
      const v = await mountView(el, (host) => host)
      open.push(v)
      return v.el
    } })
  })
}

/** an assistant row with an explicit stable id — what `_stable_event_id`
 *  stamps on every row `node_chat` projects */
const row = (s: FakeServer, text: string, event_id: string,
             extra: Partial<ChatMessage> = {}): ChatMessage =>
  s.assistantMsg(text, { event_id, ...extra })

// =========================================================== the unit rule
test('§0 the pass itself: repeats collapse, unknowns never do', () => {
  const d = eventDedup()
  assert.equal(d.keep('a'), true)
  assert.equal(d.keep('a'), false, 'the same id twice is one render')
  assert.equal(d.keep('b'), true, 'a different id is a different event')
  assert.equal(d.keep(undefined), true)
  assert.equal(d.keep(undefined), true, 'two missing ids are not one event')
  assert.equal(d.keep(''), true)
  assert.equal(d.keep(''), true, 'an empty id is missing, not an identity')
  assert.equal(d.keep(7), true, 'a non-string id is unreadable, so it renders')
  assert.equal(d.dropped, 1)
  // ordered across lists, first occurrence wins
  const a = d.list([{ id: 'x' }, { id: 'y' }], (r) => r.id)
  const b = d.list([{ id: 'y' }, { id: 'z' }], (r) => r.id)
  assert.deepEqual(a.map((r) => r.id), ['x', 'y'])
  assert.deepEqual(b.map((r) => r.id), ['z'], 'y was already drawn by the first list')
  // WITHIN one list: first position, newest content
  const d2 = eventDedup()
  const merged = d2.list(
    [{ id: 'p', v: 'stale' }, { id: 'q', v: 'other' }, { id: 'p', v: 'fresh' }],
    (r) => r.id)
  assert.deepEqual(merged, [{ id: 'p', v: 'fresh' }, { id: 'q', v: 'other' }],
    'the later snapshot renders, in the earlier one’s place')
  // ACROSS lists: the earlier list wins outright, content and all
  assert.deepEqual(d2.list([{ id: 'p', v: 'from a later source' }], (r) => r.id), [],
    'a second list never overwrites what the first already drew')
  // and two passes never see each other
  assert.equal(eventDedup().keep('x'), true)
})

// ======================================================== the transcript
domTest('§1 one event id renders once, however many times the payload carries it',
  async ({ ND, s, sink, mount }) => {
    row(s, 'alpha', 'e-alpha')
    row(s, 'the doubled message', 'e-dup')
    row(s, 'the doubled message', 'e-dup')      // the same event, twice
    row(s, 'omega', 'e-omega')
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    // the model really holds two — this is the duplicate, present
    assert.equal(sink.at(-1)!.chat!.messages.filter((m) => m.event_id === 'e-dup').length,
      2, 'fixture: the payload carries the event twice')
    // the view shows one
    assert.deepEqual(rowIds(el), ['e-alpha', 'e-dup', 'e-omega'])
    assert.equal(says(el, 'the doubled message'), 1, 'once on screen, not twice')
    // and nothing else was swallowed
    assert.equal(says(el, 'alpha'), 1)
    assert.equal(says(el, 'omega'), 1)
  })

domTest('§2 identical text under different ids is two messages, and both render',
  async ({ ND, s, sink, mount }) => {
    // the anti-text-dedup control. A user who sends "continue" twice, or an
    // agent that answers the same word twice, must see both.
    row(s, 'continue', 'e-1')
    row(s, 'continue', 'e-2')
    row(s, 'continue', 'e-3')
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    assert.deepEqual(rowIds(el), ['e-1', 'e-2', 'e-3'])
    assert.equal(says(el, 'continue'), 3, 'three distinct events, three rows')
  })

domTest('§3 rows with no event id are never collapsed together',
  async ({ ND, s, sink, mount }) => {
    // missing is "unknown", not "the same as the last unknown" — a legacy or
    // id-less row must never disappear because another id-less row preceded it
    s.assistantMsg('anonymous words')
    s.assistantMsg('anonymous words')
    row(s, 'identified', 'e-id')
    s.assistantMsg('anonymous words')
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    assert.equal(el.querySelectorAll('[data-transcript-row]').length, 4,
      'all four rows render')
    assert.equal(says(el, 'anonymous words'), 3, 'three id-less rows, three renders')
  })

domTest('§4 the guard holds no state across renders: content still evolves',
  async ({ ND, s, sink, mount }) => {
    // "don't lose evolving content or tool results": the surviving row is
    // re-read from the payload every render, so a row whose text grows or
    // whose tool result lands keeps changing on screen under the same id.
    const live = row(s, 'partial answ', 'e-grow')
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    assert.equal(says(el, 'partial answ'), 1)
    await inAct(async () => {
      live.text = 'partial answer, now complete'
      live.tools = [{ id: 't-1', name: 'Bash', arg: 'ran the suite',
        event_id: 'tool-evt-1' }] as never
      // and the payload doubles the grown row for good measure
      s.messages.push({ ...live })
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })
    assert.equal(sink.at(-1)!.chat!.messages.filter((m) => m.event_id === 'e-grow').length,
      2, 'fixture: still doubled after the update')
    assert.deepEqual(rowIds(el), ['e-grow'], 'still one row')
    assert.equal(says(el, 'partial answer, now complete'), 1, 'and it carries the NEW text')
    assert.equal(el.querySelectorAll('.tchip').length, 1,
      'the tool chip that landed later is on screen — exactly once')
    assert.equal(says(el, 'ran the suite'), 1)
  })

// ===================================================== stream / history
domTest('§5 a live row sharing a transcript id renders once — the durable copy',
  async ({ ND, s, sink, mount }) => {
    // ⚠ DECLARED INERT TODAY: `supervisor.live_row` mints its own
    // `live:<boot>:…:<n>` id and no call site overrides it, so the two lists
    // are different id namespaces and this pair cannot arise from the current
    // backend. The leg exists because the guard must hold if one ever does —
    // and because the user asked for the guard regardless of source.
    row(s, 'the whole durable answer, every word of it', 'e-same')
    s.live.push({ kind: 'text', text: 'the whole durable answ',
      truncated: true, event_id: 'e-same', n: 1 } as never)
    s.live.push({ kind: 'text', text: 'a genuinely different live row',
      event_id: 'live:b:org:x:2', n: 2 } as never)
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    assert.equal(sink.at(-1)!.live.length, 2, 'fixture: the server sent two live rows')
    assert.deepEqual(rowIds(el), ['e-same'])
    assert.deepEqual(liveIds(el), ['live:b:org:x:2'],
      'the live twin of a rendered transcript row is suppressed; the other survives')
    assert.equal(says(el, 'the whole durable answer, every word of it'), 1,
      'and the copy that survived is the untruncated durable one')
    assert.equal(says(el, '✂'), 0, 'so no truncation marker is on screen')
  })

domTest('§6 distinct live rows all render (the live-tail control)',
  async ({ ND, s, sink, mount }) => {
    row(s, 'durable', 'e-d')
    s.live.push({ kind: 'text', text: 'live one', event_id: 'live:b:org:x:1', n: 1 } as never)
    s.live.push({ kind: 'text', text: 'live two', event_id: 'live:b:org:x:2', n: 2 } as never)
    s.live.push({ kind: 'text', text: 'live one', event_id: 'live:b:org:x:3', n: 3 } as never)
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    assert.deepEqual(liveIds(el),
      ['live:b:org:x:1', 'live:b:org:x:2', 'live:b:org:x:3'])
    assert.equal(says(el, 'live one'), 2,
      'two live rows with the same words are two rows')
  })

// ============================================ the path that really reaches
domTest('§7 scrollback across a mid-history renumber: the store doubles, the view does not',
  async ({ ND, s, sink, mount }) => {
    // THE REACHABLE DUPLICATE, driven through the real store — no hand-placed
    // pair. `refreshConvo` joins retained scrollback to the fresh window by
    // `seq` alone (convo.ts: `messages.filter(row => row.seq < first)`), and
    // `seq` is a PRE-SLICE ordinal that shifts when a row is inserted earlier
    // in history — which `node_chat` does every time it interleaves a
    // synthetic steered row by timestamp. A row retained under its old seq
    // then reappears in the fresh window under its new one. Its event id is
    // unchanged (`_stable_event_id` excludes `seq` from the hash), so the
    // model holds one event twice.
    s.cursorPages = true
    for (let i = 0; i < 20; i++) row(s, `row ${i}`, `e${i}`)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await advance(100)
    assert.equal(sink.at(-1)!.chat!.messages.length, 8, 'fixture: the first window')

    await inAct(() => { assert.equal(loadOlder(SL, ND, 8), true) })
    await advance(100)
    assert.equal(sink.at(-1)!.chat!.messages.length, 16, 'fixture: scrollback retained')

    // a row lands earlier in history and every later seq shifts by one
    await inAct(async () => {
      for (const m of s.messages) m.seq = (m.seq ?? 0) + 1
      s.messages.unshift({ role: 'user', text: 'the interleaved steer', seq: 0,
        ts: new Date(Date.now()).toISOString(), event_id: 'e-steer' } as ChatMessage)
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })

    const held = sink.at(-1)!.chat!.messages
    const doubled = held.filter((m) => m.event_id === 'e12')
    assert.equal(doubled.length, 2,
      'fixture: the store really holds one event twice (seq ' +
      doubled.map((m) => m.seq).join(' and ') + ')')
    assert.notEqual(doubled[0]!.seq, doubled[1]!.seq, 'under two different seqs')

    const ids = rowIds(el)
    assert.deepEqual(dup(ids), [], `no id renders twice (${ids.join(',')})`)
    assert.equal(says(el, 'row 12'), 1, 'the doubled message is on screen once')
    assert.equal(says(el, 'row 13'), 1, 'its neighbours are untouched')
    assert.equal(says(el, 'row 11'), 1)
  })

domTest('§7b the surviving copy is the FRESH one: a stale scrollback snapshot never pins old content',
  async ({ ND, s, sink, mount }) => {
    // coordinator-astra review 2026-09-11: §7 proved the duplicate is removed,
    // but not WHICH copy survives. The retained scrollback copy is joined
    // AHEAD of the fresh window, so keeping the first copy outright would pin
    // the older snapshot and hide text and tool results that landed since.
    // Same real-store path as §7 — the only difference is that the fresh copy
    // has moved on while the retained one has not.
    s.cursorPages = true
    for (let i = 0; i < 20; i++) row(s, `row ${i}`, `e${i}`)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await advance(100)
    await inAct(() => { assert.equal(loadOlder(SL, ND, 8), true) })
    await advance(100)
    const retained = sink.at(-1)!.chat!.messages.find((m) => m.event_id === 'e12')!
    assert.equal(retained.text, 'row 12', 'fixture: the retained snapshot says the old text')
    assert.equal(retained.tools, undefined, 'fixture: and carries no tool yet')

    await inAct(async () => {
      // the row moves on server-side: its text completes and a tool lands
      const fresh = s.messages.find((m) => m.event_id === 'e12')!
      fresh.text = 'row 12, finished and revised'
      fresh.tools = [{ id: 't-12', name: 'Bash', arg: 'the late tool result',
        event_id: 'tool-evt-12' }] as never
      // …and a row lands earlier in history, shifting every later seq by one,
      // which is what makes the retained copy reappear under a new seq
      for (const m of s.messages) m.seq = (m.seq ?? 0) + 1
      s.messages.unshift({ role: 'user', text: 'the interleaved steer', seq: 0,
        ts: new Date(Date.now()).toISOString(), event_id: 'e-steer' } as ChatMessage)
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })

    const held = sink.at(-1)!.chat!.messages.filter((m) => m.event_id === 'e12')
    assert.equal(held.length, 2, 'fixture: the store holds both snapshots')
    assert.deepEqual(held.map((m) => m.text).sort(),
      ['row 12', 'row 12, finished and revised'].sort(),
      'fixture: and they genuinely DIFFER — one stale, one fresh')

    const ids = rowIds(el)
    assert.deepEqual(dup(ids), [], `still no id renders twice (${ids.join(',')})`)
    assert.equal(says(el, 'row 12, finished and revised'), 1,
      'the FRESH text is what renders')
    assert.equal(says(el, 'the late tool result'), 1,
      'and the tool result that landed after the stale snapshot is on screen')
    assert.equal(el.querySelectorAll('.tchip').length, 1, 'exactly one chip')
    // …at the position the reader already expects the row, not moved down
    assert.equal(ids.indexOf('e12'), ids.indexOf('e11') + 1,
      'and it is still between its neighbours')
    assert.equal(ids.indexOf('e13'), ids.indexOf('e12') + 1)
  })

domTest('§7c across lists the EARLIER source still wins: a truncated live twin never overwrites',
  async ({ ND, s, sink, mount }) => {
    // the other half of the §7b rule, and its guard against over-correcting:
    // "newest copy wins" is true WITHIN one list (two snapshots of one row),
    // and false ACROSS lists (two sources, one of them deliberately cut).
    // ⚠ same caveat as §5: this pair shares a REPLY id, which the wire cannot
    // produce. §10 is the leg for the shape the backend really sends.
    row(s, 'the whole durable answer, every word of it', 'e-same')
    s.live.push({ kind: 'text', text: 'the whole durable answ',
      truncated: true, event_id: 'e-same', n: 1 } as never)
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    assert.equal(says(el, 'the whole durable answer, every word of it'), 1)
    assert.equal(liveIds(el).length, 0, 'the live twin is gone, not promoted')
    assert.equal(says(el, '✂'), 0, 'no truncation marker — the whole text survived')
  })

domTest('§7d THE REAL WIRE: one event, two reply ids, one native id — one row, the fresh one',
  async ({ ND, s, sink, mount }) => {
    // coordinator-astra review 2026-09-11, and the defect that survived my
    // first two rounds. §7/§7b give both snapshots the SAME event_id, which is
    // only what the wire carries when the row's TEXT did not move. It usually
    // does: reply_events._annotate hashes the quoted text INTO event_id, so a
    // stale scrollback copy and the fresh read of the same row arrive under
    // DIFFERENT reply ids. Deduplicating on event_id alone renders both — the
    // doubled message being reported. Their `native_event_id` (the CLI record
    // uuid) is identical, and that is what has to decide.
    s.cursorPages = true
    for (let i = 0; i < 20; i++) {
      row(s, `row ${i}`, `reply_${i}_v1`, { native_event_id: `uu-${i}` } as never)
    }
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await advance(100)
    await inAct(() => { assert.equal(loadOlder(SL, ND, 8), true) })
    await advance(100)
    const retained = sink.at(-1)!.chat!.messages.find((m) => m.native_event_id === 'uu-12')!
    assert.equal(retained.event_id, 'reply_12_v1', 'fixture: the stale snapshot')

    await inAct(async () => {
      // the row moves on: new text, a tool lands — and because the quote is in
      // the hash, the projection issues it a NEW reply id
      const fresh = s.messages.find((m) => m.native_event_id === 'uu-12')!
      fresh.text = 'row 12, finished and revised'
      fresh.event_id = 'reply_12_v2'
      fresh.tools = [{ id: 't-12', name: 'Bash', arg: 'the late tool result',
        event_id: 'tool-evt-12' }] as never
      // …and a row lands earlier in history, shifting every later seq by one,
      // which is what puts the retained copy beside the fresh one
      for (const m of s.messages) m.seq = (m.seq ?? 0) + 1
      s.messages.unshift({ role: 'user', text: 'the interleaved steer', seq: 0,
        ts: new Date(Date.now()).toISOString(), event_id: 'reply_steer',
        native_event_id: 'uu-steer' } as ChatMessage)
      await refreshConvo(SL, ND, { force: true })
      await flush()
    })

    const held = sink.at(-1)!.chat!.messages.filter((m) => m.native_event_id === 'uu-12')
    assert.equal(held.length, 2, 'fixture: the store holds both snapshots')
    assert.deepEqual(held.map((m) => m.event_id).sort(),
      ['reply_12_v1', 'reply_12_v2'],
      'fixture: and they arrive under DIFFERENT reply ids, as the wire does')

    const ids = rowIds(el)
    assert.deepEqual(dup(ids), [], `no event renders twice (${ids.join(',')})`)
    assert.equal(ids.filter((id) => id.startsWith('reply_12_')).length, 1,
      'exactly one row for that event')
    assert.equal(says(el, 'row 12, finished and revised'), 1, 'and it is the FRESH copy')
    assert.equal(says(el, 'the late tool result'), 1, 'carrying what landed since')
    assert.equal(says(el, 'row 12'), 1, 'the stale copy is not also on screen')
    // the surviving row carries the FRESH reply id, so replying to it targets
    // the snapshot the server most recently issued
    const survivor = [...el.querySelectorAll('[data-transcript-row]')]
      .find((r) => r.getAttribute('data-native-event') === 'uu-12')!
    assert.ok(survivor, 'and it is anchored by its durable id')
    assert.equal(survivor.getAttribute('data-reply-event'), 'reply_12_v2')
    // …still between its neighbours
    assert.equal(ids.indexOf('reply_12_v2'), ids.indexOf('reply_11_v1') + 1)
    assert.equal(ids.indexOf('reply_13_v1'), ids.indexOf('reply_12_v2') + 1)
  })

domTest('§7e distinct native ids are distinct events, however alike they look',
  async ({ ND, s, sink, mount }) => {
    // the control for §7d. If the durable rule ever widened — matching on a
    // prefix, on text, on a missing id — this is what catches it. Same words,
    // same everything except the identity.
    row(s, 'identical words', 'reply_a', { native_event_id: 'uu-a' } as never)
    row(s, 'identical words', 'reply_b', { native_event_id: 'uu-b' } as never)
    // …and a pair with no durable id at all, which must fall back to the
    // reply id rather than collapsing into one "unknown"
    row(s, 'identical words', 'reply_c')
    row(s, 'identical words', 'reply_d')
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    assert.deepEqual(rowIds(el), ['reply_a', 'reply_b', 'reply_c', 'reply_d'],
      'four events, four rows')
    assert.equal(says(el, 'identical words'), 4)
  })

domTest('§7f a reply naming the snapshot that was deduplicated away still finds its row',
  async ({ ND, s, sink, mount }) => {
    // deduplicating must not cost a working reply link (coordinator-astra
    // review, 2026-09-11). A reply stored against the STALE snapshot's reply
    // id has no row under that name any more — but the same EVENT is on
    // screen under the fresh one, and that is where it must go.
    const located: string[] = []
    row(s, 'the answer being replied to', 'reply_old',
      { native_event_id: 'uu-target' } as never)
    row(s, 'the answer being replied to, revised', 'reply_new',
      { native_event_id: 'uu-target' } as never)
    row(s, 'the reply itself', 'reply_child', {
      native_event_id: 'uu-child',
      reply_to: { source_event_ref: { org: SL, agent: ND, generation: 0,
        eventId: 'reply_old' }, quoted_context: 'the answer being replied to' },
    } as never)
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    // the target event renders ONCE, under its fresh reply id
    const target = [...el.querySelectorAll('[data-transcript-row]')]
      .filter((r) => r.getAttribute('data-native-event') === 'uu-target')
    assert.equal(target.length, 1, 'one row for the replied-to event')
    assert.equal(target[0]!.getAttribute('data-reply-event'), 'reply_new')
    // the reply chip is OFFERED, because the stale id is still a known source
    const button = el.querySelector<HTMLButtonElement>('.reply-preview-head button')!
    assert.ok(button, 'the reply preview is rendered')
    assert.equal(button.disabled, false,
      'and it is not greyed out just because its exact snapshot was collapsed')
    // clicking it lands on the surviving row rather than nowhere
    const win = el.ownerDocument.defaultView as unknown as
      { Element: { prototype: { scrollIntoView?: unknown } } }
    const original = win.Element.prototype.scrollIntoView
    win.Element.prototype.scrollIntoView = function (this: Element) {
      located.push(this.getAttribute('data-native-event')
        ?? this.getAttribute('data-reply-event') ?? '?')
    }
    try { await inAct(async () => { button.click() }) }
    finally { win.Element.prototype.scrollIntoView = original }
    assert.deepEqual(located, ['uu-target'],
      'the reply resolved through the durable id to the surviving snapshot')
  })

// ============================================== the shared durable identity
//
// ⚠ THE WIRE SHAPE MATTERS HERE, and getting it wrong makes these legs
// vacuous. `event_id` does NOT reach the client intact: reply_events._annotate
// replaces every row's with a reply-snapshot id hashed over the incarnation,
// the source AND the quoted text — so a live row and its durable twin can
// never match on it, even sharing one source, because the live copy is capped
// and its quote differs. The id they DO share arrives as `native_event_id` on
// both sides. These fixtures therefore carry a realistic `reply_…` event_id on
// every row and put the shared uuid where the backend really puts it.

domTest('§10 a live row is suppressed by the transcript row that shares its DURABLE id',
  async ({ ND, s, sink, mount }) => {
    // THE POINT OF THE WHOLE FIX (user ruling 2026-09-11: "live rows and
    // transcript rows need a singular durable id that can cross-identify
    // them"). The emitter stamps the record uuid on the live row, read_chat
    // stamps it on the transcript row, and the projection carries it across.
    const UU = '3f1c4a6e-9b2d-4e77-8a10-55c9e0d21b44'
    row(s, 'the whole durable answer, every word of it', 'reply_aaa',
      { native_event_id: UU } as never)
    // the live twin as the backend really sends it: its OWN reply id, the
    // SHARED uuid, and the capped text
    s.live.push({ kind: 'text', text: 'the whole durable answ', truncated: true,
      event_id: 'reply_bbb', native_event_id: UU, n: 7 } as never)
    // …beside a live row of the same turn that has no durable twin yet, so it
    // never got a native id at all
    s.live.push({ kind: 'text', text: 'still streaming this one',
      event_id: 'reply_ccc', n: 8 } as never)
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    assert.equal(sink.at(-1)!.live.length, 2,
      'fixture: the server really sent both live rows (its own sweep missed)')
    assert.deepEqual(rowIds(el), ['reply_aaa'], 'the durable row renders')
    assert.deepEqual(liveIds(el), ['reply_ccc'],
      'its live twin is gone by shared identity; the unpaired row stays')
    assert.equal(says(el, 'the whole durable answer, every word of it'), 1)
    assert.equal(says(el, 'still streaming this one'), 1)
    assert.equal(says(el, '✂'), 0, 'no truncated copy left on screen')
    // …and the ids they are keyed on are genuinely DIFFERENT, so nothing here
    // could have been caught by the plain event_id rule
    assert.notEqual('reply_aaa', 'reply_bbb')
  })

domTest('§11 a durable id never suppresses a DIFFERENT event, and absent ones pair nothing',
  async ({ ND, s, sink, mount }) => {
    // the anti-vacuity control for §10, in every direction that matters.
    const UU = '3f1c4a6e-9b2d-4e77-8a10-55c9e0d21b44'
    const OTHER = '7d2e5b81-1111-4222-9333-44445555a666'
    row(s, 'first durable', 'reply_aaa', { native_event_id: UU } as never)
    // a row whose source record had no uuid — legacy journals, and the
    // synthetic steered rows read_chat invents
    row(s, 'second durable, no native id', 'reply_ddd')
    // a live row carrying a DIFFERENT durable id is a different event
    s.live.push({ kind: 'text', text: 'a different live event',
      event_id: 'reply_eee', native_event_id: OTHER, n: 9 } as never)
    // …and one with no durable id at all: "unknown" pairs with nothing
    s.live.push({ kind: 'text', text: 'an id-less live row',
      event_id: 'reply_fff', n: 10 } as never)
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    assert.deepEqual(rowIds(el), ['reply_aaa', 'reply_ddd'], 'both durable rows render')
    assert.deepEqual(liveIds(el), ['reply_eee', 'reply_fff'], 'both live rows render')
    assert.equal(says(el, 'a different live event'), 1,
      'a live row with its own uuid is its own event')
    assert.equal(says(el, 'an id-less live row'), 1,
      'and an id-less live row is never collapsed into one')
    assert.equal(says(el, 'second durable, no native id'), 1,
      'a durable row with no native id pairs nothing and still renders')
  })

// ======================================================= tools, by tool_use_id
domTest('§12 a live tool row is suppressed by the chip that replaced it',
  async ({ ND, s, sink, mount }) => {
    // the one identity this codebase never had to invent: a live `tool` row
    // and its durable chip have always carried the CLI's tool_use_id. The
    // server's sweep retires on it — but nothing in the view claimed it, so a
    // row the sweep missed still drew beside its own chip (coordinator-astra
    // review, 2026-09-11). It is a DIFFERENT id space from event ids, so it is
    // namespaced rather than thrown into the same bag.
    row(s, 'ran a command', 'reply_row', {
      native_event_id: 'uu-row',
      tools: [{ id: 'toolu_01', name: 'Bash', arg: 'npm test',
        event_id: 'reply_chip' }],
    } as never)
    s.live.push({ kind: 'tool', id: 'toolu_01', text: 'Bash · npm test',
      event_id: 'reply_livetool', n: 4 } as never)
    // …and a tool still running, whose chip has not landed yet
    s.live.push({ kind: 'tool', id: 'toolu_02', text: 'Read · src/app.ts',
      event_id: 'reply_livetool2', n: 5 } as never)
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    assert.equal(sink.at(-1)!.live.length, 2,
      'fixture: the server sent both live tool rows')
    assert.deepEqual(liveIds(el), ['reply_livetool2'],
      'the one with a chip is gone; the one still running stays')
    assert.equal(says(el, 'npm test'), 1, 'its work is on screen exactly once')
    assert.equal(says(el, 'src/app.ts'), 1, 'and the running one is not lost')
  })

domTest('§12b a tool id never collides with an event id, and an id-less tool row stays',
  async ({ ND, s, sink, mount }) => {
    // the namespacing control. If tool ids and event ids shared one bag, a
    // live row whose event id happened to equal some chip's tool id would
    // vanish — and an id-less tool row would have nothing to be compared by
    // and must never be collapsed.
    row(s, 'ran a command', 'reply_row', {
      native_event_id: 'uu-row',
      tools: [{ id: 'toolu_01', name: 'Bash', arg: 'npm test',
        event_id: 'reply_chip' }],
    } as never)
    // a TEXT row whose event id is the literal tool id string
    s.live.push({ kind: 'text', text: 'prose that must survive',
      event_id: 'toolu_01', n: 6 } as never)
    // a tool row with no id at all
    s.live.push({ kind: 'tool', text: 'Grep · unknown call',
      event_id: 'reply_noid', n: 7 } as never)
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    assert.deepEqual(liveIds(el), ['toolu_01', 'reply_noid'])
    assert.equal(says(el, 'prose that must survive'), 1,
      'a text row is not a tool, whatever its id spells')
    assert.equal(says(el, 'unknown call'), 1,
      'and a tool row with no id is never collapsed')
  })

domTest('§12c an opaque event id spelling `tool:abc` never collides with tool `abc`',
  async ({ ND, s, sink, mount }) => {
    // coordinator-astra review 2026-09-11: tagging ONLY tool ids leaves the
    // event domain raw, so an event id that literally reads `tool:abc` lands
    // on the same key as the tool whose id is `abc` and silently blanks a
    // row. §12b only proved `abc` ≠ `abc`-as-a-tool; this is the collision
    // that a one-sided prefix actually permits.
    row(s, 'ran a command', 'reply_row', {
      native_event_id: 'uu-row',
      tools: [{ id: 'abc', name: 'Bash', arg: 'npm test', event_id: 'reply_chip' },
        { id: 'def', name: 'Read', arg: 'src/app.ts', event_id: 'reply_chip2' }],
    } as never)
    // an event id whose TEXT is the tagged form of the first tool's id
    s.live.push({ kind: 'text', text: 'prose that must survive',
      event_id: 'tool:abc', n: 8 } as never)
    // …and the same in the durable direction: a transcript row whose DURABLE
    // id spells the second tool's key must not be blanked by that tool
    row(s, 'a second message', 'reply_two', { native_event_id: 'tool:def' } as never)
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    assert.equal(says(el, 'prose that must survive'), 1,
      'an event id is not a tool id, however it is spelled')
    assert.equal(says(el, 'a second message'), 1)
    assert.equal(says(el, 'npm test'), 1, 'and the chip is still there once')
    assert.deepEqual(dup(rowIds(el)), [])
  })

domTest('§13 a merged thinking row answers to every record it absorbed',
  async ({ ND, s, sink, mount }) => {
    // read_chat merges consecutive thinking-only records of one message into
    // the first one's row. The merged record's BODY joins the survivor, so
    // its identity must too (coordinator-astra review, 2026-09-11) —
    // otherwise a live thought paired with the absorbed record can never be
    // retired and sits beside the row that swallowed it.
    row(s, 'the answer', 'reply_row', {
      native_event_id: 'uu-think-1',
      native_event_ids: ['uu-think-1', 'uu-think-2'],
      thinking: 'first thought\n\nsecond thought',
    } as never)
    // two live thoughts, one paired with each constituent
    s.live.push({ kind: 'thought', text: 'first thought',
      event_id: 'reply_t1', native_event_id: 'uu-think-1', n: 1 } as never)
    s.live.push({ kind: 'thought', text: 'second thought',
      event_id: 'reply_t2', native_event_id: 'uu-think-2', n: 2 } as never)
    // …and one that belongs to no record at all
    s.live.push({ kind: 'thought', text: 'still thinking',
      event_id: 'reply_t3', native_event_id: 'uu-think-9', n: 3 } as never)
    await refreshConvo(SL, ND)
    const el = await mount(<><Sink nid={ND} sink={sink} />{deskEl(node(ND))}</>)
    await flush()
    assert.equal(sink.at(-1)!.live.length, 3, 'fixture: all three were sent')
    assert.deepEqual(liveIds(el), ['reply_t3'],
      'both constituents are claimed; the unrelated one stays')
    // (a thought renders through ThoughtLine, which collapses its body, so the
    // row is counted structurally rather than by looking for its words)
    assert.equal(el.querySelectorAll('.reply-event .msg.assistant.live').length, 1,
      'exactly one live thought left on screen')
  })

// ================================================================ per view
domTest('§8 the id set is per view: two desks on one node each show the row once',
  async ({ ND, s, sink, mount }) => {
    // a SHARED set would let whichever desk rendered first claim the id and
    // blank the row in the other — the exact failure the store rewrite
    // (convo.ts) was built to prevent, reintroduced by a global guard.
    row(s, 'shared history', 'e-shared')
    row(s, 'the doubled message', 'e-dup')
    row(s, 'the doubled message', 'e-dup')
    await refreshConvo(SL, ND)
    const both = await mount(
      <><Sink nid={ND} sink={sink} />
        <div data-desk="card">{deskEl(node(ND))}</div>
        <div data-desk="pinned">{deskEl(node(ND))}</div></>)
    await flush()
    const card = both.querySelector<HTMLElement>('[data-desk="card"]')!
    const pinned = both.querySelector<HTMLElement>('[data-desk="pinned"]')!
    for (const [what, view] of [['card', card], ['pinned', pinned]] as const) {
      assert.deepEqual(rowIds(view), ['e-shared', 'e-dup'], `${what}: one of each`)
      assert.equal(says(view, 'shared history'), 1, `${what}: nothing blanked`)
      assert.equal(says(view, 'the doubled message'), 1, `${what}: nothing doubled`)
    }
  })

domTest('§9 two different nodes never dedup against each other',
  async ({ ND, s, sink, mount }) => {
    // ids are node-scoped upstream, but a content-hash id CAN repeat across
    // nodes (same text, same ts, different agent → different hash only because
    // the agent is in the payload) — and a future provider id might not be
    // scoped at all. Nothing here may depend on that.
    const OTHER = `${ND}b`
    row(s, 'said by both', 'e-common')
    await refreshConvo(SL, ND)
    await refreshConvo(SL, OTHER)
    const el = await mount(
      <><Sink nid={ND} sink={sink} />
        <div data-desk="a">{deskEl(node(ND))}</div>
        <div data-desk="b">{deskEl(node(OTHER))}</div></>)
    await flush()
    for (const which of ['a', 'b']) {
      const view = el.querySelector<HTMLElement>(`[data-desk="${which}"]`)!
      assert.deepEqual(rowIds(view), ['e-common'], `node ${which} renders its own row`)
    }
  })
