// bulkcompact.test.tsx — BULK CHEAP COMPACTION FROM THE CONTEXT MENUS (docket
// `add-bulk-cheap-compact-context-menu-actions`, user request 2026-09-23).
//
// Two doors: "Cheap-compact all agents…" on the eye card and "Cheap-compact
// subtree…" in every agent's menu. Both go through canvas/bulkcompact.tsx.
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 where the subtree entry appears and where it does not;
//   §2 the selection — who is a target, who is skipped, and why;
//   §3 the run — one normal `cheap_compact` op per eligible agent, each with
//      `if_idle`, sequentially, and one refusal never aborts the batch;
//   §4 the real surfaces — the Agents List row and the eye card each confirm
//      first, send nothing before the confirm, and then run the ops.
// The backend half (`if_idle` → 409 for a mid-turn agent, nothing changed) is
// tests/test_bulk_cheap_compact_guard.py.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs bulkcompact

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock,
  useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import type { AgentMenuHandlers, RetireKind } from '../src/canvas/agentmenu'
import {
  allAgents, bulkCompactRunning, cheapCompactAgents, planBulkCompact,
  SKIP_BUSY, SKIP_EMPTY, SKIP_UNRUN, subtreeAgents,
} from '../src/canvas/bulkcompact'
import { UserNode } from '../src/canvas/cards'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import { forgetPins } from '../src/canvas/pins'
import { setAgentShortcutsOn, setCrowdPilesOn } from '../src/canvas/shared'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const W = window as unknown as Window & typeof globalThis

/** a live agent with measured context — eligible unless a case says otherwise */
function agent(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, state: 'live', tier: 'haiku', model_id: 'haiku', children: [],
    seat: 1, grant: 0, free: 0, occupancy: 40_000, context_window: 200_000,
    scope: { tools: { mcp: [] }, add_dirs: [] }, audiences_held: [],
    ...extra,
  } as unknown as CanvasNode
}

const handlers = (extra: Partial<AgentMenuHandlers> = {}): AgentMenuHandlers => ({
  onInbox: noop, onSettings: noop, onRetireAsk: noop, ...extra,
})
const labelsOf = (node: CanvasNode, h: AgentMenuHandlers) =>
  agentMenuEntries(node, h).map((e) => (e === 'sep' ? 'sep' : e.label))
const SUBTREE = 'Cheap-compact subtree…'

/* ─── §1 the subtree entry ──────────────────────────────────────────────── */

test('§1a a live agent with live reports offers the subtree entry, above the '
  + 'lifecycle entries and not styled as danger', () => {
  const boss = agent('boss', { children: [agent('kid')] })
  const entries = agentMenuEntries(boss, handlers())
  const labels = entries.map((e) => (e === 'sep' ? 'sep' : e.label))
  assert.ok(labels.includes(SUBTREE), JSON.stringify(labels))
  assert.ok(labels.indexOf(SUBTREE) < labels.indexOf('Retire all subordinates…'))
  const entry = entries.find((e) => e !== 'sep' && e.label === SUBTREE)
  assert.ok(entry && entry !== 'sep' && !entry.danger,
    'compaction retires no one; it must not read as a destructive action')
})

test('§1b absent without live reports, on a retired agent, without the '
  + 'confirm handler, and behind the kiosk gate', () => {
  // the positive control: the same boss WITH everything offers it
  const boss = agent('boss', { children: [agent('kid')] })
  assert.ok(labelsOf(boss, handlers()).includes(SUBTREE))
  for (const [what, labels] of [
    ['a leaf', labelsOf(agent('leaf'), handlers())],
    ['only retired reports', labelsOf(agent('boss', {
      children: [agent('gone', { state: 'archived' })] }), handlers())],
    ['a retired agent', labelsOf(agent('boss', {
      state: 'archived', children: [agent('kid')] }), handlers({ onDismiss: noop }))],
    ['no confirm handler', labelsOf(boss, handlers({ onRetireAsk: undefined }))],
    ['a kiosk viewer', labelsOf(boss, handlers({ canBulkCompact: false }))],
  ] as const) {
    assert.ok(!labels.includes(SUBTREE), `${what}: ${JSON.stringify(labels)}`)
  }
})

test('§1c choosing it opens the subtree confirm through the shared plumbing', () => {
  const asked: RetireKind[] = []
  const boss = agent('boss', { children: [agent('kid')] })
  for (const e of agentMenuEntries(boss, handlers({ onRetireAsk: (k) => asked.push(k) }))) {
    if (e !== 'sep' && e.label === SUBTREE) e.onSelect()
  }
  assert.deepEqual(asked, ['cheap-compact-subtree'])
})

/* ─── §2 the selection ──────────────────────────────────────────────────── */

test('§2a the subtree is the agent itself and every live agent below it, in '
  + 'tree order; retired seats, bearers and drafts are not targets', () => {
  const root = agent('lead', { children: [
    agent('a', { children: [agent('a1'), agent('a-gone', { state: 'archived' })] }),
    agent('lead@0', { state: 'archived', bearer_state: 'knowledge' } as Partial<CanvasNode>),
    { id: '__draft', state: 'draft', tier: 'haiku', children: [] } as unknown as CanvasNode,
    agent('b'),
  ] })
  assert.deepEqual(subtreeAgents(root).map((n) => n.id), ['lead', 'a', 'a1', 'b'])
  // a retired agent's LIVE descendant is still in the branch
  const withLiveUnderRetired = agent('lead', { children: [
    agent('mid', { state: 'archived', children: [agent('deep')] }),
  ] })
  assert.deepEqual(subtreeAgents(withLiveUnderRetired).map((n) => n.id), ['lead', 'deep'])
})

test('§2b all agents is every live seat in the map and nothing else', () => {
  const map = new Map<string, CanvasNode>([
    ['__user', { id: '__user', state: 'user', tier: null, children: [] } as unknown as CanvasNode],
    ['x', agent('x')], ['y', agent('y')],
    ['z', agent('z', { state: 'archived' })],
  ])
  assert.deepEqual(allAgents(map).map((n) => n.id), ['x', 'y'])
})

test('§2c the plan skips exactly what the single action would not offer, plus '
  + 'mid-turn agents, and says why for each', () => {
  const plan = planBulkCompact([
    agent('ok'),
    agent('busy', { busy: true }),
    agent('unrun', { compacted_unrun: true }),
    agent('fresh', { occupancy: null }),
    agent('nowindow', { context_window: null }),
    agent('ok2', { frozen: { error: 'limit' } as CanvasNode['frozen'] }),
  ])
  assert.deepEqual(plan.eligible.map((n) => n.id), ['ok', 'ok2'])
  assert.deepEqual(plan.skipped, [
    { id: 'busy', reason: SKIP_BUSY },
    { id: 'unrun', reason: SKIP_UNRUN },
    { id: 'fresh', reason: SKIP_EMPTY },
    { id: 'nowindow', reason: SKIP_EMPTY },
  ])
})

/* ─── §3 the run ────────────────────────────────────────────────────────── */

const failWith = (message: string, status?: number) =>
  Object.assign(new Error(message), status ? { status } : {})

test('§3a one op per eligible agent, in order, each with if_idle; a refusal '
  + 'does not stop the rest, and the summary names every outcome', async () => {
  const sent: OpRequest[] = []
  const quiet: (boolean | undefined)[] = []
  const said: string[][] = []
  const plan = planBulkCompact([
    agent('a'), agent('b'), agent('c'), agent('d'), agent('busy', { busy: true }),
  ])
  const outcome = await cheapCompactAgents('all agents', plan, async (body, opts) => {
    sent.push(body)
    quiet.push(opts?.quiet)
    if (body.node === 'b') throw failWith('b still owns open background tasks', 422)
    if (body.node === 'c') throw failWith('c is mid-turn — not cheap-compacted', 409)
    return {} as OpResult
  }, (lines) => { if (lines) said.push(lines) })
  assert.deepEqual(sent, ['a', 'b', 'c', 'd'].map((node) =>
    ({ op: 'cheap_compact', node, if_idle: true })))
  // every call is QUIET: the summary reports refusals, so the shared op
  // wrapper must not add an "error: …" toast for a target it calls a skip
  assert.deepEqual(quiet, [true, true, true, true])
  assert.ok(outcome)
  assert.deepEqual(outcome!.compacted, ['a', 'd'])
  // the 409 is the backend's mid-turn refusal: a SKIP, not a failure
  assert.deepEqual(outcome!.skipped.map((s) => s.id), ['busy', 'c'])
  assert.deepEqual(outcome!.failed, [{ id: 'b', reason: 'b still owns open background tasks' }])
  assert.match(said[0][0], /Cheap-compacting 4 agents \(all agents\), one at a time/)
  const summary = said[said.length - 1].join('\n')
  assert.match(summary, /Cheap-compacted 2 agents \(all agents\): a, d\./)
  assert.match(summary, /Skipped 2 agents: busy \(mid-turn[^)]*\); c \(mid-turn/)
  assert.match(summary, /Could not cheap-compact 1 agent: b \(b still owns open background tasks\)/)
  assert.equal(bulkCompactRunning(), false, 'the run guard was left set')
})

test('§3b nothing eligible sends nothing and says nothing changed', async () => {
  const sent: OpRequest[] = []
  const said: string[][] = []
  const outcome = await cheapCompactAgents('subtree of x',
    planBulkCompact([agent('x', { busy: true })]),
    async (b) => { sent.push(b); return {} as OpResult },
    (lines) => { if (lines) said.push(lines) })
  assert.equal(sent.length, 0)
  assert.deepEqual(outcome!.compacted, [])
  assert.equal(said.length, 1, 'no start line when nothing will run')
  assert.match(said[0][0], /Skipped 1 agent: x \(mid-turn/)
})

test('§3c a second bulk run while one is in flight is refused, and the guard '
  + 'clears afterwards', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const sent: string[] = []
  const said: string[][] = []
  const toast = (lines: string[] | null | undefined) => { if (lines) said.push(lines) }
  const first = cheapCompactAgents('all agents', planBulkCompact([agent('a')]),
    async (b) => { sent.push(b.node!); await gate; return {} as OpResult }, toast)
  const second = await cheapCompactAgents('all agents', planBulkCompact([agent('b')]),
    async (b) => { sent.push(b.node!); return {} as OpResult }, toast)
  assert.equal(second, null)
  assert.ok(said.some((l) => /already running/.test(l[0])))
  release()
  await first
  assert.deepEqual(sent, ['a'])
  const third = await cheapCompactAgents('all agents', planBulkCompact([agent('c')]),
    async (b) => { sent.push(b.node!); return {} as OpResult }, toast)
  assert.deepEqual(third!.compacted, ['c'])
})

test('§3d a failure thrown by the transport itself still clears the guard', async () => {
  await cheapCompactAgents('all agents', planBulkCompact([agent('a')]),
    () => Promise.reject(new Error('network down')), noop)
  assert.equal(bulkCompactRunning(), false)
})

/* ─── §4 the real surfaces ──────────────────────────────────────────────── */

// the canvas fixture is agentrowmenu.test.tsx's (itself contextmenu's)
function mkNode(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: 40000,
    context_window: 200000, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [], busy: false,
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
    ...extra,
  }
}
function tree(roots: unknown[], patch: Record<string, unknown> = {}): TreePayload {
  return {
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
    audience_requests: [], org_inbox: null, net: null, ...patch,
  } as unknown as TreePayload
}
type Cap = { setPointerCapture?: unknown; releasePointerCapture?: unknown; hasPointerCapture?: unknown }
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Cap } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture, h: proto.hasPointerCapture }
  proto.setPointerCapture = () => {}; proto.releasePointerCapture = () => {}; proto.hasPointerCapture = () => false
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r; proto.hasPointerCapture = had.h }
}
async function rightClick(el: Element) {
  const ev = new W.MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })
  await inAct(() => { el.dispatchEvent(ev) })
  await flush(2)
}
const labels = () => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .map((b) => b.textContent ?? '')
async function pick(label: string) {
  const b = [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
    .find((x) => x.textContent === label) as HTMLButtonElement | undefined
  assert.ok(b, `menu item "${label}" present — have ${JSON.stringify(labels())}`)
  await inAct(() => {
    b!.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    b!.click()
  })
  await flush(2)
}
const confirmBox = () => document.querySelector('.confirm-box') as HTMLElement | null
async function confirm() {
  const go = confirmBox()!.querySelector('button.danger.solid') as HTMLButtonElement
  await inAct(() => { go.click() })
  await flush(6)
}

test('§4a the Agents List row: confirm names the branch and its skips, sends '
  + 'nothing before the confirm, then compacts the branch head and its live '
  + 'reports only', async (t: TestContext) => {
  useFakeClock()
  forgetPins()
  setCrowdPilesOn(false)
  t.after(() => { forgetPins(); realClock() })
  t.after(stubPointerCapture())
  resetConvos()
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  const ops: OpRequest[] = []
  const notices: string[][] = []
  const v = await mountView(
    <OrgCanvas tree={tree([
      mkNode('boss', { children: [
        mkNode('kid-a', { parent: 'boss' }),
        mkNode('kid-busy', { parent: 'boss', busy: true }),
        mkNode('kid-b', { parent: 'boss', children: [
          mkNode('grandkid', { parent: 'kid-b' })] }),
      ] }),
      mkNode('outsider'),
    ])} slug="mine"
      op={(b) => { ops.push(b); return Promise.resolve({}) }}
      toast={(lines) => { if (lines) notices.push(lines) }}
      mailEvt={null} />, (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(400, 50); await flush()
  const toggle = v.el.querySelector('.tray-toggle') as HTMLElement
  await inAct(() => { toggle.click() })
  await flush(2)
  const row = [...v.el.querySelectorAll('.tray-row')].find((r) =>
    r.querySelector('.tray-name')?.textContent === 'boss') as HTMLElement
  assert.ok(row, 'the boss row rendered')
  await rightClick(row)
  await pick(SUBTREE)
  const box = confirmBox()
  assert.ok(box, 'no confirmation appeared')
  assert.match(box!.querySelector('h3')?.textContent ?? '', /cheap-compact boss and its subtree\?/)
  const text = box!.textContent ?? ''
  assert.match(text, /4 agents will be cheap-compacted, one at a time: boss, kid-a, kid-b, grandkid/)
  assert.match(text, /Skipped \(1\): kid-busy \(mid-turn/)
  assert.equal(ops.length, 0, 'nothing may be sent before the confirm')
  await confirm()
  assert.deepEqual(ops.map((o) => o.node), ['boss', 'kid-a', 'kid-b', 'grandkid'])
  assert.ok(ops.every((o) => o.op === 'cheap_compact' && o.if_idle === true))
  assert.ok(!ops.some((o) => o.node === 'outsider' || o.node === 'kid-busy'))
  assert.ok(notices.some((l) => l.some((x) => /Cheap-compacted 4 agents \(subtree of boss\)/.test(x))),
    JSON.stringify(notices))
})

const seats = { haiku: 1, sonnet: 2, opus: 5 }
const eye = (map: Map<string, CanvasNode>, op: (b: OpRequest) => Promise<OpResult>,
  pub = false) => (
  <UserNode pos={{ x: 0, y: 0 }} isDrop={false}
    stats={{ circ: 0, seats: 0, free: 0 }} pip={null} seats={seats}
    pub={pub} kiosk={undefined} kioskRemaining={null} pxc={1} zoom={1}
    onSpawn={noop} onMailLink={noop} focused={false} eyeW={124}
    posX={() => 0} map={map} op={op} slug="org" toast={noop}
    onInbox={noop} onGear={noop} />
)

test('§4b the eye card: "Cheap-compact all agents…" confirms, then compacts '
  + 'every eligible live agent, skipping the rest', async (t: TestContext) => {
  setAgentShortcutsOn(false)
  const ops: OpRequest[] = []
  const map = new Map<string, CanvasNode>([
    ['one', agent('one')],
    ['two', agent('two', { parent: 'one' })],
    ['idle-empty', agent('idle-empty', { occupancy: null })],
    ['gone', agent('gone', { state: 'archived' })],
  ])
  const view = await mountView(eye(map, (b) => { ops.push(b); return Promise.resolve({} as OpResult) }),
    (el) => el)
  t.after(async () => { await view.unmount() })
  await rightClick(view.el.querySelector('.sq.user')!)
  await pick('Cheap-compact all agents…')
  const box = confirmBox()
  assert.ok(box, 'no confirmation appeared before compacting every agent')
  assert.match(box!.querySelector('h3')?.textContent ?? '', /cheap-compact all agents\?/)
  assert.match(box!.textContent ?? '', /2 agents will be cheap-compacted/)
  assert.match(box!.textContent ?? '', /idle-empty \(no measured context/)
  assert.equal(ops.length, 0, 'nothing may be sent before the confirm')
  await confirm()
  assert.deepEqual(ops, [
    { op: 'cheap_compact', node: 'one', if_idle: true },
    { op: 'cheap_compact', node: 'two', if_idle: true },
  ])
})

test('§4c a kiosk viewer\'s eye card does not offer it', async (t: TestContext) => {
  setAgentShortcutsOn(false)
  const view = await mountView(eye(new Map([['one', agent('one')]]),
    () => Promise.resolve({} as OpResult), true), (el) => el)
  t.after(async () => { await view.unmount() })
  await rightClick(view.el.querySelector('.sq.user')!)
  // positive control: the menu really opened
  assert.ok(labels().includes('Retire all agents…'), JSON.stringify(labels()))
  assert.ok(!labels().includes('Cheap-compact all agents…'))
})
