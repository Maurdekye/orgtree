// pilerecency.test.tsx — the retired pile lists most-recently-touched FIRST,
// and each row says how long ago (user request 2026-08-27).
//
// The pile used to list in whatever order the org document happened to hold
// its archived children in, reversed — i.e. newest HIRE first, which has
// nothing to do with who you last worked with. In a long-lived org that is the
// difference between the agent you were talking to ten minutes ago being row 1
// and being row 14.
//
// ⚠ WHAT "TOUCHED" MEANS, AND WHY THE FIXTURES PIN IT. `lastTouched` reads
// `TurnStat.at` — the end of the node's last turn — because that is the clock
// FR-23's card badge already shows, so a pile row and that agent's card cannot
// disagree. §4 exists to keep it that way: it asserts the row's time string is
// the same one `ago()` produces, not a second formatter that happens to agree
// today. The two rejected alternatives are pinned negatively:
//   · `last_status.at` — §5's fixture gives the OLDEST agent the NEWEST status,
//     so ordering by status would invert the answer and fail.
//   · the retire time — not readable here at all, and a dissolve stamps a whole
//     subtree with one instant, so it would order a retired team not at all.
//
// ⚠ ANTI-VACUITY. Every ordering fixture is built so that the three orders a
// broken implementation can produce — the input order (sort dropped), its
// reverse (comparator returns a constant), and the inverted answer (comparator
// flipped) — are all DISTINCT from the expected order and from each other. A
// suite whose expected order equals its input order proves nothing.
//
// Run:  cd frontend && node tests/run.mjs pilerecency

import { mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { ago, lastTouched, pileOrder, type CanvasNode, type Pile } from '../src/canvas/shared'
import { PilePicker } from '../src/canvas/modals'

// the harness's fake clock stops Date here, so every "N ago" below is exact
const NOW = 1_700_000_000_000
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

/** a retired pile member. `turns` is the projection's shape — the ring's last
 *  entries, newest LAST — so the fixtures also prove the reader takes the tail
 *  and not the head. */
function agent(id: string, turnMins: number[] | null,
  extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, state: 'archived', tier: 'opus', children: [],
    ...(turnMins
      ? { turns: turnMins.map((m) => ({ at: minsAgo(m), cost: 0, denials: 0 })) }
      : {}),
    ...extra,
  }
}

const mapOf = (...ns: CanvasNode[]) => new Map(ns.map((n) => [n.id, n]))

// ---------------------------------------------------------- §1 the ordering
test('§1 rows run most-recently-touched first', () => {
  // A ran 2h ago, C 3 days ago, B 10 minutes ago.
  const map = mapOf(agent('A', [120]), agent('C', [4320]), agent('B', [10]))
  // the input order is A,C,B — so the expected answer B,A,C is neither the
  // input nor its reverse (B,C,A). Dropping the sort, or a comparator that
  // returns a constant, each produce one of those and fail here.
  assert.deepEqual(pileOrder(['A', 'C', 'B'], map), ['B', 'A', 'C'])
  // and the flipped comparator (oldest first) is a fourth distinct order
  assert.notDeepEqual(pileOrder(['A', 'C', 'B'], map), ['C', 'A', 'B'])
})

test('§2 the LAST turn in the ring is the one that counts, not the first', () => {
  // P's ring starts older than Q's but ENDS newer. Reading turns[0] would put
  // Q on top; reading the tail puts P there.
  const map = mapOf(agent('P', [5000, 5]), agent('Q', [60, 30]))
  assert.deepEqual(pileOrder(['P', 'Q'], map), ['P', 'Q'])
  assert.equal(lastTouched(map.get('P')), Date.parse(minsAgo(5)))
})

test('§3 agents that never ran sink to the bottom, keeping their old order', () => {
  // N1/N2 have no turns at all. R ran an hour ago.
  const map = mapOf(agent('N1', null), agent('R', [60]), agent('N2', null))
  // R first because it has a clock at all; then the never-ran pair in the
  // order the picker used BEFORE this change (the list reversed), because the
  // sort is stable. If `lastTouched` returned -Infinity the comparator would
  // hand back NaN for that pair and the order would be arbitrary.
  assert.deepEqual(pileOrder(['N1', 'R', 'N2'], map), ['R', 'N2', 'N1'])
  assert.equal(lastTouched(map.get('N1')), 0)
  assert.equal(lastTouched(undefined), 0, 'a member missing from the map is not a crash')
  // an unparseable stamp is treated as no clock, not as epoch-adjacent garbage
  assert.equal(lastTouched({ id: 'x', state: 'archived', tier: null, children: [],
    turns: [{ at: 'not a date', cost: 0, denials: 0 }] }), 0)
})

test('§4 it is a DISPLAY order — the pile\'s own list and front are untouched', () => {
  // The guard on scope: `Pile.list`'s last entry is the default front card on
  // the canvas, and re-sorting it would silently move which retiree the stack
  // shows on top. This change is the picker's rows, nothing more.
  const map = mapOf(agent('A', [120]), agent('C', [4320]), agent('B', [10]))
  const list = ['A', 'C', 'B']
  const before = [...list]
  pileOrder(list, map)
  assert.deepEqual(list, before, 'pileOrder must not mutate the pile\'s list')
})

// ------------------------------------------------------------ §5 the render
function uiTest(name: string, body: (mount: (el: React.ReactElement)
  => Promise<HTMLElement>) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      realClock()
    })
    await body(async (el) => {
      const v = await mountView(el, (host) => host)
      open.push(v)
      return v.el
    })
  })
}

// A ran 2h ago, C 3 days ago, B 10 minutes ago — and C, the OLDEST, carries the
// NEWEST status. Ordering by `last_status.at` would put C on top; it must not.
const PILE_MAP = mapOf(
  agent('alpha-one', [120], { last_status: { status: 'done', summary: 'x', at: minsAgo(120) } }),
  agent('charlie-three', [4320], { last_status: { status: 'done', summary: 'x', at: minsAgo(1) } }),
  agent('bravo-two', [10]),
)
const PILE: Pile = {
  key: 'boss|a', parent: 'boss', kind: 'a',
  list: ['alpha-one', 'charlie-three', 'bravo-two'],
  front: 'alpha-one',
}
const names = (el: HTMLElement) =>
  [...el.querySelectorAll('.pile-row .pile-name')].map((x) => x.textContent)
const times = (el: HTMLElement) =>
  [...el.querySelectorAll('.pile-row .pile-ago')].map((x) => x.textContent)

uiTest('§5 the picker renders its rows in that order', async (mount) => {
  const el = await mount(
    <PilePicker pile={PILE} map={PILE_MAP} onPick={() => {}} close={() => {}} />)
  assert.deepEqual(names(el), ['bravo-two', 'alpha-one', 'charlie-three'])
  // the front card is NOT forced to the top — it keeps its recency slot, and
  // still wears its badge wherever it lands
  assert.equal(el.querySelectorAll('.pile-row.on .pile-name')[0]?.textContent,
    'alpha-one')
})

uiTest('§6 every row says how long ago, in the app\'s own words', async (mount) => {
  const el = await mount(
    <PilePicker pile={PILE} map={PILE_MAP} onPick={() => {}} close={() => {}} />)
  // one time per row, in row order
  assert.deepEqual(times(el), ['10m ago', '2h ago', '72h ago'])
  // …and those are `ago()`'s words, not a second formatter that agrees today
  assert.deepEqual(times(el),
    [10, 120, 4320].map((m) => `${ago(minsAgo(m))} ago`))
  // DISTINCTNESS: three different ages must not render as one string. A row
  // that showed a constant would satisfy "every row has a time" and be useless.
  assert.equal(new Set(times(el)).size, 3)
})

uiTest('§7 a member that never ran shows nothing rather than "never"', async (mount) => {
  const map = mapOf(agent('ran-once', [45]), agent('never-ran', null))
  const el = await mount(
    <PilePicker pile={{ key: 'b|a', parent: 'b', kind: 'a',
      list: ['ran-once', 'never-ran'], front: 'ran-once' }}
      map={map} onPick={() => {}} close={() => {}} />)
  assert.deepEqual(names(el), ['ran-once', 'never-ran'])
  // ANTI-VACUITY: exactly ONE time badge across two rows — so the "shows
  // nothing" leg cannot be passing because the selector matches nothing at all
  assert.deepEqual(times(el), ['45m ago'])
})
