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
// carry their identity in `data-reply-event`, so a duplicate is a repeated
// attribute value, not a guess about what the text looks like.
//
// ⚠ ANTI-VACUITY. A dedup suite passes trivially if its fixtures contain no
// duplicate to remove, so every suppression leg is paired with proof that the
// duplicate was really there:
//   · §7 asserts the STORE holds two rows with one id while the VIEW shows one
//     — the fixture is the real scrollback path, not a hand-placed pair.
//   · §2/§3/§6 are the controls in the other direction: identical text under
//     different ids, and rows with no id at all, must ALL still render. They
//     fail if the guard ever widens into text matching or treats "no id" as an
//     identity.
//   · §8 fails if the id set is ever shared between views.
//
// ⚠ DECLARED INERT REGION. §5 drives a live row that carries a transcript
// row's event id. No backend path stamps one today — `supervisor.live_row`
// mints `live:<boot>:<slug>:<node>:<n>` and none of its 16 call sites passes
// an `event_id` — so that leg exercises the guard's MECHANISM across the
// stream/history boundary, not a duplicate the current server can produce.
// Said plainly rather than left to read as coverage it is not.
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
    // ⚠ same declared-inert caveat as §5 — no backend path stamps a durable
    // id on a live row today.
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
