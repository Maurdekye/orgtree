// teampresent.test.tsx — TEAM PRESENTATIONS and the presenting agent (Orgtree
// 4.4.0; docket `project-nodes-in-the-org-hierarchy-with-a-fair-p`, point 25,
// user 2026-10-17 22:47Z, 22:47:29Z, 22:47:51Z).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the agent menu's Open branch offers "Open team presentations" beside
//      "Open team docket", and it opens the gallery in team scope;
//   §2 the gallery in team scope asks the engine for team=1 (the agent and
//      everyone under it, passing through projects);
//   §3 every row names the agent that PRESENTED it — for a document presented
//      under a project that is the agent, not the project;
//   §4 a project's card and its desk header carry presentation chips for the
//      project's own documents and its subtree's.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs teampresent

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import type { AgentMenuHandlers } from '../src/canvas/agentmenu'
import { AgentGalleryView } from '../src/canvas/gallery'
import { ProjectSquare } from '../src/canvas/projectcard'
import { ProjectDesk } from '../src/canvas/projectdesk'
import type { CanvasNode, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}

/* ─── §1 the menu entry ─────────────────────────────────────────────────── */

test('§1 Open team presentations sits beside Open team docket and opens the team gallery', () => {
  const boss = { id: 'boss', title: 'boss', tier: 'opus', state: 'live', children: [], documents: [] } as unknown as CanvasNode
  let opened = 0
  const h = {
    onInbox: noop, onSettings: noop, onRetireAsk: noop, onHire: noop, onTeamDocket: noop,
    onTeamPresentations: () => { opened++ },
  } as unknown as AgentMenuHandlers
  const open = agentMenuEntries(boss, h, {}).find((e) => e !== 'sep' && e.label === 'Open')
  assert.ok(open && open !== 'sep')
  const labels = open.children!.map((c) => c === 'sep' ? 'sep' : c.label)
  const at = labels.indexOf('Open team presentations')
  assert.ok(at > 0, JSON.stringify(labels))
  assert.equal(labels[at - 1], 'Open team docket', 'right after the team docket')
  const entry = open.children![at]
  assert.ok(entry !== 'sep')
  entry.onSelect()
  assert.equal(opened, 1)
})

/* ─── §2 and §3 the gallery ─────────────────────────────────────────────── */

function stubDocuments(t: TestContext, docs: unknown[]) {
  const urls: string[] = []
  const had = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const u = String(input)
    const body = u.includes('/documents?') ? { documents: docs, total: docs.length, next_offset: null, offset: 0 } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = had })
  return urls
}
const doc = (id: string, node: string, presented_by: string, title: string) => ({
  id, node, presented_by, presenter_tier: 'opus', title, at: new Date().toISOString(),
  evicted: false, node_state: 'live', tier: node === 'website' ? 'project' : 'haiku',
})

test('§2 the team gallery asks for team=1', async (t) => {
  const urls = stubDocuments(t, [])
  const view = await mountView(<AgentGalleryView slug="org" nid="boss" toast={noop} team />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(6) })
  assert.ok(urls.some((u) => u.includes('/documents?') && u.includes('node=boss') && u.includes('team=1')), JSON.stringify(urls))
})

test('§3 every row names the agent that presented it, also under a project', async (t) => {
  stubDocuments(t, [doc('d1', 'website', 'boss', 'Website plan'), doc('d2', 'dev5', 'dev5', 'UI sketch')])
  const view = await mountView(<AgentGalleryView slug="org" nid="boss" toast={noop} team />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(6) })
  const rows = [...view.el.querySelectorAll('.doc-gallery-row .l2')]
  assert.deepEqual(rows.map((r) => r.getAttribute('data-copy-agent-name')), ['boss', 'dev5'],
    'the presenting agents, not the project')
})

test('§3b the presenter is a LINK: a click focuses that agent and does not select the row (review of a590555)', async (t) => {
  stubDocuments(t, [doc('d1', 'website', 'boss', 'Website plan'), doc('d2', 'dev5', 'dev5', 'UI sketch')])
  const focused: string[] = []
  const view = await mountView(<AgentGalleryView slug="org" nid="boss" toast={noop} team
    onFocusAgent={(id) => { focused.push(id) }} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(6) })
  const selected = () => [...view.el.querySelectorAll('.doc-gallery-row.on')].length
  const before = selected()
  const link = view.el.querySelectorAll<HTMLButtonElement>('.doc-gallery-row .l2 button.cc-name-jump')[1]
  assert.ok(link, 'the second row\'s presenter is a button')
  assert.equal(link.textContent, 'dev5')
  await inAct(() => { link.click() })
  assert.deepEqual(focused, ['dev5'], 'focuses the presenting agent')
  assert.equal(selected(), before, 'the row selection did not change')
})

/* ─── §4 a project's presentation chips ─────────────────────────────────── */

const withDocs = () => ({
  id: 'website', title: 'website', kind: 'project', state: 'live', tier: 'project', model_id: '', parent: 'boss',
  seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, charter: 'The site.',
  documents: [{ id: 'p1', title: 'Website plan', at: new Date().toISOString() }],
  children: [{ id: 'dev1', title: 'dev1', tier: 'haiku', state: 'live', children: [],
    documents: [{ id: 'a1', title: 'Dev notes', at: new Date(Date.now() - 1000).toISOString() }] }],
  lineage: [], turns: [], audiences_held: [], mail_pending: 0,
} as unknown as CanvasNode)

test('§4a the project card carries chips for its own and its subtree\'s presentations', async (t) => {
  stubDocuments(t, [])
  const view = await mountView(<ProjectSquare node={withDocs()} pos={{ x: 0, y: 0 }} lod="norm" dragging={false}
    isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop} zoom={1.2} hire={{}} seats={{}}
    onHire={noop} onNewProject={noop} onInbox={noop} onOpenDoc={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelectorAll('.sq.project .doc-chips .doc-chip').length, 2)
})

test('§4b the project desk header carries the same presentations strip', async (t) => {
  stubDocuments(t, [])
  const nd = withDocs()
  const view = await mountView(<ProjectDesk node={nd} slug="org" tree={{ slug: 'org', roots: [] } as unknown as TreePayload}
    map={new Map([[nd.id, nd]])} op={() => Promise.resolve({} as OpResult)} toast={noop}
    refs={{ world: { org: 'org' }, onOpen: noop } as never} onOpenDoc={noop} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  assert.equal(view.el.querySelectorAll('.desk-docs .doc-badge').length, 2)
})
