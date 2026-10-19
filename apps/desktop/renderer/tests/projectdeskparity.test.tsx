// projectdeskparity.test.tsx — the PROJECT DESK behaves like the agent desk
// wherever they are not signed to differ (Orgtree 4.4.0; docket
// `final-parity-pass-project-desks-behave-like-agen`, user 2026-10-19
// 19:59:19Z: "make sure that project desks function the same way as agent
// desks in every meaningful or relevant way"). The inventory behind each
// section is desk-parity-opus's desk-parity-inventory.md (G = gap number).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   G1  the slots tab survives a slot_status or older-history answer
//       without its lists (coordinator 2026-10-19 20:12Z);
//   G2  the up cards pass through projects to the nearest agent superior,
//       as the agent desk's up row does (user 2026-10-17 22:13Z);
//   G3  the down row passes through nested projects and keeps retired
//       members behind the agent desk's retired controls;
//   G4  the inbox tab retracts one waiting mail of the user's own;
//   G5  mail waiting in the queue reads "waiting in the project queue"
//       (coordinator 2026-10-19 20:15Z), never "awaiting next turn";
//   G6  the project's unread folder count wears no provider's colour;
//   G7  the docket badge is the agent badge's rule: actionable tickets
//       owned, here by the agents under the project;
//   G21 the project's inbox window (Project mailbox, the tab's pin and
//       pop-out) is the desk tab's mailbox: project rows, listeners, purge.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectdeskparity

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import * as projectdesk from '../src/canvas/projectdesk'
import { SlotsView } from '../src/canvas/slotsdesk'
import { setHideRetiredOn, USER } from '../src/canvas/shared'
import type { CanvasNode, MailRow } from '../src/canvas/shared'
import type { OpRequest, OpResult, TreePayload, WorkItem } from '../src/types'

const { ProjectDesk } = projectdesk
const noop = () => {}
const refs = { world: { org: 'org' }, onOpen: noop } as never

const agent = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, title: id, tier: 'haiku', state: 'live', busy: false, children: [], seat: 1, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, turns: [], audiences_held: [], ...extra,
} as unknown as CanvasNode)
const project = (id: string, children: CanvasNode[], extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, title: id, kind: 'project', tier: 'project', state: 'live', model_id: '', seat: 0, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [] }, charter: 'The site.',
  children, lineage: [], turns: [], audiences_held: [], mail_pending: 0,
  last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null, ...extra,
} as unknown as CanvasNode)

/** every node of a tree, with its parent filled in, as the canvas map has it */
function mapOf(...roots: CanvasNode[]): Map<string, CanvasNode> {
  const out = new Map<string, CanvasNode>()
  const add = (n: CanvasNode, parent: string | null) => {
    const current = parent === null ? n : { ...n, parent } as CanvasNode
    out.set(current.id, current)
    for (const c of current.children ?? []) add(c, current.id)
  }
  for (const r of roots) add(r, (r as { parent?: string | null }).parent ?? null)
  return out
}

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body),
  { status: 200, headers: { 'Content-Type': 'application/json' } }))

/** the fake server, with the routes a test answers itself in front of it;
 *  every request is recorded as "METHOD /path" */
function serve(t: TestContext, routes: (method: string, path: string, url: URL) => Promise<Response> | null = () => null) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  const inner = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url), 'http://fixture.invalid')
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${u.pathname}`)
    const own = routes(method, u.pathname, u)
    if (own) return own
    if (method === 'GET' && /\/nodes\/[^/]+\/inbox$/.test(u.pathname)) return json({ pending: [], delivered: [], sent: [] })
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  return calls
}

const slotStatus = (o: Record<string, unknown> = {}) =>
  ({ project: 'website', slots: 1, held: 0, holders: [], line: [], history: [], history_next: null, ...o })
async function mountDesk(t: TestContext, node: CanvasNode, map: Map<string, CanvasNode>, h: {
  bare?: boolean; jump?: (id: string) => void; tree?: TreePayload; ops?: OpRequest[]
} = {}) {
  const ops = h.ops ?? []
  const view = await mountView(<ProjectDesk node={node} slug="org" tree={h.tree ?? { slug: 'org', roots: [] } as unknown as TreePayload}
    map={map} op={(b) => { ops.push(b); return Promise.resolve((b.op === 'slot_status' ? slotStatus() : {}) as unknown as OpResult) }}
    toast={noop} refs={refs} bare={h.bare} onJump={h.jump ?? noop} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  return view.el
}
const chipNames = (row: Element | null | undefined) =>
  [...(row?.querySelectorAll('button.desk-nav-chip[data-copy-agent-name]') ?? [])].map((b) => b.getAttribute('data-copy-agent-name'))
const openTab = async (el: Element, tab: string) => {
  await inAct(async () => { el.querySelector<HTMLButtonElement>(`.cc-tabs button[data-tab="${tab}"]`)!.click(); await flush(4) })
}

/* ─── G1 the slots tab survives a short answer ──────────────────────────── */

const slotNode = () => project('website', [], { configured_scope: { tools: {}, add_dirs: [], slots_capacity: 1 } } as Partial<CanvasNode>)
const slotState = { total: 1, held: [], line: [] }

test('G1a a slot_status without its lists shows the empty sections instead of crashing', async (t) => {
  const v = await mountView(<SlotsView node={slotNode()} state={slotState as never} map={new Map()}
    op={async () => ({}) as OpResult} toast={noop} />, (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(4) })
  assert.ok(v.el.querySelector('.slots-table'), 'the slots table is still drawn')
  const text = v.el.textContent ?? ''
  assert.match(text, /Nobody holds a concurrency slot/)
  assert.match(text, /Nobody is waiting\./)
  assert.match(text, /No concurrency slot has been held yet\./)
})

test('G1b a re-read without history keeps the tab, after a well-formed one', async (t) => {
  let reads = 0
  const op = async (b: OpRequest) => (b.op === 'slot_status'
    ? ++reads === 1 ? slotStatus({ history: [{ lease: 's1', agent: 'dev1', slot: 1, since: '2026-10-19T10:00:00Z', ended: '2026-10-19T11:00:00Z' }] })
      : { project: 'website', slots: 1, held: 0, holders: [], line: [] }
    : {}) as unknown as OpResult
  const render = (total: number) => <SlotsView node={slotNode()} state={{ ...slotState, total } as never} map={new Map()} op={op} toast={noop} />
  const v = await mountView(render(1), (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(4) })
  assert.equal(v.el.querySelectorAll('.slots-history .slot-lease').length, 1, 'positive control: the first answer\'s hold')
  await v.render(render(2))
  await inAct(async () => { await flush(4) })
  assert.equal(reads, 2, 'the tab read the status again')
  assert.ok(v.el.querySelector('.slots-table'), 'the slots table is still drawn')
})

test('G1c an older-history page without rows ends the paging and keeps the loaded rows', async (t) => {
  const op = async (b: OpRequest) => (b.op === 'slot_status'
    ? slotStatus({ history: [{ lease: 's2', agent: 'dev1', slot: 1, since: '2026-10-19T10:00:00Z', ended: '2026-10-19T11:00:00Z' }], history_next: 'c1' })
    : {}) as unknown as OpResult
  const v = await mountView(<SlotsView node={slotNode()} state={slotState as never} map={new Map()} op={op} toast={noop} />, (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(4) })
  const scroll = v.el.querySelector<HTMLElement>('.slots-table-scroll')!
  Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 }, scrollTop: { configurable: true, value: 1600 } })
  await inAct(async () => { scroll.dispatchEvent(new Event('scroll', { bubbles: true })); await flush(4) })
  assert.ok(v.el.querySelector('.slots-table'), 'the slots table is still drawn')
  assert.deepEqual([...v.el.querySelectorAll('.slots-history .slot-lease')].map((r) => r.textContent), ['s2'])
  assert.equal(/Scroll for older holds/.test(v.el.textContent ?? ''), false, 'no further page is offered')
})

/* ─── G2 up through projects ────────────────────────────────────────────── */

test('G2a a nested project\'s up cards pass through the outer project to the nearest agent superior', async (t) => {
  serve(t)
  const inner = project('inner', [agent('dev1')])
  const outer = project('outer', [inner])
  const boss = agent('boss', { children: [outer] } as Partial<CanvasNode>)
  const map = mapOf(boss)
  const jumped: string[] = []
  const el = await mountDesk(t, map.get('inner')!, map, { jump: (id) => jumped.push(id) })
  const head = el.querySelector('.cc-head .project-head-cards')
  assert.deepEqual(chipNames(head), ['boss', 'outer'], 'the agent superior first, then the projects between, outermost first')
  await inAct(() => { head!.querySelector<HTMLButtonElement>('button[data-copy-agent-name="boss"]')!.click() })
  assert.deepEqual(jumped, ['boss'])
})

test('G2b a top-level project points at the switchboard on the canvas, not in a pinned window', async (t) => {
  serve(t)
  const top = project('top', [agent('dev1')], { parent: USER } as Partial<CanvasNode>)
  const eye = { id: USER, parent: null, tier: null, state: 'user', children: [top] } as unknown as CanvasNode
  const map = mapOf(eye)
  const canvas = await mountDesk(t, map.get('top')!, map)
  assert.match(canvas.querySelector('.cc-head .project-head-cards')?.textContent ?? '', /switchboard/)
  const pinned = await mountDesk(t, map.get('top')!, map, { bare: true })
  assert.equal(/switchboard/.test(pinned.querySelector('.cc-head')?.textContent ?? ''), false)
})

/* ─── G3 down through projects, retired behind its control ──────────────── */

const team = () => {
  const ui = project('ui', [agent('dev2'), agent('old', { state: 'archived' } as Partial<CanvasNode>)])
  const website = project('website', [agent('dev1'), ui, agent('gone', { state: 'archived' } as Partial<CanvasNode>)],
    { parent: 'boss' } as Partial<CanvasNode>)
  const map = mapOf(agent('boss', { children: [website] } as Partial<CanvasNode>))
  return { website: map.get('website')!, map }
}

test('G3a the members\' row passes through nested projects and folds retired members behind "show N retired"', async (t) => {
  serve(t)
  const { website, map } = team()
  const jumped: string[] = []
  const el = await mountDesk(t, website, map, { jump: (id) => jumped.push(id) })
  const row = el.querySelector('.desk-nav')
  assert.deepEqual(chipNames(row), ['dev1', 'ui', 'dev2'], 'live members, nested projects crossed')
  const toggle = [...row!.querySelectorAll<HTMLButtonElement>('button.desk-nav-chip')].find((b) => /retired/.test(b.textContent ?? ''))
  assert.ok(toggle, 'the agent desk\'s retired control')
  assert.equal(toggle!.textContent, 'show 2 retired')
  assert.equal(toggle!.title, 'old, gone')
  await inAct(() => { toggle!.click() })
  assert.deepEqual(chipNames(el.querySelector('.desk-nav')), ['dev1', 'ui', 'dev2', 'old', 'gone'])
  assert.equal(toggle!.textContent, 'hide retired')
  await inAct(() => { el.querySelector<HTMLButtonElement>('.desk-nav button[data-copy-agent-name="dev2"]')!.click() })
  assert.deepEqual(jumped, ['dev2'], 'a nested member jumps')
})

test('G3b with retired agents hidden, the row offers the "N retired" picker instead', async (t) => {
  serve(t)
  setHideRetiredOn(true)
  t.after(() => setHideRetiredOn(false))
  const { website, map } = team()
  const el = await mountDesk(t, website, map)
  const token = el.querySelector<HTMLButtonElement>('.desk-nav button.desk-retired-token')
  assert.ok(token, 'the agent desk\'s retired token')
  assert.equal(token!.textContent?.trim(), '2 retired')
  assert.deepEqual(chipNames(el.querySelector('.desk-nav')), ['dev1', 'ui', 'dev2'])
})

/* ─── G4-G6 the inbox tab ───────────────────────────────────────────────── */

const waiting: MailRow = { id: 'm1', from: '@user', kind: 'message', body: 'Please deploy.', at: '2026-10-19T12:00:00Z' } as MailRow
const inboxRoutes = (pending: MailRow[]) => (method: string, path: string) =>
  method === 'GET' && path === '/api/orgs/org/nodes/website/inbox' ? json({ pending, delivered: [], sent: [] })
    : method === 'DELETE' && path === '/api/orgs/org/nodes/website/mail/m1' ? json({ retracted: 'm1' }) : null

test('G4 the inbox tab retracts a waiting mail of the user\'s own, as the agent desk\'s does', async (t) => {
  const calls = serve(t, inboxRoutes([waiting]))
  const el = await mountDesk(t, project('website', [agent('dev1')], { parent: 'boss', mail_pending: 1 } as Partial<CanvasNode>),
    mapOf(project('website', [agent('dev1')])))
  await openTab(el, 'inbox')
  const x = el.querySelector<HTMLButtonElement>('.mailrow button.chip-x[title="retract (undelivered)"]')
  assert.ok(x, 'the waiting row\'s retract ✕')
  await inAct(async () => { x!.click(); await flush(4) })
  assert.ok(calls.includes('DELETE /api/orgs/org/nodes/website/mail/m1'), calls.join('\n'))
})

test('G5 a mail waiting in the project queue says so, not "awaiting next turn"', async (t) => {
  serve(t, inboxRoutes([waiting]))
  const el = await mountDesk(t, project('website', [], { mail_pending: 1 } as Partial<CanvasNode>), mapOf(project('website', [])))
  await openTab(el, 'inbox')
  await inAct(async () => { el.querySelector<HTMLElement>('.mailrow')!.click(); await flush(2) })
  const wait = el.querySelector('.mailer-head .wait')
  assert.ok(wait, 'the reading pane names the waiting state')
  assert.equal(wait!.textContent, 'waiting in the project queue')
})

test('G6 the project\'s unread folder count wears no provider\'s colour', async (t) => {
  serve(t, inboxRoutes([waiting]))
  const el = await mountDesk(t, project('website', [], { mail_pending: 1 } as Partial<CanvasNode>), mapOf(project('website', [])))
  await openTab(el, 'inbox')
  const count = el.querySelector('.mail-folders .tab-count')
  assert.ok(count, 'positive control: the inbox folder counts the waiting mail')
  assert.equal(count!.textContent, '1')
  assert.equal([...count!.classList].some((c) => c.startsWith('prov-')), false, count!.className)
  const tab = el.querySelector('.cc-tabs button[data-tab="inbox"] .tab-count')
  assert.equal([...tab!.classList].some((c) => c.startsWith('prov-')), false, 'the desk\'s own tab count neither')
})

/* ─── G7 the docket badge ───────────────────────────────────────────────── */

const ticket = (slug: string, owner: string, o: Partial<WorkItem> = {}): WorkItem => ({
  slug, rev: 1, kind: 'code', title: slug, objective: slug, status: 'in_progress',
  blocked_reason: null, archived: false, archived_at: null,
  owner: { node: owner, generation: 0 }, owner_current: true, owner_state: 'live',
  reviewer: null, participants: [], created_by: { node: owner, generation: 0 },
  at: '2026-10-19T08:00:00.000Z', updated_at: '2026-10-19T09:00:00.000Z',
  done_so_far: [], working_on_next: [], docket_at: '2026-10-19T09:00:00.000Z',
  last_updater: { node: owner, generation: 0 }, manual_attention: null, dismissals: [],
  questions: [], effective_attention: false, attention_sources: [], acceptance: [],
  dependencies: [], evidence: [], delivery: null, accepted: null, superseded_by: null,
  history: [], ...o,
} as WorkItem)

test('G7 the docket badge counts the actionable tickets the agents under the project own, as the agent badge does', async (t) => {
  const rows = [ticket('build-it', 'dev1'), ticket('check-it', 'dev2', { status: 'review' }),
    ticket('stuck', 'dev1', { status: 'blocked', blocked_reason: 'waits' }), ticket('shipped', 'dev2', { status: 'done' }),
    ticket('old-claim', 'dev1', { owner_current: false })]
  // the engine reads `agent=<project>` as the team view rooted at the project
  serve(t, (method, path, url) => method === 'GET' && path.endsWith('/work-items-page')
    ? json({ format: 'orgtree.work-page/v1', group: url.searchParams.get('group') ?? 'items',
      rows: (url.searchParams.get('group') ?? 'items') === 'items' ? rows : [], total: rows.length,
      totals: { items: rows.length, archived: 0, backlogged: 0 }, matched: { items: rows.length, archived: 0, backlogged: 0 },
      counts: { active: 4, attention: 0, archived: 0, backlogged: 0 }, assigned_count: 0,
      next_offset: null, revision: 'r1', at: '2026-10-19T10:00:00.000Z' })
    : null)
  const website = project('website', [agent('dev1'), agent('dev2')], { parent: 'boss' } as Partial<CanvasNode>)
  const map = mapOf(agent('boss', { children: [website] } as Partial<CanvasNode>))
  const el = await mountDesk(t, map.get('website')!, map,
    { tree: { slug: 'org', roots: [map.get('boss')!] } as unknown as TreePayload })
  await openTab(el, 'docket')
  assert.equal(el.querySelectorAll('.docket-row').length, 5, 'positive control: the tab lists all five')
  assert.equal(el.querySelector('.cc-tabs button[data-tab="docket"] .tab-count')?.textContent, '2',
    'in progress and in review count; blocked, done and a stale claim do not')
})

/* ─── G21 the project's inbox window ────────────────────────────────────── */

test('G21 the project\'s inbox window is its desk tab\'s mailbox: project rows, listeners folder and purge', async (t) => {
  serve(t, inboxRoutes([waiting]))
  // read off the module, so the suite still runs (and this fails) where the
  // window does not exist yet
  const Modal = (projectdesk as unknown as Record<string, unknown>).ProjectInboxModal as typeof projectdesk.ProjectDeskModal | undefined
  assert.equal(typeof Modal, 'function', 'a project inbox window exists')
  const Window = Modal as typeof projectdesk.ProjectDeskModal
  const website = project('website', [agent('dev1')], { mail_pending: 1 } as Partial<CanvasNode>)
  const props = { node: website, slug: 'org', tree: { slug: 'org', roots: [] } as unknown as TreePayload, map: mapOf(website),
    op: () => Promise.resolve({ purged: 1 } as unknown as OpResult), toast: noop, refs, close: noop }
  const view = await mountView(<Window {...props as unknown as Parameters<typeof Window>[0]} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  // the window is portaled out of the mount
  const win = document
  assert.ok(win.querySelector('.mailrow.project-mail'), 'the project mail row')
  assert.deepEqual([...win.querySelectorAll('.mail-folders button')].map((b) => b.textContent?.replace(/\d+$/, '').trim()),
    ['inbox', 'sent', 'listeners'], 'the listeners folder')
  const purge = win.querySelector<HTMLButtonElement>('button[data-action="purge-queue"]')
  assert.ok(purge, 'the purge button')
  assert.equal([...(win.querySelector('.mail-folders .tab-count')?.classList ?? [])].some((c) => c.startsWith('prov-')), false,
    'no provider colour on its count')
})
