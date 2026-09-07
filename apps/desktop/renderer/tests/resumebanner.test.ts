// resumebanner.test.ts — the ▶ resume banner counts what ▶ will actually do.
//
// user report 2026-08-26: the banner read "resume 2 — usage limit hit · 2
// agents frozen" in an org whose two frozen agents had since been RETIRED.
// Retiring does not clear the freeze record (a retired agent keeps its context
// and can be rehired), so the old filter — `n.frozen != null` and nothing else
// — counted nodes the backend has never been willing to resume. Nothing behind
// the banner was broken: `_resumable` already refused them and ▶ resumed
// nobody. Only the count lied.
//
// ⚠ WHAT THIS FILE DOES *NOT* TEST, ON PURPOSE. The rule itself lives in
// `supervisor.resumable`, and the payload carries its answer per node. The
// first version of this fix re-derived that rule in TypeScript and pinned the
// two copies together with a check that read `supervisor.py` as source text —
// which cannot tell a rule that got stronger from one that got weaker, fires
// on a rename, and misses a semantic change that keeps the same spelling. So
// the rule is tested where it lives, in `backend/tests/test_resumable.py`,
// including that `annotate` emits the field at all. What is left here is the
// only thing the frontend still decides: that the banner reads that field and
// nothing else.
//
// ⚠ WHY EVERY TEST STILL HAS TWO LEGS. "The banner shows 0" passes just as
// happily if the filter drops EVERY frozen agent, or if it returns nothing at
// all — both are the bug from the other end, and both look like a fix. So
// every check that something is excluded is paired with a node that must
// still be counted. Mutation-checked in both directions.
//
// Run:  cd frontend && node tests/run.mjs resumebanner

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { resumableFrozen } from '../src/App'
import type { TreePayload } from '../src/types'

// ---------------------------------------------------------------- fixtures
/** shaped like the payload, not type-checked into it — the fixture idiom of
 *  audpile/deskinit, trimmed to what resumableFrozen dereferences */
const asTree = (v: unknown) => v as TreePayload

interface FixNode {
  id: string
  /** the backend's answer, stated outright — this is a payload FIELD, and a
   *  fixture that recomputed it would be the mirror creeping back in */
  resumable?: boolean
  frozen?: Record<string, unknown> | null
  state?: 'live' | 'archived' | 'unrecoverable'
  children?: FixNode[]
}

/** a plain usage-limit freeze — the shape the banner is about */
const LIMIT = { at: '2026-08-26T09:00:00Z', until: 'in 3 hours',
                until_ts: 1900000000, error: null, limit: true }

function mk(n: FixNode): unknown {
  return {
    id: n.id, title: n.id, tier: 'opus', model_id: 'opus',
    state: n.state ?? 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    resumable: n.resumable ?? false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: n.frozen ?? null, audiences_held: [],
    bearer_state: null, generation: 0,
    children: (n.children ?? []).map(mk), lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  }
}

function tree(roots: FixNode[]): TreePayload {
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: roots.map(mk), cost_usd_total: 0,
    audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

const ids = (t: TreePayload) => resumableFrozen(t).map((n) => n.id).sort()

// ------------------------------------------------------------------- tests

test('§1 the reported bug: a frozen node the backend refuses is not counted', () => {
  // the user's org — two frozen agents the backend says are not resumable
  // (they were retired) — plus one that is, which is the leg that stops
  // "drop everything" from passing
  const t = tree([
    { id: 'gone-1', frozen: LIMIT, resumable: false, state: 'archived' },
    { id: 'gone-2', frozen: LIMIT, resumable: false, state: 'archived' },
    { id: 'still-here', frozen: LIMIT, resumable: true },
  ])
  assert.deepEqual(ids(t), ['still-here'])
  assert.equal(resumableFrozen(t).length, 1,
    'the banner would have said "resume 3"; ▶ would have resumed 1')
})

test('§2 the exact screenshot: nothing resumable → no banner at all', () => {
  // the banner renders only when the list is non-empty, so here it must
  // disappear rather than read "resume 0"
  const t = tree([
    { id: 'gone-1', frozen: LIMIT, resumable: false, state: 'archived' },
    { id: 'gone-2', frozen: LIMIT, resumable: false, state: 'archived' },
  ])
  assert.deepEqual(resumableFrozen(t), [])
})

test('§3 a resumable frozen agent is ALWAYS counted — the leg that must hold', () => {
  // nothing here is excludable, at any depth: if this returns empty the
  // filter has started eating the case it exists to serve
  const t = tree([
    { id: 'a', frozen: LIMIT, resumable: true },
    { id: 'b', frozen: LIMIT, resumable: true,
      children: [{ id: 'c', frozen: LIMIT, resumable: true }] },
  ])
  assert.deepEqual(ids(t), ['a', 'b', 'c'])
})

test('§4 the field decides — NOT the node state the frontend can see', () => {
  // This is the anti-mirror check. Both nodes are `state: 'live'`, so any
  // re-derivation in App.tsx would count both; only the backend's answer
  // separates them. If someone reintroduces a `state === 'live'` test in
  // resumableFrozen, this test still passes — but the one below fails.
  const t = tree([
    { id: 'live-but-refused', frozen: LIMIT, resumable: false },
    { id: 'live-and-allowed', frozen: LIMIT, resumable: true },
  ])
  assert.deepEqual(ids(t), ['live-and-allowed'])
})

test('§5 an ARCHIVED node the backend calls resumable is still counted', () => {
  // Deliberately contradictory fixture: the frontend must not second-guess
  // the backend. `resumable` is the answer, not a hint to be re-checked —
  // and this is the check that fails if the old `state === 'live'` test is
  // ever reintroduced alongside the field.
  const t = tree([{ id: 'odd', frozen: LIMIT, resumable: true, state: 'archived' }])
  assert.deepEqual(ids(t), ['odd'],
    'resumableFrozen re-derived the rule instead of trusting the payload')
})

test('§6 no freeze record, no count — whatever the flag says', () => {
  // `resumable` is never true without a record in practice; the null test in
  // resumableFrozen is TypeScript narrowing for the `.frozen.until` deref
  // below it, and this pins that it cannot crash on a contradictory payload
  const t = tree([
    { id: 'clean', frozen: null, resumable: true },
    { id: 'frozen', frozen: LIMIT, resumable: true },
  ])
  assert.deepEqual(ids(t), ['frozen'])
})
