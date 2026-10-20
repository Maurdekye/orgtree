// cardshortcuts.test.tsx — CARD SHORTCUTS AND OPEN DESKS (Orgtree 4.4.0;
// docket `agent-shortcut-badges-stay-rendered-beside-an-op`, user 2026-10-20
// 09:23Z–09:25Z on alpha.16).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 "agent card shortcuts dont derender on project nodes when viewing the
//      desk" (09:23Z): with Show agent card shortcuts on, a project card's
//      shortcut row gives way to its open desk, and to its pinned desk's
//      placeholder, as an agent card's does, and comes back when the desk
//      closes. The hire strips stay on both desks: "the desk KEEPS its hire
//      chips" is a user spec (styles.css, desk fill);
//   §2 the project card's shortcuts gain Presented, Team, Slots and Listeners
//      (09:24Z; "actually no summary button", 09:24:35Z) after Docket and
//      Mail, each opening that view. Team, Slots and Listeners show exactly
//      while the project desk offers those tabs; Presented always, as its tab;
//   §3 an agent card gains a Team shortcut while it has a live subordinate
//      (09:25Z), last in its row, opening its team.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs cardshortcuts

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { ProjectSquare } from '../src/canvas/projectcard'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { NodeSquare } from '../src/canvas/cards'
import { AgentSurfaceRoutesProvider } from '../src/canvas/panelcorner'
import { deskMemory, forgetDeskMemory } from '../src/canvas/desktabs'
import { setAgentShortcutsOn } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, TreePayload } from '../src/types'

const noop = () => {}
const refs = { world: { org: 'org' }, onOpen: noop } as never
const offer = { enabled: true, installed: true, reason: null }
const seats = { haiku: 1, sonnet: 2, opus: 5 }
const op = () => Promise.resolve({} as OpResult)

const dev1 = { id: 'dev1', title: 'dev1', tier: 'haiku', state: 'live', children: [] }
function project(extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'website', title: 'website', kind: 'project', state: 'live', tier: 'project', model_id: '',
    seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, parent: 'boss',
    charter: 'The company website.', children: [dev1],
    lineage: [], turns: [], audiences_held: [], mail_pending: 0, documents_count: 0,
    last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
    ...extra,
  } as unknown as CanvasNode
}
const boss = { id: 'boss', title: 'boss', tier: 'opus', state: 'live', children: [] } as unknown as CanvasNode

function projectMap(node: CanvasNode): Map<string, CanvasNode> {
  const entries: [string, CanvasNode][] = [[node.id, node], [boss.id, boss]]
  const add = (child: CanvasNode, parent: string) => {
    const current = { ...child, parent } as CanvasNode
    entries.push([current.id, current])
    for (const nested of current.children ?? []) add(nested, current.id)
  }
  for (const child of node.children ?? []) add(child, node.id)
  return new Map(entries)
}

const treeWith = (watchdogs: unknown[] = []) =>
  ({ slug: 'org', roots: [], watchdogs, slot_leases: [] }) as unknown as TreePayload

/** an event listener registered on the project, as the engine reports it */
const listener = { id: 'dev1/ready', owner: 'dev1', name: 'ready', kind: 'project_listener', target: 'website',
  interval_s: 5, state: 'armed', at: '2026-10-20T09:00:00.000Z', fired: 0, once: false, spent: false }

function serve(t: TestContext) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://fixture.invalid').pathname
    if ((init?.method ?? 'GET') === 'GET' && /\/nodes\/[^/]+\/inbox$/.test(path)) {
      return Promise.resolve(new Response(JSON.stringify({ pending: [], delivered: [], sent: [], next_cursor: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
}

function shortcutsOn(t: TestContext, on = true) {
  setAgentShortcutsOn(on)
  // inside act: the cards still mounted re-render as the setting flips
  t.after(() => inAct(() => { setAgentShortcutsOn(false) }))
  forgetDeskMemory()
}

/** A project card the canvas would draw, every route recorded in `log`. */
function projectCard(nd: CanvasNode, o: { focused?: boolean; pinnedFocus?: boolean; tree?: TreePayload;
  log?: string[]; temporary?: boolean } = {}) {
  const log = o.log ?? []
  return <AgentSurfaceRoutesProvider value={{ open: (kind, id) => { log.push(`open:${kind}:${id}`) }, show: noop }}>
    <ProjectSquare node={nd} pos={{ x: 0, y: 0 }} lod="norm" focused={o.focused} pinnedFocus={o.pinnedFocus}
      dragging={false} isDrop={false} op={op} slug="org" toast={noop} zoom={o.focused ? 8 : 2}
      tree={o.tree ?? treeWith()} map={projectMap(nd)} refs={refs}
      hire={{ claudeHire: offer }} seats={seats} onHire={noop} onNewProject={noop}
      onSpawnSide={noop} onSpawnTop={noop}
      onInbox={() => { log.push('mail') }} onDocket={() => { log.push('docket') }} onTeam={() => { log.push('team') }}
      onOpenGallery={(id, opts) => { log.push(`presented:${id}${opts?.team ? ':team' : ''}`) }}
      onOpenTemporary={o.temporary === false ? undefined : () => { log.push('temporary') }}
      onFocus={() => { log.push('focus') }} onShowPin={() => { log.push('show-pin') }}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  </AgentSurfaceRoutesProvider>
}

const card = (el: HTMLElement) => el.querySelector<HTMLElement>('.sq')!
/** the card's own shortcut row (its direct child), not anything its desk draws */
const row = (el: HTMLElement) => card(el).querySelector<HTMLElement>(':scope > .sq-actions')
/** each shortcut by what it opens, in row order, read from its accessible name */
const KINDS: [RegExp, string][] = [[/^Docket for /, 'docket'], [/^mailbox of /, 'mail'],
  [/^presented documents for /, 'presented'], [/^team of /, 'team'], [/^slots of /, 'slots'],
  [/^listeners of /, 'listeners']]
const shortcuts = (el: HTMLElement): string[] => [...(row(el)?.querySelectorAll('button') ?? [])]
  .map((b) => KINDS.find(([re]) => re.test(b.getAttribute('aria-label') ?? ''))?.[1]
    ?? `unnamed:${b.className}`)
const button = (el: HTMLElement, kind: string) => [...(row(el)?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  .find((b) => KINDS.find(([re]) => re.test(b.getAttribute('aria-label') ?? ''))?.[1] === kind)

/* ─── §1 the shortcuts give way to the open desk ───────────────────────── */

test('§1a with shortcuts on, an open project desk draws no shortcut row; closing it brings the row back', async (t) => {
  serve(t)
  shortcutsOn(t)
  const nd = project()
  const view = await mountView(projectCard(nd, { focused: true }), (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  assert.ok(card(view.el).classList.contains('desk'), 'the focused card is its desk')
  assert.ok(card(view.el).querySelector('.desk-over'), 'the desk is open')
  assert.equal(row(view.el) === null, true, 'no shortcut row on the open desk (user 09:23Z)')
  assert.equal(card(view.el).querySelectorAll('button.mailbtn, button.presentedbtn').length, 0,
    'no shortcut button anywhere on the open desk')
  // the desk closes: the camera left it
  await view.render(projectCard(nd))
  assert.equal(card(view.el).classList.contains('desk'), false, 'a card again')
  assert.ok(row(view.el), 'the shortcut row is back')
  assert.deepEqual(shortcuts(view.el).slice(0, 2), ['docket', 'mail'], 'with its docket and mailbox first')
})

test('§1b the pinned desk\'s placeholder hides a project card\'s shortcuts, as an agent card\'s', async (t) => {
  serve(t)
  shortcutsOn(t)
  const log: string[] = []
  const view = await mountView(projectCard(project(), { pinnedFocus: true, log }), (el) => el)
  t.after(() => view.unmount())
  assert.ok(card(view.el).querySelector('.pin-holder'), 'the placeholder holds the pinned desk\'s place')
  assert.equal(row(view.el) === null, true, 'no shortcut row over the placeholder')
  // the control: an agent card in the same state
  const agent = await mountView(agentCard(agentNode(), { pinnedFocus: true }), (el) => el)
  t.after(() => agent.unmount())
  assert.ok(card(agent.el).querySelector('.pin-holder'), 'control: the agent card holds its placeholder')
  assert.equal(row(agent.el) === null, true, 'control: and draws no shortcut row')
})

test('§1c the rule it follows: an agent desk draws no shortcut row; both desks keep their hire strips', async (t) => {
  serve(t)
  shortcutsOn(t)
  const nd = agentNode()
  const open = await mountView(agentCard(nd, { focused: true }), (el) => el)
  t.after(() => open.unmount())
  await inAct(async () => { await flush(2) })
  assert.ok(card(open.el).classList.contains('desk'), 'the focused agent card is its desk')
  assert.equal(row(open.el) === null, true, 'an agent desk draws no shortcut row')
  const closed = await mountView(agentCard(nd), (el) => el)
  t.after(() => closed.unmount())
  assert.ok(row(closed.el), 'its card does')
  // the round letter tokens beside an open desk are its hire strips, which a
  // desk keeps by user spec, on both kinds of card
  const projectDesk = await mountView(projectCard(project(), { focused: true }), (el) => el)
  t.after(() => projectDesk.unmount())
  await inAct(async () => { await flush(2) })
  for (const [name, el] of [['agent', open.el], ['project', projectDesk.el]] as const) {
    for (const side of ['side-l', 'side-r', 'side-t']) {
      assert.ok(card(el).querySelector(`:scope > .hsof.${side}`), `the ${name} desk keeps its ${side} hire strip`)
    }
  }
})

/* ─── §2 the project card's shortcuts ──────────────────────────────────── */

test('§2a the project row is Docket, Mail, Presented, Team, Slots, Listeners, each opening its view (user 09:24Z)', async (t) => {
  serve(t)
  shortcutsOn(t)
  const log: string[] = []
  const nd = project({ configured_scope: { slots_capacity: 2, event_listeners: true } } as never)
  const view = await mountView(projectCard(nd, { log }), (el) => el)
  t.after(() => view.unmount())
  assert.deepEqual(shortcuts(view.el), ['docket', 'mail', 'presented', 'team', 'slots', 'listeners'],
    'in the desk\'s tab order after the two it had, and no Summary (09:24:35Z)')
  for (const kind of ['docket', 'mail', 'presented', 'team', 'slots', 'listeners']) {
    await inAct(() => { button(view.el, kind)!.click() })
  }
  // Listeners has a window of its own now, like Slots (docket
  // slots-tab-header-hold-n-slots-button-with-number; coordinator 2026-10-20 17:03Z)
  assert.deepEqual(log, ['docket', 'mail', 'presented:website', 'team', 'open:project-slots:website', 'open:project-listeners:website'],
    'each opens the window its desk tab and menu entry open')
  assert.equal(deskMemory('org', 'website', 'tab'), null, 'the desk is not moved to a tab')
  for (const b of row(view.el)!.querySelectorAll('button')) {
    assert.ok((b.getAttribute('title') ?? '').length > 0, `${b.getAttribute('aria-label')} says what it opens`)
  }
})

test('§2b Listeners opens its window where no temporary desk is offered too: the camera stays', async (t) => {
  serve(t)
  shortcutsOn(t)
  const log: string[] = []
  const view = await mountView(projectCard(project({ configured_scope: { event_listeners: true } } as never), { log, temporary: false }), (el) => el)
  t.after(() => view.unmount())
  await inAct(() => { button(view.el, 'listeners')!.click() })
  assert.deepEqual(log, ['open:project-listeners:website'], 'its own window, as Slots')
})

test('§2c Presented shows with no documents of its own, as its tab always does; with some it keeps their count', async (t) => {
  serve(t)
  shortcutsOn(t)
  const none = await mountView(projectCard(project({ children: [] })), (el) => el)
  t.after(() => none.unmount())
  assert.deepEqual(shortcuts(none.el), ['docket', 'mail', 'presented'], 'no team, slots or listeners; Presented stays')
  assert.match(button(none.el, 'presented')!.getAttribute('title') ?? '', /presented documents of project website/)
  const some = await mountView(projectCard(project({ documents_count: 2 } as never)), (el) => el)
  t.after(() => some.unmount())
  assert.match(button(some.el, 'presented')!.getAttribute('title') ?? '', /the 2 presented documents of project website$/,
    'annotated with the project\'s own document count, as before')
})

/** what the desk offers and what the card shows, for one project state */
async function tabsAndShortcuts(t: TestContext, nd: CanvasNode, tree: TreePayload) {
  const desk = await mountView(<ProjectDesk node={nd} slug="org" tree={tree} map={projectMap(nd)} op={op}
    toast={noop} refs={refs} onJump={noop} />, (el) => el)
  t.after(() => desk.unmount())
  await inAct(async () => { await flush(2) })
  const tabs = [...desk.el.querySelectorAll('.cc-tabs button[data-tab]')].map((b) => b.getAttribute('data-tab')!)
  const view = await mountView(projectCard(nd, { tree }), (el) => el)
  t.after(() => view.unmount())
  const gated = ['team', 'slots', 'listeners']
  return { tabs: tabs.filter((v) => gated.includes(v)), shortcuts: shortcuts(view.el).filter((v) => gated.includes(v)) }
}

test('§2d Team, Slots and Listeners show exactly while the project desk offers those tabs', async (t) => {
  serve(t)
  shortcutsOn(t)
  const retired = { ...dev1, id: 'old', state: 'archived' }
  const cases: [string, CanvasNode, TreePayload, string[]][] = [
    ['nobody under it, no slots, no listener', project({ children: [] }), treeWith(), []],
    ['only a retired agent under it', project({ children: [retired] } as never), treeWith(), []],
    ['a live agent under it', project(), treeWith(), ['team']],
    ['slots configured', project({ children: [], configured_scope: { slots_capacity: 1 } } as never), treeWith(), ['slots']],
    ['event listeners on, one listening', project({ children: [], configured_scope: { event_listeners: true } } as never), treeWith([listener]), ['listeners']],
    ['event listeners on, nobody listening', project({ children: [], configured_scope: { event_listeners: true } } as never), treeWith(), ['listeners']],
    ['a listener dog, the event listeners off', project({ children: [] }), treeWith([listener]), []],
    ['all three', project({ configured_scope: { slots_capacity: 3, event_listeners: true } } as never), treeWith([listener]), ['team', 'slots', 'listeners']],
  ]
  for (const [name, nd, tree, want] of cases) {
    const got = await tabsAndShortcuts(t, nd, tree)
    assert.deepEqual(got.tabs, want, `${name}: the desk's tabs`)
    assert.deepEqual(got.shortcuts, want, `${name}: the card's shortcuts follow them`)
  }
})

test('§2e with the setting off, none of the project shortcuts', async (t) => {
  serve(t)
  shortcutsOn(t, false)
  const view = await mountView(projectCard(project({ configured_scope: { slots_capacity: 2, event_listeners: true } } as never)),
    (el) => el)
  t.after(() => view.unmount())
  assert.equal(row(view.el) === null, true, 'no shortcut row at all')
})

/* ─── §3 the agent card's Team shortcut ────────────────────────────────── */

function agentNode(extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'lead', title: 'lead', state: 'live', tier: 'haiku', model_id: 'haiku', parent: null,
    seat: 1, grant: 4, free: 0, scope: { tools: {}, add_dirs: [] },
    children: [], lineage: [], turns: [], audiences_held: [],
    bearer_state: null, frozen: null, limit_locked: false, mail_pending: 0,
    last_status: { status: 'working', summary: 'fixture', at: '' },
    prev_status: null, inflight_at: null, last_denials: [],
    occupancy: 100, occupancy_est: false, context_window: 1000,
    busy: false, activity: null, proc_warm: true, proc_live: true,
    proc_relaunch: false, proc_relaunch_reason: null, isBearerOf: undefined,
    ...extra,
  } as unknown as CanvasNode
}
const report = (state: string) => agentNode({ id: 'helper', title: 'helper', parent: 'lead', state } as never)

function agentCard(nd: CanvasNode, o: { reports?: CanvasNode[]; focused?: boolean; pinnedFocus?: boolean;
  log?: string[] } = {}) {
  const log = o.log ?? []
  const map = new Map<string, CanvasNode>([[nd.id, nd], ...(o.reports ?? []).map((r) => [r.id, r] as [string, CanvasNode])])
  return <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod="norm" focused={!!o.focused} pinnedFocus={o.pinnedFocus}
    dragging={false} isDrop={false} seats={seats} claudeHire={offer} map={map} op={op} slug="org" toast={noop}
    pxc={1} zoom={o.focused ? 8 : 2} compactAt={0.8} maxTop={100} cascadeAlloc
    onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
    onInbox={() => { log.push('mail') }} onTeam={() => { log.push('team') }} onDocket={() => { log.push('docket') }}
    onLineage={noop} onOpenDoc={noop} onRecenter={noop} onJump={noop} onMailLink={noop} onWorkLink={noop}
    onShowPin={() => { log.push('show-pin') }}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
}

const agentButtons = (el: HTMLElement) => [...(row(el)?.querySelectorAll<HTMLButtonElement>('button') ?? [])]

test('§3a an agent card with a live report has a Team shortcut, last in its row, that opens its team (user 09:25Z)', async (t) => {
  serve(t)
  shortcutsOn(t)
  const log: string[] = []
  const view = await mountView(agentCard(agentNode(), { reports: [report('live')], log }), (el) => el)
  t.after(() => view.unmount())
  const last = agentButtons(view.el).at(-1)
  assert.equal(last?.getAttribute('aria-label'), 'team of lead', 'Team is the last shortcut')
  assert.ok((last?.getAttribute('title') ?? '').length > 0, 'and says what it opens')
  await inAct(() => { last!.click() })
  assert.deepEqual(log, ['team'], 'it opens the agent\'s team')
})

test('§3b no Team shortcut without a live report, with the setting off, or on the open desk', async (t) => {
  serve(t)
  shortcutsOn(t)
  const team = (el: HTMLElement) => agentButtons(el).filter((b) => /^team of /.test(b.getAttribute('aria-label') ?? '')).length
  const alone = await mountView(agentCard(agentNode()), (el) => el)
  t.after(() => alone.unmount())
  assert.ok(row(alone.el), 'control: the row is drawn')
  assert.equal(team(alone.el), 0, 'no reports: no Team')
  const retired = await mountView(agentCard(agentNode(), { reports: [report('archived')] }), (el) => el)
  t.after(() => retired.unmount())
  assert.equal(team(retired.el), 0, 'a retired report only: no Team, as the desk has no Team tab')
  const open = await mountView(agentCard(agentNode(), { reports: [report('live')], focused: true }), (el) => el)
  t.after(() => open.unmount())
  await inAct(async () => { await flush(2) })
  assert.equal(row(open.el) === null, true, 'the open desk draws no row at all')
  await inAct(() => { setAgentShortcutsOn(false) })
  const off = await mountView(agentCard(agentNode(), { reports: [report('live')] }), (el) => el)
  t.after(() => off.unmount())
  assert.equal(row(off.el) === null, true, 'setting off: no row at all')
})
