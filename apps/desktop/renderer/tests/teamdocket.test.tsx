// teamdocket.test.tsx — THE TEAM DOCKET: one agent's docket widened to its
// whole subtree, opened from that agent's context menu and nowhere else
// (ticket `add-a-team-docket-view`, 2.1.5-RC1 entry-surface ruling).
//
// TWO LAYERS, DELIBERATELY SEPARATE.
//   §1-§6 are the MEMBERSHIP RULE as pure functions (`teamNodeIds`,
//     `teamItems`). Membership is the whole feature — who is in the team and
//     which tickets that lets through — and it is testable without a DOM, so
//     the depth, exclusion, reassignment, reparent and permission cases are
//     asserted where an assertion cannot be satisfied by a coincidence of
//     rendering.
//   §7-§12 are the SURFACE: the context-menu entry that is the only door,
//     the panel it opens, the ticket detail inside it, the empty state, and
//     the two things that must NOT have changed — the single-agent docket and
//     the full work docket.
//
// ⚠ THE VIEWER'S TREE IS THE PERMISSION BOUNDARY, and §6 is the case that says
// so: an item owned by an agent the viewer's tree does not contain is excluded
// even when its name looks like it belongs under the root. The team view can
// only ever narrow what the backend already served this viewer.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs teamdocket

// ⚠ THE HARNESS IMPORT COMES FIRST — see the import-order note in harness.ts.
import {
  advance, flush, inAct, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  DocketModal, agentItems, teamItems, teamNodeIds,
} from '../src/canvas/docket'
import { TeamDocketModal } from '../src/canvas/teamdocket'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import { forgetPins } from '../src/canvas/pins'
import { setCrowdPilesOn } from '../src/canvas/shared'
import type { TreeNode, TreePayload, WorkItem } from '../src/types'

const noop = () => {}
const W = window as unknown as Window & typeof globalThis
const asTree = (v: unknown) => v as TreePayload

// ------------------------------------------------------------------ fixtures
// (the node/tree shape is contextmenu.test.tsx's and agentrowmenu.test.tsx's,
// verbatim — one fixture idiom for the canvas)
function mkNode(id: string, extra: Record<string, unknown> = {}): TreeNode {
  return {
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
    ...extra,
  } as unknown as TreeNode
}
function tree(roots: TreeNode[]): TreePayload {
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots, cost_usd_total: 0,
    audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

const mkItem = (o: Partial<WorkItem>): WorkItem => ({
  slug: 'test-work-item',
  rev: 1,
  kind: 'code',
  title: 'Test Work Item',
  objective: 'Test objective',
  status: 'in_progress',
  blocked_reason: null,
  archived: false,
  archived_at: null,
  owner: { node: 'agent1', generation: 1 },
  owner_current: true,
  owner_state: 'live',
  reviewer: null,
  participants: [],
  created_by: { node: 'agent1', generation: 1 },
  at: '2026-09-05T08:00:00.000Z',
  updated_at: '2026-09-05T09:00:00.000Z',
  done_so_far: ['First step completed'],
  working_on_next: ['Second step in progress'],
  docket_at: '2026-09-05T09:00:00.000Z',
  last_updater: { node: 'agent1', generation: 1 },
  manual_attention: null,
  dismissals: [],
  questions: [],
  effective_attention: false,
  attention_sources: [],
  acceptance: [],
  dependencies: [],
  evidence: [],
  delivery: null,
  accepted: null,
  superseded_by: null,
  history: [],
  ...o,
} as unknown as WorkItem)

/** an item named for its owner, so every assertion below reads as "whose work
 *  came through" rather than as an index into a list */
const owned = (slug: string, node: string, extra: Partial<WorkItem> = {}) =>
  mkItem({ slug, title: slug, owner: { node, generation: 0 }, ...extra })

/** THE STANDING ORG for the membership cases:
 *
 *      lead ── mid ── deep ── deeper        (the team)
 *        └──── sib                          (also the team: a second branch)
 *      outsider                             (a separate root)
 *        └──── outkid                       (and its report)
 */
const ORG = [
  mkNode('lead', {
    children: [
      mkNode('mid', {
        parent: 'lead',
        children: [mkNode('deep', {
          parent: 'mid',
          children: [mkNode('deeper', { parent: 'deep' })],
        })],
      }),
      mkNode('sib', { parent: 'lead' }),
    ],
  }),
  mkNode('outsider', { children: [mkNode('outkid', { parent: 'outsider' })] }),
]

const slugsOf = (items: WorkItem[] | null) => (items ?? []).map((i) => i.slug).sort()

// ======================================================== §1 the member set
test('§1 a team is the agent and every descendant of it, at any depth', () => {
  assert.deepEqual([...teamNodeIds(ORG, 'lead')].sort(),
    ['deep', 'deeper', 'lead', 'mid', 'sib'],
    'four levels of reports, both branches, and the root itself')
  assert.deepEqual([...teamNodeIds(ORG, 'mid')].sort(), ['deep', 'deeper', 'mid'],
    'rooting at a middle agent takes its own subtree, not its ancestors')
  assert.deepEqual([...teamNodeIds(ORG, 'deeper')].sort(), ['deeper'],
    'a leaf is a team of one — itself')
})

test('§1b an agent the viewer\'s tree does not hold is a team of ONE, never the whole org', () => {
  // the failure this rules out is the dangerous one: answering "everything"
  // would silently turn the team docket into the full docket
  assert.deepEqual([...teamNodeIds(ORG, 'stranger')], ['stranger'])
  assert.deepEqual([...teamNodeIds(undefined, 'lead')], ['lead'],
    'and so is every agent while the tree is still loading')
})

// ================================================ §2 direct and nested items
test('§2 the docket includes the root\'s own items and its descendants\' at every depth', () => {
  const data = {
    items: [
      owned('lead-task', 'lead'),
      owned('mid-task', 'mid'),
      owned('deep-task', 'deep'),
      owned('deeper-task', 'deeper'),
      owned('sib-task', 'sib'),
    ],
  }
  assert.deepEqual(slugsOf(teamItems(data, 'lead', ORG)),
    ['deep-task', 'deeper-task', 'lead-task', 'mid-task', 'sib-task'])
  assert.deepEqual(slugsOf(teamItems(data, 'mid', ORG)),
    ['deep-task', 'deeper-task', 'mid-task'],
    'rooted at mid, the lead\'s own work and the sibling branch are out')
})

// ==================================================== §3 what is excluded
test('§3 ancestors, siblings and unrelated branches are excluded', () => {
  const data = {
    items: [
      owned('lead-task', 'lead'),        // the ANCESTOR of mid
      owned('sib-task', 'sib'),          // a SIBLING branch under lead
      owned('mid-task', 'mid'),
      owned('outsider-task', 'outsider'),  // an unrelated root
      owned('outkid-task', 'outkid'),      // and its report
    ],
  }
  assert.deepEqual(slugsOf(teamItems(data, 'mid', ORG)), ['mid-task'])
  assert.deepEqual(slugsOf(teamItems(data, 'lead', ORG)),
    ['lead-task', 'mid-task', 'sib-task'],
    'the other root\'s whole branch stays out of lead\'s team')
})

test('§3b an UNOWNED item is in nobody\'s team', () => {
  const data = { items: [owned('lead-task', 'lead'), mkItem({ slug: 'orphan', owner: null })] }
  assert.deepEqual(slugsOf(teamItems(data, 'lead', ORG)), ['lead-task'])
})

test('§3c a REVIEWER on the team does not pull in an item the team does not own', () => {
  // deliberately narrower than `agentItems`, which hands an agent its reviews:
  // the ticket says membership is the assigned OWNER, and an item "assigned
  // outside that subtree" is excluded. The reviewer still sees it on its own
  // desk docket — §11 is the control that proves that rule is untouched.
  const review = owned('outsider-task', 'outsider', { reviewer: { node: 'mid', generation: 0 }, status: 'review' })
  const data = { items: [owned('mid-task', 'mid'), review] }
  assert.deepEqual(slugsOf(teamItems(data, 'lead', ORG)), ['mid-task'])
  assert.deepEqual(slugsOf(agentItems(data, 'mid')), ['mid-task', 'outsider-task'],
    'positive control: the agent docket DOES still give mid its review')
})

test('§3d archived items join only when the archive filter asks for them', () => {
  const data = {
    items: [owned('mid-task', 'mid')],
    backlogged: [owned('deep-backlog', 'deep', { status: 'backlogged' })],
    archived: [owned('deep-archive', 'deep', { archived: true, status: 'done' })],
  }
  assert.deepEqual(slugsOf(teamItems(data, 'lead', ORG)), ['deep-backlog', 'mid-task'],
    'backlogged rows always come through; the view\'s own checkbox hides them')
  assert.deepEqual(slugsOf(teamItems(data, 'lead', ORG, true)),
    ['deep-archive', 'deep-backlog', 'mid-task'])
})

test('§3e a null payload is LOADING, not an empty team', () => {
  assert.equal(teamItems(null, 'lead', ORG), null)
  assert.equal(teamItems(undefined, 'lead', ORG), null)
  assert.deepEqual(teamItems({ items: [] }, 'lead', ORG), [],
    'and an empty answer is an empty list, which the view says out loud')
})

// ================================================= §4 it follows reassignment
test('§4 membership follows the CURRENT assignment — a reassignment moves the row', () => {
  const before = { items: [owned('task', 'outsider')] }
  assert.deepEqual(slugsOf(teamItems(before, 'lead', ORG)), [],
    'owned outside the team: not in the team docket')
  const after = { items: [owned('task', 'deep')] }
  assert.deepEqual(slugsOf(teamItems(after, 'lead', ORG)), ['task'],
    'reassigned onto a descendant: the very next refresh has it')
  assert.deepEqual(slugsOf(teamItems(before, 'outsider', ORG)), ['task'])
  assert.deepEqual(slugsOf(teamItems(after, 'outsider', ORG)), [],
    'and it has left the old team in the same breath')
})

// =================================================== §5 it follows the tree
test('§5 membership follows the CURRENT hierarchy — a reparent moves the branch', () => {
  const data = { items: [owned('deep-task', 'deep'), owned('deeper-task', 'deeper')] }
  assert.deepEqual(slugsOf(teamItems(data, 'lead', ORG)), ['deep-task', 'deeper-task'])
  assert.deepEqual(slugsOf(teamItems(data, 'outsider', ORG)), [])
  // the same items, the same viewer — `deep` (with `deeper` under it) has been
  // reparented from `mid` onto `outsider`
  const moved = [
    mkNode('lead', { children: [mkNode('mid', { parent: 'lead' }), mkNode('sib', { parent: 'lead' })] }),
    mkNode('outsider', {
      children: [
        mkNode('outkid', { parent: 'outsider' }),
        mkNode('deep', { parent: 'outsider', children: [mkNode('deeper', { parent: 'deep' })] }),
      ],
    }),
  ]
  assert.deepEqual(slugsOf(teamItems(data, 'lead', moved)), [],
    'the branch left: nothing was cached from the previous shape')
  assert.deepEqual(slugsOf(teamItems(data, 'outsider', moved)), ['deep-task', 'deeper-task'],
    'and it arrived, whole, at its new superior')
})

// ============================================== §6 the permission boundary
test('§6 the viewer\'s own tree is the boundary — an invisible agent contributes nothing', () => {
  // a viewer whose payload is pruned at `mid` (the backend served no deeper
  // nodes). `deep` and `deeper` are REAL and own work, but this viewer may not
  // see them, so the team docket must not either — even rooted at lead.
  const pruned = [mkNode('lead', { children: [mkNode('mid', { parent: 'lead' })] })]
  const data = {
    items: [
      owned('lead-task', 'lead'),
      owned('mid-task', 'mid'),
      owned('deep-task', 'deep'),
      owned('deeper-task', 'deeper'),
    ],
  }
  assert.deepEqual(slugsOf(teamItems(data, 'lead', pruned)), ['lead-task', 'mid-task'],
    'the team docket NARROWS what this viewer can see; it cannot widen it')
  // and the same rule seen from the other end: rooting at an agent this viewer
  // does not hold at all yields that agent's own rows and nothing more
  assert.deepEqual(slugsOf(teamItems(data, 'deep', pruned)), ['deep-task'])
})

// ============================================================ the surface
async function mountPanel(t: TestContext, roots: TreeNode[], nid: string,
  payload: Record<string, unknown>) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string) => {
    const headers = new Headers()
    const body = String(url).includes('/work-items') ? payload : {}
    return Promise.resolve({ ok: true, status: 200, headers, json: () => Promise.resolve(body) })
  }) as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  let closed = 0
  const v = await mountView(
    <TeamDocketModal slug="mine" nid={nid} tree={tree(roots)} toast={noop}
      close={() => { closed++ }} refs={{ world: { org: 'mine' }, onOpen: noop }} />,
    (h) => h)
  t.after(() => v.unmount())
  await flush(4)
  return { el: v.el, closed: () => closed }
}

function panelTest(name: string, body: (t: TestContext) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    try { await body(t) } finally { realClock() }
  })
}

const rowNames = (el: HTMLElement) =>
  [...el.querySelectorAll('.docket-row .docket-rowname')]
    .map((n) => n.textContent ?? '').sort()

panelTest('§7 the panel is rooted at the agent it was opened on, and says so', async (t) => {
  const p = await mountPanel(t, ORG, 'mid', {
    items: [owned('lead-task', 'lead'), owned('mid-task', 'mid'),
            owned('deep-task', 'deep'), owned('outsider-task', 'outsider')],
  })
  const head = p.el.querySelector('h3')?.textContent ?? ''
  assert.match(head, /mid/, 'the selected agent stays identifiable in the panel')
  assert.match(head, /Team docket/, 'and the panel says which of its two dockets this is')
  assert.deepEqual(rowNames(p.el), ['deep-task', 'mid-task'],
    'the root\'s own item and its descendant\'s — the ancestor and the outsider are out')
})

panelTest('§8 a filtered row opens the ORDINARY ticket detail', async (t) => {
  const p = await mountPanel(t, ORG, 'lead', {
    items: [owned('deep-task', 'deep', { objective: 'A distinctive objective line' })],
  })
  assert.match(p.el.textContent ?? '', /select an item to view it/, 'nothing selected yet')
  const row = p.el.querySelector('.docket-row') as HTMLElement
  assert.ok(row, 'the descendant\'s row rendered')
  await inAct(() => { row.click() })
  await flush(4)
  assert.match(p.el.querySelector('.mailer-read')?.textContent ?? '',
    /A distinctive objective line/,
    'the docket\'s own detail pane, not a reduced one written for this view')
})

panelTest('§9 an EMPTY team says so, and never falls back to the full docket', async (t) => {
  const p = await mountPanel(t, ORG, 'sib', {
    // plenty of work in the org — none of it this team's
    items: [owned('lead-task', 'lead'), owned('deep-task', 'deep'),
            owned('outsider-task', 'outsider')],
  })
  assert.deepEqual(rowNames(p.el), [], 'no rows at all')
  const text = p.el.textContent ?? ''
  assert.match(text, /no docket items are assigned to sib or to any agent below it/,
    'the empty state names the TEAM rule, not the single-agent one')
  assert.doesNotMatch(text, /lead-task|deep-task|outsider-task/,
    'and shows none of the work it filtered out')
})

panelTest('§9b a team of one with work still shows it', async (t) => {
  const p = await mountPanel(t, ORG, 'deeper', { items: [owned('deeper-task', 'deeper')] })
  assert.deepEqual(rowNames(p.el), ['deeper-task'])
})

// ------------------------------------------------- §10 the only door: the menu
type Cap = { setPointerCapture?: unknown; releasePointerCapture?: unknown; hasPointerCapture?: unknown }
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Cap } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture, h: proto.hasPointerCapture }
  proto.setPointerCapture = () => {}; proto.releasePointerCapture = () => {}; proto.hasPointerCapture = () => false
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r; proto.hasPointerCapture = had.h }
}

async function rightClick(el: Element): Promise<boolean> {
  const ev = new W.MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })
  await inAct(() => { el.dispatchEvent(ev) })
  await flush(2)
  return ev.defaultPrevented
}
const menuItems = () => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')] as HTMLButtonElement[]
const labels = () => menuItems().map((b) => b.textContent ?? '')
async function pick(label: string) {
  const b = menuItems().find((x) => x.textContent === label)
  assert.ok(b, `menu item "${label}" present — have ${JSON.stringify(labels())}`)
  await inAct(() => {
    b!.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    b!.click()
  })
  await flush(2)
}
async function esc() {
  await inAct(() => {
    document.body.dispatchEvent(new W.KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await flush(2)
}

async function mountCanvas(t: TestContext, roots: TreeNode[], items: WorkItem[]) {
  t.after(stubPointerCapture())
  resetConvos()
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had });
  // zoomdocket.test.tsx's shape: the canvas asks for very little, and the one
  // route this file cares about is the docket poll
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    const body = String(url).includes('/work-items')
      ? { items, archived: [], backlogged: [], counts: { active: items.length, archived: 0, attention: 0, backlogged: 0 }, now: '2026-09-07T06:45:00Z' }
      : {}
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  const v = await mountView(
    <OrgCanvas tree={tree(roots)} slug="mine" op={async () => ({} as never)}
      toast={noop} mailEvt={null} />, (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(400, 50); await flush()
  return v
}

const cardFor = (el: HTMLElement, id: string) =>
  [...el.querySelectorAll('.sq')].find((c) =>
    c.getAttribute('data-copy-agent-name') === id
    || c.querySelector('.sq-title .name')?.textContent === id) as HTMLElement | undefined
const rowFor = (el: HTMLElement, id: string) =>
  [...el.querySelectorAll('.tray-row')].find((r) =>
    r.querySelector('.tray-name')?.textContent === id) as HTMLElement | undefined

function canvasTest(name: string, body: (t: TestContext) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock(); forgetPins(); setCrowdPilesOn(false)
    try { localStorage.removeItem('orgtree-pile-mine') } catch { /* private mode */ }
    try { await body(t) } finally { forgetPins(); setCrowdPilesOn(false); realClock() }
  })
}

canvasTest('§10 the agent\'s context menu offers it, beside the single-agent docket, on BOTH surfaces',
  async (t) => {
    const v = await mountCanvas(t, [mkNode('lead', { children: [mkNode('mid', { parent: 'lead' })] })], [])
    const card = cardFor(v.el, 'lead')
    assert.ok(card, 'the agent has a card')
    assert.equal(await rightClick(card!), true, 'the right-click was taken')
    const fromCard = labels()
    assert.ok(fromCard.includes('Open team docket'),
      `the card's menu offers it — have ${JSON.stringify(fromCard)}`)
    assert.equal(fromCard.indexOf('Open team docket'), fromCard.indexOf('Open docket') + 1,
      'directly after "Open docket": the same question at the wider scope')
    await esc()
    // and the Agents List row, which shares the one menu definition
    const toggle = v.el.querySelector('.tray-toggle') as HTMLElement
    await inAct(() => { toggle.click() }); await flush(2)
    const row = rowFor(v.el, 'lead')
    assert.ok(row, 'the agent has a row in the Agents List')
    await rightClick(row!)
    assert.deepEqual(labels(), fromCard,
      'the row and the card must never drift apart — one menu, one definition')
    await esc()
  })

canvasTest('§10b it is ACCESSIBLE the way every other entry is, and keyboard-reachable',
  async (t) => {
    const v = await mountCanvas(t, [mkNode('lead', { children: [mkNode('mid', { parent: 'lead' })] })], [])
    await rightClick(cardFor(v.el, 'lead')!)
    const menu = document.querySelector('.ctxmenu') as HTMLElement
    assert.ok(menu, 'a menu opened')
    assert.equal(menu.getAttribute('role'), 'menu')
    const entry = menuItems().find((b) => b.textContent === 'Open team docket')
    assert.ok(entry, 'the entry is in the menu')
    assert.equal(entry!.getAttribute('role'), 'menuitem',
      'it is a real menuitem, not a decorated div')
    assert.equal(entry!.tagName, 'BUTTON', 'so it is focusable and Enter-activated')
    assert.match(entry!.getAttribute('title') ?? '', /lead/,
      'and its hover help says whose team, in words')
    await esc()
  })

canvasTest('§10c picking it opens the team docket rooted at THAT agent — the whole entry surface',
  async (t) => {
    const roots = [
      mkNode('lead', {
        children: [mkNode('mid', { parent: 'lead', children: [mkNode('deep', { parent: 'mid' })] })],
      }),
      mkNode('outsider'),
    ]
    const v = await mountCanvas(t, roots, [
      owned('lead-task', 'lead'), owned('deep-task', 'deep'),
      owned('outsider-task', 'outsider'),
    ])
    // BEFORE the menu: the RC1 ruling is that nothing in the app's own chrome
    // offers this view. No tab, no toolbar mode, no chooser, no destination —
    // the context menu is the only door, so until one is raised the words do
    // not appear anywhere on screen.
    assert.doesNotMatch(document.body.textContent ?? '', /team docket/i,
      'no permanent top-level entry surface was added')
    await rightClick(cardFor(v.el, 'lead')!)
    await pick('Open team docket')
    await flush(6)
    const heads = [...document.querySelectorAll('h3')].map((h) => h.textContent ?? '')
    assert.ok(heads.some((h) => /lead/.test(h) && /Team docket/.test(h)),
      `the team docket opened, rooted at lead — have ${JSON.stringify(heads)}`)
    const panel = document.querySelector('.docket-agent') as HTMLElement
    assert.ok(panel, 'the reduced docket rendered')
    assert.deepEqual(rowNames(panel), ['deep-task', 'lead-task'],
      'the root and its two-deep descendant; the other root\'s work is out')
    // and it closes the way every other docket panel does — no bespoke exit
    const close = [...document.querySelectorAll('.overlay button')]
      .find((b) => b.textContent === 'Close') as HTMLButtonElement | undefined
    assert.ok(close, 'the panel has the ordinary Close')
    await inAct(() => { close!.click() }); await flush(4)
    assert.equal(document.querySelector('.docket-agent'), null, 'and it closed')
    assert.doesNotMatch(document.body.textContent ?? '', /team docket/i,
      'leaving nothing permanent behind')
  })

canvasTest('§10d the single-agent docket is still its own entry and still its own view',
  async (t) => {
    const roots = [mkNode('lead', { children: [mkNode('mid', { parent: 'lead' })] })]
    const v = await mountCanvas(t, roots, [owned('lead-task', 'lead'), owned('mid-task', 'mid')])
    await rightClick(cardFor(v.el, 'lead')!)
    await pick('Open docket')
    await flush(6)
    const panel = document.querySelector('.docket-agent') as HTMLElement
    assert.ok(panel, 'the agent docket opened')
    assert.deepEqual(rowNames(panel), ['lead-task'],
      'ITS filter is unchanged: lead\'s own work, not its team\'s')
    assert.ok([...document.querySelectorAll('h3')].some((h) =>
      /· Docket/.test(h.textContent ?? '')), 'and it is still titled as itself')
  })

// ------------------------------------------ §11/§12 what must not have moved
test('§11 the single-agent filter is untouched — owner OR reviewer, at any generation', () => {
  const data = {
    items: [
      owned('mine-task', 'mid'),
      owned('theirs', 'outsider', { reviewer: { node: 'mid', generation: 0 } }),
      owned('elsewhere', 'outkid'),
    ],
    archived: [owned('mine-archive', 'mid', { archived: true })],
  }
  assert.deepEqual(slugsOf(agentItems(data, 'mid')), ['mine-task', 'theirs'])
  assert.deepEqual(slugsOf(agentItems(data, 'mid', true)),
    ['mine-archive', 'mine-task', 'theirs'])
})

panelTest('§12 the FULL work docket still shows every item, whoever owns it', async (t) => {
  const items = [owned('lead-task', 'lead'), owned('deep-task', 'deep'),
                 owned('outsider-task', 'outsider'), mkItem({ slug: 'orphan', title: 'orphan', owner: null })]
  const had = (globalThis as { fetch?: typeof fetch }).fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string) => {
    const headers = new Headers()
    const body = String(url).includes('/work-items')
      ? { items, counts: { active: items.length, archived: 0, attention: 0, backlogged: 0 }, now: '2026-09-07T06:45:00Z' }
      : {}
    return Promise.resolve({ ok: true, status: 200, headers, json: () => Promise.resolve(body) })
  }) as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  const v = await mountView(
    <DocketModal slug="mine" toast={noop} close={noop} tree={tree(ORG)} />, (h) => h)
  t.after(() => v.unmount())
  await flush(6)
  assert.deepEqual(rowNames(v.el),
    ['deep-task', 'lead-task', 'orphan', 'outsider-task'],
    'the full docket is an additional-view\'s BASE, not something the team view replaced')
})
