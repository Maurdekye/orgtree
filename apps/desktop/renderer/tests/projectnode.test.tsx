// projectnode.test.tsx — PROJECT NODES on the canvas (Orgtree 4.4.0; docket
// `project-nodes-in-the-org-hierarchy-with-a-fair-p`,
// docs/rust-engine/PROJECT-NODES.md): a node that stands for one project and
// is not an agent. It runs no turns and holds no credits (user 2026-10-16
// 20:40Z: credits pass through it to the agent above, as though it were not
// there).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 making a project by hand opens a DRAFT project card, like a manual
//      hire (user 2026-10-17 19:14Z): a name and a description, then one
//      create_project for its place (under a node, at the top level, above a
//      node holding it, or beside a node with the side hire's reorder); the
//      preview tree holds it where it will go; the old form is gone;
//   §2 a project node draws as a project card: a folder mark, its name and
//      description, no model, credit bar or desk, its waiting mail on the
//      mailbox button (which opens the mailbox; only with "Show agent card
//      shortcuts" on, like an agent's hover row), and its own project token;
//   §3 its menu, on the card and wherever agentMenuEntries is used for it
//      (the Agents List), offers the project's own actions only.
// The hire token itself is tests/projecttoken.test.tsx; the engine half is
// tools/rig/proofs/project-nodes.mjs.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectnode

import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import * as newproject from '../src/canvas/newproject'
import { ProjectDraftNode, projectDraftSteps } from '../src/canvas/newproject'
import { ProjectSquare } from '../src/canvas/projectcard'
import { NodeSquare } from '../src/canvas/cards'
import { agentMenuEntries, projectMenuEntries } from '../src/canvas/agentmenu'
import type { AgentMenuHandlers } from '../src/canvas/agentmenu'
import { agentItems } from '../src/canvas/docket'
import type { WorkItem } from '../src/types'
import { DRAFT, setAgentShortcutsOn, withDraftTree } from '../src/canvas/shared'
import type { CanvasNode, DraftState, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const offer = { enabled: true, installed: true, reason: null }
const seats = { haiku: 1, sonnet: 2, opus: 5 }

/* ─── §1 the draft project card ─────────────────────────────────────────── */
// USER 2026-10-17 19:14Z: making a project by hand works like a manual hire:
// a draft card on the canvas that the camera walks to, with a name and a
// description. The old "New project" form is gone.

const steps = (draft: DraftState, name = 'website', description = 'The company website.') =>
  projectDraftSteps(draft, name, description)

test('§1a under a node: one create_project with the name, the description and the parent', () => {
  assert.deepEqual(steps({ parent: 'boss', tier: 'project', project: true }),
    [{ op: 'create_project', name: 'website', description: 'The company website.', parent: 'boss' }])
  assert.deepEqual(steps({ parent: 'boss', tier: 'project', project: true }, 'website', ''),
    [{ op: 'create_project', name: 'website', parent: 'boss' }], 'no description, no key')
})

test('§1b at the top level the parent is the user', () => {
  assert.equal(steps({ parent: null, tier: 'project', project: true })[0]!.parent, 'user')
})

test('§1c above a node: the anchor rides the op and no parent is sent', () => {
  assert.deepEqual(steps({ parent: 'boss', tier: 'project', project: true, above: { anchor: 'dev1' } }),
    [{ op: 'create_project', name: 'website', description: 'The company website.', above: 'dev1' }])
})

test('§1d beside a node: created among its siblings, then the side hire\'s reorder', () => {
  assert.deepEqual(steps({ parent: 'boss', tier: 'project', project: true, beside: { anchor: 'dev1', side: 'left' } }), [
    { op: 'create_project', name: 'website', description: 'The company website.', parent: 'boss' },
    { op: 'reorder', node: 'website', before: 'dev1' },
  ])
  assert.deepEqual(steps({ parent: 'boss', tier: 'project', project: true, beside: { anchor: 'dev1', side: 'right' } })[1],
    { op: 'reorder', node: 'website', after: 'dev1' })
})

test('§1d2 spaces in a typed name become hyphens, for the create and the side reorder alike', () => {
  // USER 2026-10-17 19:22:46Z (docket hiring-spaces-in-an-agent-s-name-become-hyphens-a)
  assert.deepEqual(steps({ parent: 'boss', tier: 'project', project: true, beside: { anchor: 'dev1', side: 'right' } }, 'my  web site', ''), [
    { op: 'create_project', name: 'my-web-site', parent: 'boss' },
    { op: 'reorder', node: 'my-web-site', after: 'dev1' },
  ])
})

test('§1e the preview tree holds a draft PROJECT card where the project will go', () => {
  const tree = { slug: 'org', roots: [{ id: 'boss', title: 'boss', tier: 'haiku', state: 'live', children: [] }] } as unknown as TreePayload
  const root = withDraftTree(tree, { parent: 'boss', tier: 'project', project: true })
  const d = root.children[0]!.children[0]!
  assert.equal(d.id, DRAFT)
  assert.equal(d.kind, 'project')
  assert.equal(d.state, 'draft')
})

async function draftCard() {
  const confirmed: [string, string][] = []
  let cancelled = 0
  const view = await mountView(<ProjectDraftNode pos={{ x: 0, y: 0 }}
    onConfirm={(n, d) => { confirmed.push([n, d]) }} onCancel={() => { cancelled++ }} />, (el) => el)
  return { view, confirmed, cancelled: () => cancelled }
}

test('§1f the draft card: a dashed project square with a focused name, a description and create', async (t) => {
  const c = await draftCard()
  t.after(() => c.view.unmount())
  const sq = c.view.el.querySelector<HTMLElement>('.sq.draft.project')
  assert.ok(sq, 'a draft project card')
  assert.ok(sq.querySelector('.project-mark svg'), 'the folder mark in place of a tier token')
  assert.equal(sq.querySelector('.cbar') === null, true, 'no credit bar: projects are free')
  const name = sq.querySelector<HTMLInputElement>('input.df-name')!
  assert.equal(document.activeElement, name, 'the name takes the keyboard')
  const description = sq.querySelector<HTMLTextAreaElement>('textarea.df-charter')!
  assert.match(description.placeholder, /description/)
  const create = [...sq.querySelectorAll('button')].find((b) => /create/.test(b.textContent ?? ''))!
  assert.equal(create.disabled, true, 'nothing to create without a name')
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(name, ' website ')
    name.dispatchEvent(new Event('input', { bubbles: true }))
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      .call(description, ' The company website. ')
    description.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await inAct(() => { create.click() })
  assert.deepEqual(c.confirmed, [['website', 'The company website.']])
})

test('§1g cancel and Escape drop the draft', async (t) => {
  const c = await draftCard()
  t.after(() => c.view.unmount())
  const cancel = [...c.view.el.querySelectorAll('button')].find((b) => /cancel/.test(b.textContent ?? ''))!
  await inAct(() => { cancel.click() })
  await inAct(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  assert.equal(c.cancelled(), 2)
  assert.deepEqual(c.confirmed, [])
})

test('§1h the "New project" form is gone', () => {
  assert.equal('NewProjectModal' in newproject, false)
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

const square = (nd: CanvasNode, h: { inbox?: () => void; hire?: (t: string) => void; project?: () => void } = {}) =>
  mountView(<ProjectSquare node={nd} pos={{ x: 0, y: 0 }} lod="norm" dragging={false} isDrop={false}
    op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop} zoom={2}
    hire={{ claudeHire: offer }} seats={seats} onHire={h.hire ?? noop} onInbox={h.inbox ?? noop}
    onNewProject={h.project ?? noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)

test('§2a a project draws as a project card: no model, credit bar, desk or turn state', async (t) => {
  const view = await square(project())
  t.after(() => view.unmount())
  const sq = view.el.querySelector<HTMLElement>('.sq.project')
  assert.ok(sq, 'the project card')
  assert.equal(sq.getAttribute('aria-label'), 'project website')
  assert.ok(sq.querySelector('.project-mark svg'), 'the folder mark')
  assert.equal(sq.querySelector('.name')?.textContent, 'website')
  // USER 2026-10-17 19:37Z: no PROJECT word on the card; the folder mark says it
  assert.equal(sq.querySelector('.project-kind') === null, true, 'no "project" label on the card')
  assert.equal(/project/i.test(sq.querySelector('.sq-head')?.textContent ?? ''), false, 'nor anywhere in its head')
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

test('§2b0 the mailbox hover button follows "Show agent card shortcuts" (off by default)', async (t) => {
  // USER 2026-10-17 19:37Z: no inbox hover button unless the hover-buttons setting is on
  setAgentShortcutsOn(false)
  const off = await square(project())
  t.after(() => off.unmount())
  assert.equal(off.el.querySelector('button.mailbtn') === null, true, 'no mailbox button with the setting off')
})

test('§2b its waiting mail shows on the mailbox button, which opens the mailbox', async (t) => {
  setAgentShortcutsOn(true)
  t.after(() => setAgentShortcutsOn(false))
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
  let drafts = 0
  const live = await square(project(), { hire: (tier) => hired.push(tier), project: () => { drafts++ } })
  t.after(() => live.unmount())
  assert.ok(live.el.querySelector('.hsof'), 'the hire strip under the project')
  const opus = live.el.querySelector<HTMLButtonElement>('.hsof button.t-opus')!
  await inAct(() => { opus.click() })
  assert.deepEqual(hired, ['opus'], 'a tier token hires under the project')
  const tok = live.el.querySelector<HTMLButtonElement>('.hsof button.project-token')!
  await inAct(() => { tok.click() })
  assert.equal(drafts, 1, 'the project token asks the canvas for a draft project under it')
  assert.equal(document.querySelector('.new-project') === null, true, 'no form opens')
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
