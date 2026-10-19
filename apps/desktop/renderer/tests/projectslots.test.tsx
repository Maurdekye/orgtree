// projectslots.test.tsx — a project's SLOTS on the desktop (Orgtree 4.4.0;
// docket `project-slots-first-come-permits-claimed-through`, user 2026-10-18
// 08:37Z-08:46Z, mockup approved with canvas-line option A).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the slot state from the tree: the count from the project's scope, the
//      holders from the leases, the line from the armed claims in order;
//      the card badge, the desk header card and the tab's lead line;
//   §2 the canvas lines: a holder's solid, a waiter's dashed, and an agent's
//      several lines to one project side by side, never on one another;
//   §3 a slot claim's card text and a holder's chip; the agent card carries
//      the chip in its chip row, never on the status row, and the agent
//      desk's header beside the $ chip, a waiting claim's too (user
//      2026-10-18 10:52Z);
//   §4 project settings: a "Slots" count (0 = none), one set_slots on save;
//   §5 the desk's Slots tab: shown only with a count, its lead, Holding, Line
//      and Recent holds, the empty state, force release after a
//      confirmation and remove from line.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectslots

import test, { mock } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import { SlotsView } from '../src/canvas/slotsdesk'
import { NodeSquare } from '../src/canvas/cards'
import { DeskChat } from '../src/canvas/desk'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { AgentSurfaceRoutesProvider } from '../src/canvas/panelcorner'
import { resetConvos } from '../src/convo'
import { NodeConfig } from '../src/canvas/modals'
import { ProjectDesk } from '../src/canvas/projectdesk'
import {
  ordinal, projectLineLanes, projectSlotState, slotBadgeText, slotClaimText, slotCount, slotHeaderText,
  slotHoldsOf, slotLeadText, slotLinks,
} from '../src/canvas/slots'
import type { SlotLease } from '../src/canvas/slots'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'
import type { TreePayload, Watchdog } from '../src/types'

const noop = () => {}
const refs = { world: { org: 'org' }, onOpen: noop } as never

function project(scope: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'build', title: 'build', tier: 'project', kind: 'project', state: 'live', model_id: '',
    seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [], ...scope },
    parent: 'boss', charter: 'The build machine.',
    children: [{ id: 'sa', title: 'sa', tier: 'haiku', state: 'live', busy: false, children: [] }],
    lineage: [], turns: [], audiences_held: [], mail_pending: 0,
    last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
  } as unknown as CanvasNode
}

function claim(owner: string, name: string, queued: string, extra: Partial<Watchdog> = {}): Watchdog {
  return { id: owner + '/w1', owner, name, kind: 'slot', target: 'build', interval_s: 5, state: 'armed',
    at: queued, fired: 0, once: true, spent: false, queued_at: queued, ...extra } as Watchdog
}
const lease = (agent: string, slot = 1, extra: Partial<SlotLease> = {}): SlotLease =>
  ({ project: 'build', agent, slot, lease: 's3f1c', reason: 'alpha7-build', since: '2026-10-18T09:00:00.000Z', reminders: 0, ...extra })

// sb joined after sc, so sc is 1st; a paused claim is out of the line
const dogs = [
  claim('sb', 'cargo-test', '2026-10-18T09:05:00.000Z'),
  claim('sc', 'tests-ui', '2026-10-18T09:03:00.000Z'),
  claim('sd', 'later', '2026-10-18T09:01:00.000Z', { state: 'paused' }),
  { ...claim('sx', 'other', '2026-10-18T09:00:00.000Z'), target: 'elsewhere' },
]
const leases = [lease('sa'), { ...lease('sz'), project: 'elsewhere' }]

/* ─── §1 the state ───────────────────────────────────────────────────────── */

test('§1 the slot count, holders and line come from the scope, the leases and the claims in order', () => {
  assert.equal(slotCount(project()), 0, 'no count is no slots')
  assert.equal(slotCount(project({ slots_capacity: 2 })), 2)
  const s = projectSlotState('build', 1, leases, dogs)
  assert.deepEqual(s.held.map((l) => l.agent), ['sa'], 'only this project\'s holders')
  assert.deepEqual(s.line.map((w) => [w.place, w.agent, w.name]), [[1, 'sc', 'tests-ui'], [2, 'sb', 'cargo-test']],
    'first come first: the paused claim and other projects\' claims are out')
  assert.equal(slotBadgeText(s), '1/1 held · 2 waiting')
  assert.equal(slotHeaderText(s), 'slots 1/1 · 2 waiting')
  assert.equal(slotLeadText(s), '1 of 1 concurrency slot held', 'spelled out (user 2026-10-18 12:16Z)')
  const free = projectSlotState('build', 2, [], [])
  assert.equal(slotBadgeText(free), '0/2 held', 'a free slot: no waiting count')
  assert.equal(slotHeaderText(free), 'slots 0/2')
  assert.equal(slotLeadText(free), '0 of 2 concurrency slots held')
  assert.equal(slotBadgeText(projectSlotState('build', 0, [], [])), null, 'no badge without slots')
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st'])
})

/* ─── §2 the canvas lines ────────────────────────────────────────────────── */

test('§2 a holder\'s line is solid, a waiter\'s dashed; a granted (spent) claim draws through its lease only', () => {
  const spent = claim('sa', 'alpha7-build', '2026-10-18T08:59:00.000Z', { state: 'spent', spent: true, lease: 's3f1c', slot: 1 })
  const links = slotLinks([...dogs, spent], leases, (p) => p === 'build')
  assert.deepEqual(links.map((l) => [l.owner, l.project, l.holding]),
    [['sa', 'build', true], ['sb', 'build', false], ['sc', 'build', false]],
    'holders first, then the waiting claims; paused claims, spent claims and off-canvas projects draw nothing')
  assert.equal(new Set(links.map((l) => l.key)).size, links.length, 'unique keys')
})

test('§2 an agent\'s several lines to one project lie side by side; a lone line stays centred', () => {
  const lanes = projectLineLanes([
    { key: 'a', agent: 'sa', project: 'build' },   // its audience line
    { key: 'f', agent: 'sa', project: 'build' },   // its fair-queue listener
    { key: 's', agent: 'sa', project: 'build' },   // its slot
    { key: 'o', agent: 'sb', project: 'build' },   // another agent's, alone
  ])
  assert.equal(lanes.get('o'), 0, 'a lone line has no offset')
  const offs = ['a', 'f', 's'].map((k) => lanes.get(k)!)
  assert.equal(new Set(offs).size, 3, 'three lines, three lanes')
  assert.equal(offs.reduce((x, y) => x + y, 0), 0, 'centred on where a lone line runs')
  assert.ok(Math.min(...offs.slice(1).map((o, i) => Math.abs(o - offs[i]))) >= 6, 'far enough apart to tell apart')
  const both = projectLineLanes([{ key: 'x', agent: 'build', project: 'sa' }, { key: 'y', agent: 'sa', project: 'build' }])
  assert.notEqual(both.get('x'), both.get('y'), 'a line either way between the two shares their lanes')
})

/* ─── §3 the claim card and the holder chip ──────────────────────────────── */

test('§3 a slot claim\'s card says its place in line and who holds; after the grant, its lease', () => {
  assert.equal(slotClaimText(dogs[1], dogs, leases, 1),
    'Concurrency slot claim: 1st in line for project build (behind nobody; 1 of 1 held by sa).')
  assert.equal(slotClaimText(dogs[0], dogs, leases, 1),
    'Concurrency slot claim: 2nd in line for project build (behind sc; 1 of 1 held by sa).')
  assert.equal(slotClaimText(claim('sa', 'x', '2026-10-18T08:59:00.000Z', { state: 'spent', spent: true, lease: 's7a20', slot: 1 }), dogs, leases, 1),
    'Granted a concurrency slot of build (lease s7a20).')
  assert.match(slotClaimText(dogs[2], dogs, leases, 1), /paused: out of the line; resuming rejoins at the back/)
  assert.deepEqual(slotHoldsOf('sa', leases).map((l) => [l.project, l.slot]), [['build', 1]])
  assert.deepEqual(slotHoldsOf('sb', leases), [])
})

const agentNode = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, state: 'live', tier: 'haiku', model_id: 'haiku', children: [], seat: 1, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, ...extra,
} as unknown as CanvasNode)

test("§3b the agent card wears its slot chip in the chip row, and the status row is as before slots (user 2026-10-18 10:52Z)", async (t) => {
  installFetch(new FakeServer())
  const nd = agentNode('sa')
  const view = await mountView(
    <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod="norm" focused={false}
      dragging={false} isDrop={false} seats={{ used: 1, total: 4 }}
      map={new Map([[nd.id, nd]])} op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop}
      pxc={1} zoom={1} compactAt={0.8} maxTop={0} cascadeAlloc slotHolds={slotHoldsOf('sa', leases)}
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
      onInbox={noop} onLineage={noop} onOpenDoc={noop} onRecenter={noop}
      onJump={noop} onMailLink={noop} onDragStart={noop} onDragMove={noop}
      onDragEnd={noop} onDragCancel={noop} />, (el) => el)
  t.after(() => view.unmount())
  assert.ok(!view.el.querySelector('.sq-meta .chip.slot-hold'), 'nothing slot-shaped on the status row')
  const chips = [...view.el.querySelectorAll('.sq-badges .chip.slot-hold')].map((c) => c.textContent)
  assert.deepEqual(chips, ['⬢ build'])
  assert.doesNotMatch(view.el.querySelector('.slot-hold')?.getAttribute('title') ?? '', /slot \d/)
})

async function slotDesk(t: TestContext, me: CanvasNode) {
  useFakeClock()
  installFetch(new FakeServer())
  t.after(() => { resetConvos(); realClock() })
  const view = await mountView(
    <DeskDogsProvider value={{ dogs, slotLeases: leases, open: noop }}>
      <DeskChat node={me} map={new Map([[me.id, me]])} op={() => Promise.resolve({} as OpResult)}
        slug="org" toast={noop} bare />
    </DeskDogsProvider>, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  return view.el
}

test("§3c the agent desk's header carries a holder's slot chip right after the $ chip (user 2026-10-18 10:52:50Z)", async (t) => {
  const el = await slotDesk(t, agentNode('sa', { cost_usd: 4.56 } as Partial<CanvasNode>))
  const chip = el.querySelector('.cc-head .chip.slot-hold')
  assert.ok(chip, 'the holder chip in the desk header')
  assert.equal(chip!.textContent, '⬢ build')
  assert.match(chip!.previousElementSibling?.textContent ?? '', /^\$4\.56/, 'right after the estimated-cost chip')
})

test("§3e clicking an agent's slot chip opens that project's slots surface; its tooltip is the short held-since line (user 2026-10-19 17:18Z, 17:20Z)", async (t) => {
  useFakeClock()
  installFetch(new FakeServer())
  t.after(() => { resetConvos(); realClock() })
  const opens: [string, string][] = []
  const me = agentNode('sa')
  const view = await mountView(
    <AgentSurfaceRoutesProvider value={{ open: (kind, id) => { opens.push([kind, id]) }, show: noop }}>
      <DeskDogsProvider value={{ dogs, slotLeases: leases, open: noop }}>
        <DeskChat node={me} map={new Map([[me.id, me]])} op={() => Promise.resolve({} as OpResult)}
          slug="org" toast={noop} bare />
      </DeskDogsProvider>
    </AgentSurfaceRoutesProvider>, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  const chip = view.el.querySelector<HTMLElement>('.cc-head .chip.slot-hold')!
  assert.ok(chip, 'the holder chip in the desk header')
  assert.match(chip.getAttribute('title') ?? '', /^held since \d{1,2}:\d{2} from project build$/,
    'the shortened tooltip: held since <short local time> from project <name> (user 2026-10-19 17:20Z)')
  await inAct(() => chip.click())
  assert.deepEqual(opens, [['project-slots', 'build']], 'clicking opens the project\'s slots surface')
})

test("§3d a waiting claim's chip sits in the desk header too: '⏳ build 2nd' (user 2026-10-18 10:52:50Z)", async (t) => {
  const el = await slotDesk(t, agentNode('sb'))
  const chips = [...el.querySelectorAll('.cc-head .chip.slot-wait')]
  assert.deepEqual(chips.map((c) => c.textContent), ['⏳ build 2nd'], "sb's claim, behind sc's")
  assert.match(chips[0]!.getAttribute('title') ?? '', /^waiting since \d{1,2}:\d{2} for project build$/,
    'the shortened waiting tooltip (user 2026-10-19 17:20Z)')
  assert.ok(!el.querySelector('.cc-head .chip.slot-hold'), 'sb holds nothing')
})

/* ─── §4 settings ────────────────────────────────────────────────────────── */

function serve(t: TestContext, status?: unknown) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(url), 'http://x').pathname === '/api/app-settings/runtime')
      return Promise.resolve(new Response(JSON.stringify({ working_checkups_enabled: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }))
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  return status
}
const row = (label: string) => [...document.querySelectorAll<HTMLElement>('.set-row, .set-block')]
  .find((r) => r.querySelector('.set-label, label, .field-label')?.textContent?.trim() === label
    || r.textContent?.startsWith(label))
const typeInto = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

test('§4 the Slots count: 0 (none) by default, no switch; saving sends one set_slots', async (t) => {
  serve(t)
  const ops: OpRequest[] = []
  const nd = project()
  const view = await mountView(<NodeConfig node={nd} map={new Map([[nd.id, nd]])} tree={{ slug: 'org', roots: [] } as unknown as TreePayload}
    slug="org" op={async (b) => { ops.push(b); return {} as OpResult }} toast={noop} close={noop} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(6) })
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Concurrency slots"]')
  assert.ok(input, 'a Concurrency slots count (user 12:16Z)')
  assert.equal(input!.value, '0', 'none by default')
  assert.equal(input!.type, 'number')
  assert.match(row('Concurrency slots')?.textContent ?? '', /0 = no concurrency slots/, 'the hint says 0 is none')
  await inAct(() => { typeInto(input!, '1') })
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'save')!
  await inAct(async () => { b.click(); await flush(4) })
  assert.deepEqual(ops, [{ op: 'set_slots', node: 'build', capacity: 1 }])
})

/* ─── §5 the desk's Slots tab ────────────────────────────────────────────── */

const status = {
  project: 'build', slots: 1, held: 1,
  holders: [{ lease: 's3f1c', agent: 'sa', slot: 1, reason: 'alpha7-build', queued: '2026-10-18T08:55:00.000Z', since: '2026-10-18T09:00:00.000Z', reminders: 0 }],
  line: [{ position: 1, agent: 'sc', dog: 'w1', since: '2026-10-18T09:03:00.000Z' },
    { position: 2, agent: 'sb', dog: 'w1', since: '2026-10-18T09:05:00.000Z' }],
  history: [{ lease: 's1', agent: 'sb', slot: 1, reason: 'cargo', queued: '2026-10-18T08:35:00.000Z', since: '2026-10-18T08:40:00.000Z',
    ended: '2026-10-18T08:52:00.000Z', how: 'released', by: 'sb' },
  { lease: 's2', agent: 'sc', slot: 1, reason: null, since: '2026-10-18T07:00:00.000Z',
    ended: '2026-10-18T08:04:00.000Z', how: 'idle: not released after 3 reminders', by: 'orgtree' }],
}

async function desk(t: TestContext, nd: CanvasNode, answer: unknown, empty = false) {
  serve(t)
  const ops: OpRequest[] = []
  const jumps: string[] = []
  const tree = { slug: 'org', roots: [], watchdogs: empty ? [] : dogs, slot_leases: empty ? [] : leases } as unknown as TreePayload
  const view = await mountView(<ProjectDesk node={nd} slug="org" tree={tree}
    map={new Map([[nd.id, nd], ...['sa', 'sb', 'sc'].map(id => [id, agentNode(id)] as [string, CanvasNode])])}
    onJump={id => jumps.push(id)}
    op={(b) => { ops.push(b); return Promise.resolve((b.op === 'slot_status' ? answer : { released: true }) as unknown as OpResult) }}
    toast={noop} refs={refs} />, (el) => el)
  t.after(() => view.unmount())
  await flush(2)
  return { view, ops, jumps }
}

test('visible slot views share one second clock for held, waiting and ended ages without fetching again', async t => {
  useFakeClock()
  const timer = mock.method(globalThis, 'setInterval')
  const at = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()
  const answer = { ...status, holders: [{ ...status.holders[0], since: at(32) }],
    line: [{ ...status.line[0], since: at(41) }],
    history: [{ ...status.history[0], since: at(80), ended: at(12) }] }
  const state = projectSlotState('build', 1, leases, dogs)
  const nd = project({ slots_capacity: 1 }), map = new Map([nd, ...['sa', 'sb', 'sc'].map(id => agentNode(id))].map(n => [n.id, n]))
  let reads = 0
  const op = async () => { reads++; return answer as unknown as OpResult }
  const view = await mountView(<><SlotsView node={nd} state={state} map={map} op={op} toast={noop} />
    <SlotsView node={nd} state={state} map={map} op={op} toast={noop} /></>, el => el)
  t.after(async () => { await view.unmount(); timer.mock.restore(); realClock() })
  await inAct(async () => { await flush(3) })
  const ages = (held: number, waiting: number, ended: number) => {
    for (const panel of view.el.querySelectorAll('.project-slots')) {
      assert.equal(panel.querySelector('.slots-holding .slot-held')?.textContent, `${held}s`)
      assert.equal(panel.querySelector('.slots-line .slot-wait')?.textContent?.trim(), `${waiting}s`)
      assert.equal(panel.querySelector('.slots-history .slot-ended')?.textContent, `${ended}s ago`)
    }
  }
  ages(32, 41, 12)
  await advance(1000); ages(33, 42, 13)
  await advance(1000); ages(34, 43, 14)
  assert.equal(reads, 2, 'one initial status read per mounted view, no refresh on ticks')
  assert.equal(timer.mock.calls.filter(call => call.arguments[1] === 1000).length, 1, 'one clock for both views')
})

test('slot header has one count chip and no holder links (user 2026-10-19 17:12Z); shared model-icon agent links navigate from every tab list', async t => {
  const { view, jumps } = await desk(t, project({ slots_capacity: 1 }), status)
  const header = view.el.querySelector('.cc-head-meta.project-slots-meta')
  assert.ok(header, 'the slot chip belongs in the shared second header row')
  assert.doesNotMatch(header?.textContent ?? '', /concurrency slots? held/, 'the count chip is not repeated as prose')
  assert.ok(header?.querySelector('.project-slots-card'), 'yellow count card moves to the second row too')
  assert.equal(view.el.querySelector('.cc-head-top .project-slots-card') === null, true)
  assert.equal(header!.querySelector('.ref-agent') === null, true, 'no holder agent links beside the chip (user 2026-10-19 17:12Z)')
  assert.match(header!.querySelector('.project-slots-card')?.getAttribute('title') ?? '', /sa/, 'the chip tooltip still names the holders')
  assert.deepEqual(jumps, [])
  // (the holder links that used to sit here moved to the tab lists below)
  assert.deepEqual(jumps, [], 'nothing in the header navigates')
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.project-slots-card')!.click(); await flush(3) })
  assert.equal(view.el.querySelector('.project-slots .slots-lead') === null, true, 'facts moved into header')
  for (const [section, expected] of [['holding', ['sa']], ['line', ['sc', 'sb']], ['history', ['sb', 'sc']]] as const) {
    const links = [...view.el.querySelectorAll<HTMLButtonElement>(`.slots-${section} .ref-agent`)]
    assert.deepEqual(links.map(link => link.getAttribute('data-copy-agent-name')), expected)
    assert.equal(links.every(link => !!link.querySelector('.tier')), true, `${section} model icons`)
    for (const link of links) await inAct(() => link.click())
  }
  assert.deepEqual(jumps, ['sa', 'sc', 'sb', 'sb', 'sc'])
})

test('§5 no Slots tab and no header card without a count', async (t) => {
  const { view } = await desk(t, project(), status)
  assert.ok(!view.el.querySelector('.cc-tabs button[data-tab="slots"]'), 'no Slots tab')
  assert.ok(!view.el.querySelector('.project-slots-card'), 'no header card')
})

test('§5 the Slots tab leads with the holders, then Holding, Line and Recent holds; force release asks first', async (t) => {
  const { view, ops } = await desk(t, project({ slots_capacity: 1 }), status)
  const card = view.el.querySelector<HTMLButtonElement>('.project-slots-card')
  assert.equal(card?.textContent, 'slots 1/1 · 2 waiting', 'the header card')
  assert.ok(card?.classList.contains('full'), 'filled while full')
  await inAct(async () => { card!.click(); await flush(3) })
  assert.ok(view.el.querySelector('.cc-tabs button[data-tab="slots"].on'), 'the card opens the Slots tab')
  const panel = view.el.querySelector<HTMLElement>('.project-slots')!
  assert.ok(panel, 'the slots panel')
  assert.deepEqual(ops.filter((o) => o.op === 'slot_status'), [{ op: 'slot_status', node: 'build' }])
  assert.doesNotMatch(view.el.querySelector('.project-slots-meta')?.textContent ?? '', /concurrency slots? held/)
  assert.match(view.el.querySelector('.cc-tabs button[data-tab="slots"]')?.textContent ?? '', /^slots$/, 'the tab omits redundant held/total counts')
  const sections = [...panel.querySelectorAll('h4')].map((h) => h.textContent)
  assert.deepEqual(sections, ['Holding', 'Line', 'Recent holds'])
  const holding = panel.querySelector('.slots-holding')!.textContent ?? ''
  assert.doesNotMatch(holding, /#\d/); assert.match(holding, /sa/); assert.match(holding, /alpha7-build/); assert.match(holding, /s3f1c/)
  const line = [...panel.querySelectorAll('.slots-line .slot-row')].map((r) => r.textContent ?? '')
  assert.equal(line.length, 2)
  assert.match(line[0], /1st.*sc/); assert.match(line[1], /2nd.*sb/)
  assert.equal(panel.querySelector('.slots-holding .slot-wait')?.textContent?.trim(), '5m', 'queue time before the grant')
  const histRows = [...panel.querySelectorAll('.slots-history .slot-row')].map((r) => r.textContent ?? '')
  assert.equal(histRows.length, 2)
  assert.equal(panel.querySelector('.slots-history .slot-wait')?.textContent?.trim(), '5m')
  assert.equal(panel.querySelector('.slots-history .slot-held')?.textContent, '12m')
  assert.doesNotMatch(histRows[0], /released/, 'a normal release carries no label (user 2026-10-19 17:23Z)')
  assert.doesNotMatch(histRows[1], /waited/, 'an old row without a recorded queue time shows none')
  assert.match(histRows[1], /timed out/, 'unusual endings keep a short label')
  const hist = panel.querySelector('.slots-history')!.textContent ?? ''
  assert.doesNotMatch(hist, /#\d/)
  assert.doesNotMatch(hist, /idle: not released after 3 reminders/, 'the raw end reason stays in the tool, not the row')
  // force release: nothing before the confirmation
  await inAct(() => { panel.querySelector<HTMLButtonElement>('button[data-action="force-release"]')!.click() })
  assert.equal(ops.some((o) => o.op === 'slot_release'), false, 'nothing before the confirmation')
  assert.match(document.body.textContent ?? '', /take the concurrency slot of build back from sa\?/)
  assert.match(document.body.textContent ?? '', /the next in line, sc, gets it at once/)
  const go = [...document.querySelectorAll('button')].find((b) => b.textContent === 'force release' && !b.closest('.project-slots'))!
  await inAct(async () => { go.click(); await flush(3) })
  assert.deepEqual(ops.filter((o) => o.op === 'slot_release'), [{ op: 'slot_release', lease: 's3f1c', force: true }])
  // remove from line
  const remove = view.el.querySelectorAll<HTMLButtonElement>('.slots-line button[data-action="unqueue"]')
  assert.equal(remove.length, 2)
  await inAct(async () => { remove[1].click(); await flush(3) })
  assert.deepEqual(ops.filter((o) => o.op === 'slot_unqueue'), [{ op: 'slot_unqueue', node: 'build', agent: 'sb' }])
})

test('§5 the empty state says how to claim and that nobody waits', async (t) => {
  const empty = { project: 'build', slots: 2, held: 0, holders: [], line: [], history: [] }
  const { view } = await desk(t, project({ slots_capacity: 2 }), empty, true)
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.cc-tabs button[data-tab="slots"]')!.click(); await flush(3) })
  const card = view.el.querySelector('.project-slots-card')
  assert.equal(card?.textContent, 'slots 0/2')
  assert.equal(card?.classList.contains('full'), false, 'an outline while a slot is free')
  const panel = view.el.querySelector<HTMLElement>('.project-slots')!
  assert.doesNotMatch(view.el.querySelector('.project-slots-meta')?.textContent ?? '', /concurrency slots? held/)
  assert.match(panel.textContent ?? '', /Nobody holds a concurrency slot\./)
  assert.match(panel.textContent ?? '', /orgtree_watchdog action=create kind=slot target=build/)
  assert.match(panel.textContent ?? '', /Nobody is waiting\./)
  assert.match(panel.textContent ?? '', /No concurrency slot has been held yet\./)
})

test('slot sections share column headers and the same six-cell row structure', async t => {
  const nd = project({ slots_capacity: 1 })
  const state = projectSlotState('build', 1, leases, dogs)
  const v = await mountView(<SlotsView node={nd} state={state} map={new Map([[nd.id, nd]])}
    op={async () => status as unknown as OpResult} toast={noop}/>, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(3) })
  const table = v.el.querySelector('table')
  assert.ok(table, 'one shared table determines widths for every section')
  assert.deepEqual([...table.querySelectorAll('thead th')].map(el => el.textContent),
    ['Agent', 'Waited', 'Held', 'Ended', 'Claim / lease', 'Action'])
  assert.equal(table.querySelectorAll('tbody').length, 3)
  assert.equal([...table.querySelectorAll('.slot-row')].every(row => row.children.length === 6), true)
  assert.equal(table.querySelector('.slots-holding .slot-ended')?.textContent, '')
  assert.equal(table.querySelector('.slots-line .slot-held')?.textContent, '')
  assert.equal(table.querySelector('.slots-line .slot-ended')?.textContent, '')
  assert.match(table.querySelector('.slots-history .slot-rest')?.textContent ?? '', /s1/)
})
