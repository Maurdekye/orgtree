// rightsbadge.test.tsx — the ⚙-rights rows on the header's $ badge, and the
// gate that decides whether that badge exists at all.
//
// The rows (denied / approved, 2026-09-05) ride in the badge's tooltip — the
// №15 precedent, no new chip. That makes the badge's GATE load-bearing for a
// surface that has nothing to do with money: it used to be
//
//     (cost > 0 || cost unknown)
//
// which reads "no spend, nothing to say". A complete turn on a subscription
// lane costs a real, KNOWN $0.00, so a codex seat whose approval seam had
// just let a sandbox-blocked command out rendered no badge — and the only
// place those rows appear went with it.
//
// So the checks below are a pair, and the negative is the one that keeps the
// positive honest: rows at $0.00 must SHOW, and a plain $0.00 node with no
// rights at all must still show NOTHING. A gate that opened for every zero
// would pass the first check while meaning nothing.
//
// Read out of the rendered DOM rather than out of desk.tsx, because a
// source-text check pins a spelling rather than behaviour.
//
// Run:  cd frontend && node tests/run.mjs rightsbadge

import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SpendBadge } from '../src/canvas/desk'
import type { Denial, TurnStat } from '../src/types'

const turn = (over: Partial<TurnStat> = {}): TurnStat => ({
  at: '2026-09-05T10:00:00Z', cost: 0, ms: 1200, denials: 0, ...over,
} as TurnStat)

const badge = async (node: Parameters<typeof SpendBadge>[0]['node']) => {
  const view = await mountView(<SpendBadge node={node} />, (el) => el)
  const span = view.el.querySelector<HTMLElement>('span.badge')
  return { view, span, title: span?.getAttribute('title') ?? '' }
}

test('a zero-cost turn still shows its rights rows, and their counts', async () => {
  const approvals: Denial[] = [
    { tool: 'commandExecution', arg: 'git add -A',
      cwd: 'C:\\work\\repo' },
    { tool: 'fileChange', arg: 'patch-7' },
  ]
  const denials: Denial[] = [
    { tool: 'commandExecution', arg: 'rm -rf build', cwd: 'C:\\work\\repo' },
  ]
  // the shape a completed SUBSCRIPTION turn actually has: cost 0, known
  const { view, span, title } = await badge({
    cost_usd: 0, turns: [turn({ denials: 1, approvals: 2 })],
    last_denials: denials, last_approvals: approvals,
  })
  try {
    assert.ok(span, 'a $0.00 turn with rights rows must still render the badge')
    assert.equal(span.textContent, '$0.00',
      'a known zero is $0.00 — not $?, which claims the number is unresolved')
    assert.match(title, /approved · commandExecution · git add -A · in C:\\work\\repo/)
    assert.match(title, /approved · fileChange · patch-7/)
    // ⚠ cwd on the DENIED row too: the backend books it for both lists, and a
    // denial that hides where the command would have run says less than the
    // approval beside it
    assert.match(title, /denied · commandExecution · rm -rf build · in C:\\work\\repo/)
    // the counts line is the ring's, and it distinguishes the two
    assert.match(title, /1 denied/)
    assert.match(title, /2 approved/)
    assert.doesNotMatch(title, /ran|executed/,
      'approved is not executed — the callback answers before anything runs')
  } finally { await view.unmount() }
})

test('a zero-cost node with nothing to report shows no badge at all', async () => {
  // NEGATIVE CONTROL for the gate above. Same $0.00, same completed turn —
  // only the rights are missing. If this renders, the first test proves
  // nothing: the badge would be showing for every zero-cost node in the org.
  const quiet = await badge({
    cost_usd: 0, turns: [turn()], last_denials: [], last_approvals: [],
  })
  try {
    assert.equal(quiet.span, null,
      'no spend and no rights: the badge must stay away')
  } finally { await quiet.view.unmount() }

  // …and the field being ABSENT (a lane with no approval seam) is not a
  // reason to appear either
  const bare = await badge({ cost_usd: 0, turns: [turn()] })
  try {
    assert.equal(bare.span, null)
  } finally { await bare.view.unmount() }
})

test('rights on an older turn open the badge only while the tooltip shows them',
  async () => {
    // the tooltip renders the last five turns; the gate counts the same five,
    // so a badge opened for a count always has that count inside it
    const five = [turn(), turn(), turn(), turn(), turn()]
    const inside = await badge({
      cost_usd: 0, turns: [turn({ denials: 3 }), ...five.slice(1)],
    })
    try {
      assert.ok(inside.span, 'a denial inside the rendered window opens it')
      assert.match(inside.title, /3 denied/)
    } finally { await inside.view.unmount() }

    const outside = await badge({
      cost_usd: 0, turns: [turn({ denials: 3 }), ...five],
    })
    try {
      assert.equal(outside.span, null,
        'a turn the tooltip never renders must not open an empty badge')
    } finally { await outside.view.unmount() }
  })

test('spend still opens the badge on its own, unknown cost still says so',
  async () => {
    // the ORIGINAL behaviour, unchanged — the new gate is additive
    const paid = await badge({ cost_usd: 1.5, turns: [turn({ cost: 1.5 })] })
    try {
      assert.equal(paid.span?.textContent, '$1.50')
    } finally { await paid.view.unmount() }

    const unknown = await badge({ cost_usd: 0, cost_usd_unknown: true })
    try {
      assert.equal(unknown.span?.textContent, '$?')
      assert.match(unknown.title, /per-turn detail appears after the next turn/)
    } finally { await unknown.view.unmount() }

    const partial = await badge({ cost_usd: 2, cost_usd_unknown: true })
    try {
      assert.equal(partial.span?.textContent, '$2.00 estimated/incomplete')
    } finally { await partial.view.unmount() }
  })

// ── the reported upstream is the SECOND surface this gate can hide ────────
//
// Same failure as the rights rows above, one surface later: a FREE or
// known-zero OpenRouter turn costs $0.00, has no denials and no approvals,
// and the tooltip is the only place its reported upstream is rendered. With
// the gate at (cost || unknown || rights) the badge did not exist, so the
// metadata could not be read on exactly the turns a free model is used for.
// Caught in review before it shipped.
const reported = (over: Partial<NonNullable<TurnStat['reported']>> = {}) => ({
  requests: 1, models: ['x-ai/grok-4.6'], providers: ['xAI'], mixed: false,
  ...over,
})

test('a known-zero turn with reported metadata still shows the badge', async () => {
  const { view, span, title } = await badge({
    cost_usd: 0, turns: [turn({ reported: reported() } as Partial<TurnStat>)],
  })
  try {
    assert.ok(span, 'a free $0.00 turn hid the only surface its upstream has')
    assert.equal(span.textContent, '$0.00',
      'a known zero is still $0.00 — opening the badge must not make it an estimate')
    assert.match(title, /reported upstream xAI/)
    assert.match(title, /model x-ai\/grok-4\.6/)
    assert.doesNotMatch(title, /serv/i,
      'the tooltip may not say anything was served — the model is an echo of the request')
  } finally { await view.unmount() }
})

test('a known-zero turn with NO reported metadata still shows no badge', async () => {
  // NEGATIVE CONTROL for the clause above. Without it, the first check would
  // pass under a gate that opened for every zero-cost node in the org.
  const quiet = await badge({ cost_usd: 0, turns: [turn()] })
  try {
    assert.equal(quiet.span, null, 'no spend, no rights, no metadata: stay away')
  } finally { await quiet.view.unmount() }

  // an EMPTY block is not metadata either — the backend writes no block at
  // all when a turn reported nothing, but a stale or partial row must not
  // open the badge on nothing
  const empty = await badge({
    cost_usd: 0,
    turns: [turn({ reported: { requests: 0, models: [], providers: [], mixed: false } } as Partial<TurnStat>)],
  })
  try {
    assert.equal(empty.span, null, 'an empty reported block opened an empty badge')
  } finally { await empty.view.unmount() }
})

test('metadata on a turn the tooltip never renders does not open the badge',
  async () => {
    // the same window rule the rights clause follows: the gate counts the
    // five turns the tooltip shows, so a badge opened for metadata has it
    const five = [turn(), turn(), turn(), turn(), turn()]
    const outside = await badge({
      cost_usd: 0,
      turns: [turn({ reported: reported() } as Partial<TurnStat>), ...five],
    })
    try {
      assert.equal(outside.span, null,
        'a turn outside the rendered window opened a badge with nothing in it')
    } finally { await outside.view.unmount() }
  })
