// retiredpiles.test.tsx — with "hide retired agents" off, the canvas shows
// each parent's retired pile from what the engine's record feed holds
// (docket with-hide-retired-agents-off-no-retired-agents-a; user 2026-10-20
// 11:00Z on alpha.18: "i disabled the 'hide retired agents' setting, but i
// see no retired agents anywhere on the canvas").
//
// The engine's shared set carries, for the top level, every live agent and
// each pile's default front, the first and last retired child plus each
// parent's retired count (engine feed::compute::pile_edges, record feed
// design §1.3). These records go through the real projection
// (recordprojection.projectTree) into a full OrgCanvas mount, in the live
// org's shape: 1321 retired under one agent, 78 at the top level, 3 and 1
// under projects, and a nested pile under the big pile's front.
//
// The control leg is the feed as alpha.18 sent it, counts and no retired
// records: with the setting off nothing retired renders at all, which is
// the user's report and why the fix is in the feed.
//
// Run:  node tests/run.mjs retiredpiles
import { advance, flush, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { RecordTable } from '../src/recordfeed'
import { projectTree } from '../src/recordprojection'
import { HIDE_RETIRED_KEY } from '../src/canvas/shared'

const noop = () => {}

// ---------------------------------------------------------------- records
type Row = { key: string; name: string; parent?: string | null; state?: 'live' | 'archived'
  order?: number; total?: number; project?: boolean }
const body = (r: Row) => ({
  id: r.name, title: r.name, tier: r.project ? 'project' : 'sol', model_id: r.project ? '' : 'sol',
  ...(r.project ? { kind: 'project' } : {}),
  state: r.state ?? 'live', parent_id: r.parent ?? null, sibling_order: r.order ?? 1, ord: Number(r.key),
  retired_children_total: r.total ?? 0, successor: null,
  seat: 1, grant: 0, free: 0, cost_usd: 0, occupancy: null, context_window: null, charter: null,
  mail_pending: 0, limit_locked: false, last_status: null, prev_status: null, inflight_at: null,
  last_denials: [], turns: [], frozen: null, audiences_held: [], bearer_state: null, generation: 1,
  lineage: [], documents: [], isBearerOf: null,
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
})

/** The org groups the projection requires, the header in `settings`. */
function groups(rootsTotal: number, total: number): Map<string, unknown> {
  const settings = {
    slug: 'rp', name: 'rp', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { sol: 5 }, audiences: [], cost_usd_total: 0,
    audit: { live_nodes: 6, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true,
    audience_requests: [], org_inbox: null, net: null,
  }
  const g = new Map<string, unknown>([['settings', settings],
    ['foreground', { retired_total: total, retired_roots_total: rootsTotal }]])
  for (const name of ['tiers', 'cost', 'audit', 'asks', 'audiences', 'watchdogs', 'inbox_summary',
    'org_inbox', 'net', 'work_summary']) g.set(name, {})
  return g
}

const LIVE: Row[] = [
  { key: '1', name: 'coord', order: 1, total: 1321 },
  { key: '2', name: 'slots', parent: '1', order: 1, total: 3, project: true },
  { key: '33', name: 'slot-live', parent: '2', order: 1 },
  { key: '3', name: 'committee', parent: '1', order: 2, total: 1, project: true },
  { key: '4', name: 'worker', parent: '1', order: 4 },
]
// what the fixed feed adds: each visible parent's first and last retired child
const REPRESENTATIVES: Row[] = [
  { key: '20', name: 'top-t1', state: 'archived', order: 2 },
  { key: '1450', name: 'top-r-76', state: 'archived', order: 2 },
  { key: '10', name: 'coord-t1', parent: '1', state: 'archived', order: 3 },
  { key: '1400', name: 'coord-r-1318', parent: '1', state: 'archived', order: 3, total: 5 },
  { key: '1500', name: 'nest-r-1', parent: '1400', state: 'archived' },
  { key: '1504', name: 'nest-r-5', parent: '1400', state: 'archived' },
  { key: '30', name: 'slot-1', parent: '2', state: 'archived' },
  { key: '32', name: 'slot-3', parent: '2', state: 'archived' },
  { key: '40', name: 'cmt-1', parent: '3', state: 'archived' },
]

function records(rows: Row[]): RecordTable {
  return new Map<string, Map<string, unknown>>([
    ['org', groups(78, 1411)],
    ['agent', new Map(rows.map((r) => [r.key, body(r)]))],
  ])
}

// -------------------------------------------------------------- DOM layer
// jsdom's rects are 0x0 and the canvas culls to its viewport (hideretired.test.tsx)
function stubRects(): () => void {
  const proto = HTMLElement.prototype
  const had = proto.getBoundingClientRect
  proto.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 1600, bottom: 1200, x: 0, y: 0,
      width: 1600, height: 1200, toJSON: () => ({}) } as DOMRect
  }
  return () => { proto.getBoundingClientRect = had }
}

async function canvas(t: TestContext, rows: Row[], hideRetired: boolean): Promise<HTMLElement> {
  useFakeClock()
  localStorage.clear()
  if (hideRetired) localStorage.setItem(HIDE_RETIRED_KEY, '1')
  const unstub = stubRects()
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const tree = projectTree(records(rows))
  const v = await mountView(<OrgCanvas tree={tree} op={() => Promise.resolve({} as never)}
    slug="rp" toast={noop} mailEvt={null} />, (host) => host)
  t.after(async () => {
    try { await v.unmount() } catch { /* gone */ }
    unstub(); localStorage.clear(); realClock()
  })
  await flush()
  await advance(2600)   // the intro glide lands before the DOM is read
  return v.el
}
const cards = (el: HTMLElement) => [...el.querySelectorAll('.sq .sq-title .name')].map((n) => n.textContent ?? '')
const piles = (el: HTMLElement) => [...el.querySelectorAll('.pile-stack .pile-count')].map((n) => n.textContent ?? '').sort()
const tokens = (el: HTMLElement) => [...el.querySelectorAll('.retired-token')].map((n) => n.textContent ?? '').sort()

test('the projection accepts the feed: each parent\'s count covers the retired children it holds', () => {
  const tree = projectTree(records([...LIVE, ...REPRESENTATIVES]))
  const coord = tree.roots.find((n) => n.id === 'coord') as unknown as { hidden_retired_children: number }
  assert.equal(coord.hidden_retired_children, 1319, 'two of the 1321 are held')
  assert.equal(tree.foreground?.hidden_retired_roots, 76, 'two of the 78 top-level retirees are held')
})

test('setting off: a counted retired pile at the top level, under an agent, under a project and under a pile\'s front', async (t) => {
  const el = await canvas(t, [...LIVE, ...REPRESENTATIVES], false)
  assert.deepEqual(piles(el), ['1321', '3', '5', '78'], 'one pile per parent with two or more retirees, carrying its whole count')
  const shown = cards(el)
  for (const front of ['coord-r-1318', 'top-r-76', 'slot-3', 'nest-r-5']) {
    assert.ok(shown.includes(front), `${front} fronts its pile (${shown.join(', ')})`)
  }
  assert.ok(shown.includes('cmt-1'), 'a single retiree is a card of its own')
  for (const buried of ['coord-t1', 'top-t1', 'slot-1', 'nest-r-1']) {
    assert.ok(!shown.includes(buried), `${buried} is under its pile's front`)
  }
  assert.ok(!el.querySelector('.retired-token'), 'no token while the setting is off')
})

test('setting on: the same counts on the retired-list tokens, and no pile', async (t) => {
  const el = await canvas(t, [...LIVE, ...REPRESENTATIVES], true)
  assert.deepEqual(tokens(el), ['1 retired', '1321 retired', '3 retired', '78 retired'])
  assert.ok(!el.querySelector('.pile-stack'), 'no retired pile remains')
  const shown = cards(el)
  assert.ok(!shown.some((n) => /^(coord-|top-|slot-\d|nest-|cmt-)/.test(n)), `no retired card (${shown.join(', ')})`)
})

test('control: the alpha.18 feed, counts without retired records, shows nothing retired with the setting off', async (t) => {
  const el = await canvas(t, LIVE.map((r) => r), false)
  assert.ok(!el.querySelector('.pile-stack'), 'no pile: none of its cards is held')
  assert.ok(!el.querySelector('.retired-token'), 'and no token: tokens are the setting-on surface')
  assert.ok(cards(el).includes('coord') && cards(el).includes('worker'), 'the live cards render')
})
