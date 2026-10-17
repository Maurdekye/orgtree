// projectnode.test.tsx — PROJECT NODES on the canvas (Orgtree 4.4.0; docket
// `project-nodes-in-the-org-hierarchy-with-a-fair-p`,
// docs/rust-engine/PROJECT-NODES.md): a node that stands for one project and
// is not an agent. It runs no turns and holds no credits (user 2026-10-16
// 20:40Z: credits pass through it to the agent above, as though it were not
// there).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the "New project" form sends create_project for its place: under a
//      node, at the top level, above a node holding it, or beside a node,
//      where a side token's project then takes its side with the same
//      follow-up reorder a side hire uses; a refusal keeps the form open;
//   §2 a project node draws as a project card: a folder mark, its name and
//      description, no model, credit bar or desk, its waiting mail on the
//      mailbox button (which opens the mailbox), and its own project token;
//   §3 its menu, on the card and wherever agentMenuEntries is used for it
//      (the Agents List), offers the project's own actions only.
// The hire token itself is tests/projecttoken.test.tsx; the engine half is
// tools/rig/proofs/project-nodes.mjs.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectnode

import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { NewProjectModal } from '../src/canvas/newproject'
import { ProjectSquare } from '../src/canvas/projectcard'
import { NodeSquare } from '../src/canvas/cards'
import { agentMenuEntries, projectMenuEntries } from '../src/canvas/agentmenu'
import type { AgentMenuHandlers } from '../src/canvas/agentmenu'
import { agentItems } from '../src/canvas/docket'
import type { WorkItem } from '../src/types'
import { USER } from '../src/canvas/shared'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'

const noop = () => {}
const offer = { enabled: true, installed: true, reason: null }
const seats = { haiku: 1, sonnet: 2, opus: 5 }

/* ─── §1 the form ───────────────────────────────────────────────────────── */

interface Place { parent: string; above?: string; beside?: { anchor: string; side: 'left' | 'right' } }

async function submit(place: Place, refuse?: string) {
  const sent: OpRequest[] = []
  const toasts: string[] = []
  let closed = 0
  const op = (body: OpRequest) => {
    sent.push(body)
    return body.op === refuse ? Promise.reject(new Error('refused')) : Promise.resolve({} as OpResult)
  }
  const view = await mountView(<NewProjectModal {...place} op={op}
    toast={(lines) => toasts.push(...(lines ?? []))} close={() => { closed++ }} />, () => null)
  const dialog = document.querySelector<HTMLElement>('.new-project')
  assert.ok(dialog, 'the form opens')
  const heading = dialog.querySelector('h3')?.textContent ?? ''
  const name = dialog.querySelector<HTMLInputElement>('input')!
  const description = dialog.querySelector<HTMLTextAreaElement>('textarea')!
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(name, ' website ')
    name.dispatchEvent(new Event('input', { bubbles: true }))
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      .call(description, 'The company website.')
    description.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const create = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'create')!
  await inAct(async () => { create.click(); await flush() })
  const open = document.querySelector('.new-project') !== null
  await view.unmount()
  return { sent, toasts, closed, heading, open }
}

test('§1a under a node: one create_project with the trimmed name and the description', async () => {
  const r = await submit({ parent: 'boss' })
  assert.equal(r.heading, 'New project under boss')
  assert.deepEqual(r.sent, [{ op: 'create_project', name: 'website', description: 'The company website.',
    parent: 'boss' }])
  assert.equal(r.closed, 1, 'the form closes once the project exists')
  assert.deepEqual(r.toasts, ['project website created under boss'])
})

test('§1b at the top level the parent is the user', async () => {
  const r = await submit({ parent: USER })
  assert.equal(r.heading, 'New project at the top level')
  assert.equal(r.sent[0]!.parent, 'user')
})

test('§1c above a node: the project takes its place and holds it (the anchor rides the op)', async () => {
  const r = await submit({ parent: 'boss', above: 'dev1' })
  assert.equal(r.heading, 'New project above dev1, holding it')
  assert.deepEqual(r.sent, [{ op: 'create_project', name: 'website', description: 'The company website.',
    above: 'dev1' }], 'the engine places it from the anchor: no parent is sent')
})

test('§1d beside a node: created among its siblings, then moved to that side by the side hire\'s reorder', async () => {
  const left = await submit({ parent: 'boss', beside: { anchor: 'dev1', side: 'left' } })
  assert.equal(left.heading, 'New project beside dev1')
  assert.deepEqual(left.sent, [
    { op: 'create_project', name: 'website', description: 'The company website.', parent: 'boss' },
    { op: 'reorder', node: 'website', before: 'dev1' },
  ])
  const right = await submit({ parent: 'boss', beside: { anchor: 'dev1', side: 'right' } })
  assert.deepEqual(right.sent[1], { op: 'reorder', node: 'website', after: 'dev1' })
  assert.equal(right.closed, 1)
})

test('§1e a refused create keeps the form open and sends nothing more', async () => {
  const r = await submit({ parent: 'boss', beside: { anchor: 'dev1', side: 'left' } }, 'create_project')
  assert.equal(r.sent.length, 1, 'no reorder after a refused create')
  assert.equal(r.closed, 0)
  assert.equal(r.open, true, 'the form stays for a corrected name (op itself toasts the refusal)')
  assert.deepEqual(r.toasts, [])
})

/* ─── §2 the project card ───────────────────────────────────────────────── */

function project(extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'website', title: 'website', kind: 'project', state: 'live', tier: 'project', model_id: '',
    seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, charter: 'The company website.\nDeploy from main.',
    children: [], lineage: [], turns: [], audiences_held: [], mail_pending: 3,
    last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
    ...extra,
  } as unknown as CanvasNode
}

const agentNode = {
  id: 'dev1', title: 'dev1', state: 'live', tier: 'haiku', model_id: 'haiku',
  seat: 1, grant: 4, free: 0, scope: { tools: {}, add_dirs: [] },
  children: [], lineage: [], turns: [], audiences_held: [],
  bearer_state: null, frozen: null, limit_locked: false, mail_pending: 0,
  last_status: { status: 'working', summary: 'fixture', at: '' },
  prev_status: null, inflight_at: null, last_denials: [],
  occupancy: 100, occupancy_est: false, context_window: 1000,
  busy: false, activity: null, proc_warm: true, proc_live: true,
  proc_relaunch: false, proc_relaunch_reason: null, isBearerOf: undefined,
} as unknown as CanvasNode

const square = (nd: CanvasNode, h: { inbox?: () => void; hire?: (t: string) => void } = {}) =>
  mountView(<ProjectSquare node={nd} pos={{ x: 0, y: 0 }} lod="norm" dragging={false} isDrop={false}
    op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop} zoom={2}
    hire={{ claudeHire: offer }} seats={seats} onHire={h.hire ?? noop} onInbox={h.inbox ?? noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)

test('§2a a project draws as a project card: no model, credit bar, desk or turn state', async (t) => {
  const view = await square(project())
  t.after(() => view.unmount())
  const sq = view.el.querySelector<HTMLElement>('.sq.project')
  assert.ok(sq, 'the project card')
  assert.equal(sq.getAttribute('aria-label'), 'project website')
  assert.ok(sq.querySelector('.project-mark svg'), 'the folder mark')
  assert.equal(sq.querySelector('.name')?.textContent, 'website')
  assert.equal(sq.querySelector('.project-kind')?.textContent, 'project')
  assert.equal(sq.querySelector('.project-desc')?.textContent, 'The company website.',
    'the first line of its description')
  // the control: an agent card from the same fixture style does draw them
  const agent = await mountView(<NodeSquare node={agentNode} pos={{ x: 0, y: 0 }} lod="norm" focused={false}
    dragging={false} isDrop={false} seats={seats} claudeHire={offer}
    map={new Map([[agentNode.id, agentNode]])} op={() => Promise.resolve({} as OpResult)} slug="org"
    toast={noop} pxc={1} zoom={2} compactAt={0.8} maxTop={0} cascadeAlloc
    onSpawn={noop} onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop}
    onRecenter={noop} onJump={noop} onMailLink={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)
  t.after(() => agent.unmount())
  for (const sel of ['.cbar', '.tier']) {
    assert.ok(agent.el.querySelector(sel), `control: an agent card draws ${sel}`)
    assert.equal(sq.querySelector(sel) === null, true, `no ${sel} on a project`)
  }
})

test('§2b its waiting mail shows on the mailbox button, which opens the mailbox', async (t) => {
  let opened = 0
  const view = await square(project(), { inbox: () => { opened++ } })
  t.after(() => view.unmount())
  const btn = view.el.querySelector<HTMLButtonElement>('button.mailbtn')!
  assert.ok(btn.classList.contains('has'))
  assert.equal(btn.querySelector('.count')?.textContent, '3')
  assert.match(btn.getAttribute('title') ?? '', /^3 mail waiting for a fair_queue watcher/)
  await inAct(() => { btn.click() })
  assert.equal(opened, 1)
})

test('§2c a live project has its hire strip with its own project token (a nested project); '
  + 'a retired one has neither', async (t) => {
  const hired: string[] = []
  const live = await square(project(), { hire: (tier) => hired.push(tier) })
  t.after(() => live.unmount())
  assert.ok(live.el.querySelector('.hsof'), 'the hire strip under the project')
  const opus = live.el.querySelector<HTMLButtonElement>('.hsof button.t-opus')!
  await inAct(() => { opus.click() })
  assert.deepEqual(hired, ['opus'], 'a tier token hires under the project')
  const tok = live.el.querySelector<HTMLButtonElement>('.hsof button.project-token')!
  await inAct(() => { tok.click() })
  const dialog = document.querySelector('.new-project')
  assert.ok(dialog, 'the project token opens the form')
  assert.equal(dialog.querySelector('h3')?.textContent, 'New project under website')
  await inAct(() => { [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'cancel')!.click() })
  const retired = await square(project({ state: 'archived', mail_pending: 0 }))
  t.after(() => retired.unmount())
  assert.equal(retired.el.querySelector('.hsof') === null, true, 'no hires under a retired project')
})

/* ─── §3 its menu ───────────────────────────────────────────────────────── */

const labels = (entries: ReturnType<typeof projectMenuEntries>) =>
  entries.map((e) => (e === 'sep' ? 'sep' : e.label))

const handlers = (extra: Partial<AgentMenuHandlers> = {}): AgentMenuHandlers => ({
  onInbox: noop, onSettings: noop, onRetireAsk: noop, onHire: noop, onNewProject: noop,
  onScratchFolder: noop, ...extra,
})

test('§3a a live project\'s menu: open its mailbox or folder, hire or nest a project under it, retire it', () => {
  const nd = project()
  assert.deepEqual(labels(projectMenuEntries(nd, handlers(), { claudeHire: offer })),
    ['Open', 'Settings', 'Hire under this project', 'New project here…', 'sep', 'Retire project…'])
  const open = projectMenuEntries(nd, handlers(), { claudeHire: offer })[0]
  assert.ok(open !== 'sep')
  assert.deepEqual(open.children?.map((c) => c === 'sep' ? 'sep' : c.label),
    ['Open project mailbox', 'Open project folder'])
})

test('§3b agentMenuEntries gives a project the project menu, never an agent\'s', () => {
  const nd = project()
  const got = labels(agentMenuEntries(nd, handlers(), { claudeHire: offer }))
  assert.deepEqual(got, labels(projectMenuEntries(nd, handlers(), { claudeHire: offer })))
  assert.ok(got.includes('Settings'), 'project settings expose peer-mail policy')
  for (const agentOnly of ['Halt', 'Cheap compact…', 'Change model', 'Desk']) {
    assert.equal(got.includes(agentOnly), false, `no "${agentOnly}" on a project`)
  }
})

test('§3c retiring a project with live agents under it asks for the team retirement', () => {
  let asked = ''
  const nd = project({ children: [{ id: 'dev1', state: 'live' } as unknown as CanvasNode] })
  const entries = projectMenuEntries(nd, handlers({ onRetireAsk: (k) => { asked = k } }), {})
  const retire = entries.find((e) => e !== 'sep' && e.label === 'Retire project…')
  assert.ok(retire && retire !== 'sep')
  retire.onSelect()
  assert.equal(asked, 'dissolve')
})

/* ─── §4 the project's docket (slice 2) ─────────────────────────────────── */
// USER 2026-10-16 20:23Z: docket items may attach to a project; every agent
// under it co-owns them, and the project's desk lists its attached items.

test("§4a a project's menu opens its docket when the surface offers one", () => {
  let opened = 0
  const open = projectMenuEntries(project(), handlers({ onDocket: () => { opened++ } }), {})[0]
  assert.ok(open !== 'sep')
  const entry = open.children?.find((c) => c !== 'sep' && c.label === 'Open project docket')
  assert.ok(entry && entry !== 'sep', 'the Open branch carries the project docket')
  entry.onSelect()
  assert.equal(opened, 1)
})

test('§4b the project docket lists the items attached to it, and only those', () => {
  const item = (slug: string, extra: Partial<WorkItem>) =>
    ({ slug, owner: { node: 'dev1', generation: 1 }, reviewer: null, participants: [], ...extra }) as unknown as WorkItem
  const data = { items: [
    item('attached', { project: { node: 'website' } }),
    item('elsewhere', { project: { node: 'blog' } }),
    item('plain', {}),
  ] }
  assert.deepEqual(agentItems(data, 'website')!.map((i) => i.slug), ['attached'])
  assert.deepEqual(agentItems(data, 'dev1')!.map((i) => i.slug), ['attached', 'elsewhere', 'plain'],
    'the owner still sees every item it owns')
})
