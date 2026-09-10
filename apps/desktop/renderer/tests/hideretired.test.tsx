// hideretired.test.tsx — optionally-hide-retired-agents-across-agent-view
// (user resumed 2026-09-10 13:25). A DISABLED-BY-DEFAULT display setting:
// when on, retired agents leave the canvas; they stay reachable only through
// the retired-list token on a parent with retired subordinates (and the
// switchboard's archived rows, which route through the same centerOn reveal
// the token uses). No org record changes — the prune touches the LAYOUT
// tree only, never the data.
//
// Two layers, matching where the behavior lives:
//   * pruneRetiredView (pure): what hides, what must NEVER hide (a knowledge
//     bearer, an archived node with a live descendant, a revealed retiree),
//     and the token/reveal bookkeeping — every rule directly.
//   * a full OrgCanvas mount (jsdom, with a real-sized viewport stubbed in,
//     since jsdom's zero-rect viewport culls every card): default-off
//     control, cards gone + token present when on, and the token → picker →
//     reveal round trip through the REAL centerOn hook.
//
// Run:  cd frontend && node tests/run.mjs hideretired
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { TreePayload } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'
import { HIDE_RETIRED_KEY, setHideRetiredOn } from '../src/canvas/shared'
import { pruneRetiredView } from '../src/canvas/OrgCanvas'

const noop = () => {}

// ---------------------------------------------------------------- fixtures
type Kid = { id: string; state?: string; isBearerOf?: string | null; children?: Kid[] }
const mk = (k: Kid): CanvasNode => ({
  id: k.id, title: k.id, tier: 'haiku', model_id: 'haiku',
  state: k.state ?? 'live', isBearerOf: k.isBearerOf ?? null,
  seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
  context_window: null, charter: null, mail_pending: 0, limit_locked: false,
  last_status: null, prev_status: null, inflight_at: null, last_denials: [],
  turns: [], frozen: null, audiences_held: [], bearer_state: null,
  generation: 0, lineage: [],
  children: (k.children ?? []).map(mk),
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
} as unknown as CanvasNode)

const FIXTURE: Kid[] = [
  { id: 'boss', children: [
    { id: 'ret-one', state: 'archived' },
    { id: 'ret-two', state: 'archived' },
    { id: 'worker' },
  ] },
  { id: 'solo-ret', state: 'archived' },
]

function tree(kids: Kid[]): TreePayload {
  return {
    slug: 'hr', name: 'hr', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: kids.map(mk), cost_usd_total: 0,
    audit: { live_nodes: 2, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  } as unknown as TreePayload
}

// ------------------------------------------------------------- pure layer
const names = (l?: CanvasNode[]) => (l ?? []).map((c) => c.id)
// kid ids via the node, not `.children` in the assert operand: deepdom's §5
// guard reads operand TEXT and cannot tell these plain CanvasNode records
// from DOM (its own stated limit) — keep the access inside the helper
const kidNames = (n?: CanvasNode) => (n?.children ?? []).map((c) => c.id)
const kidsOf = (root: CanvasNode, id: string): CanvasNode | undefined => {
  if (root.id === id) return root
  for (const c of root.children ?? []) { const hit = kidsOf(c, id); if (hit) return hit }
  return undefined
}
const ROOT = mk({ id: 'R', children: FIXTURE })

test('pruning hides archived subtrees and groups them under their parent', () => {
  const v = pruneRetiredView(ROOT, true, new Set())
  assert.deepEqual(kidNames(kidsOf(v.root, 'boss')), ['worker'])
  assert.deepEqual(kidNames(v.root), ['boss'], 'the solo retiree leaves the top level too')
  assert.deepEqual(names(v.retiredByParent.get('boss')), ['ret-one', 'ret-two'])
  assert.deepEqual(names(v.retiredByParent.get('R')), ['solo-ret'])
  assert.deepEqual([...v.prunedIds].sort(), ['ret-one', 'ret-two', 'solo-ret'])
})

test('the setting off, a reveal, a bearer and a live descendant all defeat the prune', () => {
  const off = pruneRetiredView(ROOT, false, new Set())
  assert.equal(off.root, ROOT, 'off: the tree passes through untouched')
  assert.equal(off.retiredByParent.size, 0)
  const revealed = pruneRetiredView(ROOT, true, new Set(['ret-two']))
  assert.deepEqual(kidNames(kidsOf(revealed.root, 'boss')), ['ret-two', 'worker'])
  assert.deepEqual(names(revealed.retiredByParent.get('boss')), ['ret-one'],
    'the token counts only what is still hidden')
  // a knowledge bearer is an ACTIVE surface, not a resting retiree
  const bearer = mk({ id: 'B', children: [
    { id: 'succ' }, { id: 'ghost', state: 'archived', isBearerOf: 'succ' }] })
  const bv = pruneRetiredView(bearer, true, new Set())
  assert.deepEqual(kidNames(bv.root), ['succ', 'ghost'])
  // an archived manager with a LIVE report must not take the report with it
  const mixed = mk({ id: 'M', children: [
    { id: 'oldmgr', state: 'archived', children: [{ id: 'alive' }] }] })
  const mv = pruneRetiredView(mixed, true, new Set())
  assert.deepEqual(kidNames(mv.root), ['oldmgr'],
    'the archived chain to a live agent stays visible')
  assert.equal(mv.prunedIds.size, 0)
})

test('a pruned subtree is pruned WHOLE — descendants are in prunedIds for the reveal chain', () => {
  const deep = mk({ id: 'D', children: [
    { id: 'gone-mgr', state: 'archived', children: [
      { id: 'gone-kid', state: 'archived' }] }] })
  const v = pruneRetiredView(deep, true, new Set())
  assert.deepEqual([...v.prunedIds].sort(), ['gone-kid', 'gone-mgr'])
  assert.deepEqual(names(v.retiredByParent.get('D')), ['gone-mgr'],
    'the token lists the subtree ROOT, not every descendant')
})

test('the setting is a real control in App settings, wired to the shared store', () => {
  // bound at source like the title spellings (apptitle.test.tsx): the toggle
  // renders THE store the canvas reads, in the Desk group beside the crowd
  // stack toggle it mirrors
  const src = readFileSync(joinPath(__SRC_DIR__, 'canvas', 'accounts.tsx'), 'utf8')
  assert.match(src, /label="hide retired agents" checked=\{on\}\r?\n\s*onChange=\{setHideRetiredOn\}/)
  assert.match(src, /<CrowdStackToggle \/><HideRetiredToggle \/>/)
})
declare const __SRC_DIR__: string   // injected by run.mjs

// -------------------------------------------------------------- DOM layer
// jsdom reports every rect as 0×0 and the canvas culls cards to the visible
// viewport, so a real-sized rect is stubbed for this file only (same idiom
// as contextmenu.test.tsx's per-element stubs, widened because the canvas
// measures the viewport it mounts).
function stubRects(): () => void {
  const proto = HTMLElement.prototype
  const had = proto.getBoundingClientRect
  proto.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 1600, bottom: 1200, x: 0, y: 0,
      width: 1600, height: 1200, toJSON: () => ({}) } as DOMRect
  }
  return () => { proto.getBoundingClientRect = had }
}

function domTest(name: string, body: (k: {
  mount: (el: React.ReactElement) => Promise<HTMLElement> }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    localStorage.clear()
    const unstub = stubRects()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      unstub()
      localStorage.clear()
      realClock()
    })
    await body({ mount: async (el) => {
      const v = await mountView(el, (host) => host)
      open.push(v)
      return v.el
    } })
  })
}

async function mountCanvas(mount: (el: React.ReactElement) => Promise<HTMLElement>) {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const el = await mount(
    <OrgCanvas tree={tree(FIXTURE)} op={() => Promise.resolve({} as never)}
      slug="hr" toast={noop} mailEvt={null} />)
  await flush()
  await advance(2600)   // let the intro glide land before reading the DOM
  return el
}

const cardNames = (el: HTMLElement) =>
  [...el.querySelectorAll('.sq .sq-title .name')].map((n) => n.textContent)

domTest('OFF by construction: retirees render on a fresh profile — the control leg', async ({ mount }) => {
  const el = await mountCanvas(mount)
  const shown = cardNames(el)
  assert.ok(shown.includes('solo-ret'), `the solo retiree has a card (${shown.join(', ')})`)
  assert.ok(shown.some((n) => n === 'ret-one' || n === 'ret-two'),
    'the retired cohort shows its pile front')
  assert.equal(el.querySelector('.retired-token'), null, 'and no token renders')
})

domTest('ON: retired cards leave the canvas; the token stands in; live cards stay', async ({ mount }) => {
  localStorage.setItem(HIDE_RETIRED_KEY, '1')
  const el = await mountCanvas(mount)
  const shown = cardNames(el)
  for (const gone of ['ret-one', 'ret-two', 'solo-ret']) {
    assert.ok(!shown.includes(gone), `${gone} is hidden (${shown.join(', ')})`)
  }
  assert.ok(shown.includes('boss') && shown.includes('worker'), 'live cards unaffected')
  const tokens = [...el.querySelectorAll('.retired-token')].map((t) => t.textContent)
  assert.deepEqual(tokens.sort(), ['1 retired', '2 retired'],
    'one token per parent with hidden retirees, carrying the count')
  assert.equal(el.querySelectorAll('.pile-stack').length, 0, 'no retired pile remains either')
})

domTest('the token lists the retirees and picking one REVEALS it through the real jump path', async ({ mount }) => {
  localStorage.setItem(HIDE_RETIRED_KEY, '1')
  const el = await mountCanvas(mount)
  const token = [...el.querySelectorAll('.retired-token')]
    .find((t) => t.textContent === '2 retired') as HTMLElement
  assert.ok(token, 'the boss token rendered')
  await inAct(async () => { token.click(); await flush() })
  const picker = el.ownerDocument.querySelector('.pile-picker')
  assert.ok(picker, 'the picker opened')
  const row = [...picker!.querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').includes('ret-one')) as HTMLElement
  assert.ok(row, 'ret-one is listed')
  await inAct(async () => { row.click(); await flush() })
  await advance(400)   // the reveal retries centerOn across two frames
  await flush()
  const shown = cardNames(el)
  assert.ok(shown.includes('ret-one'), `picking revealed the card (${shown.join(', ')})`)
  assert.ok(!shown.includes('ret-two'), 'its still-hidden sibling stays hidden')
  const tokens = [...el.querySelectorAll('.retired-token')].map((t) => t.textContent)
  assert.ok(tokens.includes('1 retired'), 'the token count follows the reveal')
})

domTest('flipping the setting off mid-session brings every retiree back', async ({ mount }) => {
  localStorage.setItem(HIDE_RETIRED_KEY, '1')
  const el = await mountCanvas(mount)
  assert.ok(el.querySelector('.retired-token'), 'fixture: hidden first')
  await inAct(async () => { setHideRetiredOn(false); await flush() })
  const shown = cardNames(el)
  assert.ok(shown.includes('solo-ret'), 'retirees return without a reload')
  assert.equal(el.querySelector('.retired-token'), null)
})
