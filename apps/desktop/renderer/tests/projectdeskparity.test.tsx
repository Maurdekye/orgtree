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
// Batch 2, the header and the message box:
//   G14 the header name is the agent desk's: a link wherever it is not
//       where the click would take you;
//   G15 the header shows the audiences the project holds, as the agent's;
//   G16 a revealed retired project's desk offers dismiss;
//   G20 the gear falls back to the shell's settings route;
//   G17 a project desk is the last desk once used, in neutral chrome;
//   G8  the message box grows with the draft, as the agent's does;
//   G13 the canvas desk's box takes the caret when it opens;
//   G9  staged attachments survive closing the desk, images as thumbnails;
//   G10 a file dropped anywhere on the desk is attached;
//   G11 reply previews are the agent composer's: several, kept with the
//       draft, Escape cancels them;
//   G12 the notice toggle is the agent desk's per-desk store, and Alt+N /
//       Alt+B work anywhere inside the desk.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectdeskparity

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import * as projectdesk from '../src/canvas/projectdesk'
import { forgetDeskMemory } from '../src/canvas/desktabs'
import { SlotsView } from '../src/canvas/slotsdesk'
import { AgentSurfaceRoutesProvider } from '../src/canvas/panelcorner'
import { buttonAccent, buttonAgentOf, setButtonAgent } from '../src/buttoncolours'
import { resetNoticeStore } from '../src/noticestore'
import { setHideRetiredOn, USER } from '../src/canvas/shared'
import type { CanvasNode, MailRow } from '../src/canvas/shared'
import type { OpRequest, OpResult, TreePayload, WorkItem } from '../src/types'
import type { ReactElement } from 'react'

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
  // each test opens the desk on Summary, not on the tab an earlier one picked
  forgetDeskMemory()
  const view = await mountView(<ProjectDesk node={node} slug="org" tree={h.tree ?? { slug: 'org', roots: [] } as unknown as TreePayload}
    map={map} op={(b) => { ops.push(b); return Promise.resolve((b.op === 'slot_status' ? slotStatus() : {}) as unknown as OpResult) }}
    toast={noop} refs={refs} bare={h.bare} onJump={h.jump ?? noop} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  return view.el
}
const chipNames = (row: Element | null | undefined) =>
  [...(row?.querySelectorAll('button.desk-nav-chip[data-copy-agent-name]') ?? [])].map((b) => b.getAttribute('data-copy-agent-name'))
/** the agent desk's up row, the header's next sibling, and the members' row,
 *  the other jump row (above the message box) */
const upRow = (el: Element) => el.querySelector('.cc-head + .desk-nav')
const membersRow = (el: Element) => [...el.querySelectorAll('.desk-nav')].find((r) => r !== upRow(el)) ?? null
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
  // on the agent desk's up row right under the header, never among the
  // header cards (user 2026-10-19 21:05:53Z, 21:06:08Z)
  const up = upRow(el)
  assert.deepEqual(chipNames(up), ['boss', 'outer'], 'the agent superior first, then the projects between, outermost first')
  assert.deepEqual(chipNames(el.querySelector('.cc-head')), [], 'no jump card among the header cards')
  await inAct(() => { up!.querySelector<HTMLButtonElement>('button[data-copy-agent-name="boss"]')!.click() })
  assert.deepEqual(jumped, ['boss'])
})

test('G2b a top-level project points at the switchboard on the canvas, not in a pinned window', async (t) => {
  serve(t)
  const top = project('top', [agent('dev1')], { parent: USER } as Partial<CanvasNode>)
  const eye = { id: USER, parent: null, tier: null, state: 'user', children: [top] } as unknown as CanvasNode
  const map = mapOf(eye)
  const canvas = await mountDesk(t, map.get('top')!, map)
  assert.match(upRow(canvas)?.textContent ?? '', /switchboard/)
  const pinned = await mountDesk(t, map.get('top')!, map, { bare: true })
  assert.equal(/switchboard/.test(pinned.querySelector('.cc-head')?.textContent ?? ''), false)
  assert.equal(upRow(pinned) === null, true, 'no up row in a pinned window')
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
  const row = membersRow(el)
  assert.deepEqual(chipNames(row), ['dev1', 'ui', 'dev2'], 'live members, nested projects crossed')
  const toggle = [...row!.querySelectorAll<HTMLButtonElement>('button.desk-nav-chip')].find((b) => /retired/.test(b.textContent ?? ''))
  assert.ok(toggle, 'the agent desk\'s retired control')
  assert.equal(toggle!.textContent, 'show 2 retired')
  assert.equal(toggle!.title, 'old, gone')
  await inAct(() => { toggle!.click() })
  assert.deepEqual(chipNames(membersRow(el)), ['dev1', 'ui', 'dev2', 'old', 'gone'])
  assert.equal(toggle!.textContent, 'hide retired')
  await inAct(() => { membersRow(el)!.querySelector<HTMLButtonElement>('button[data-copy-agent-name="dev2"]')!.click() })
  assert.deepEqual(jumped, ['dev2'], 'a nested member jumps')
})

test('G3b with retired agents hidden, the row offers the "N retired" picker instead', async (t) => {
  serve(t)
  setHideRetiredOn(true)
  t.after(() => setHideRetiredOn(false))
  const { website, map } = team()
  const el = await mountDesk(t, website, map)
  const token = membersRow(el)?.querySelector<HTMLButtonElement>('button.desk-retired-token')
  assert.ok(token, 'the agent desk\'s retired token')
  assert.equal(token!.textContent?.trim(), '2 retired')
  assert.deepEqual(chipNames(membersRow(el)), ['dev1', 'ui', 'dev2'])
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
  assert.deepEqual([...win.querySelectorAll('.mail-folders > button')].map((b) => b.textContent?.replace(/\d+$/, '').trim()),
    ['inbox', 'sent', 'listeners'], 'the listeners folder')
  const purge = win.querySelector<HTMLButtonElement>('button[data-action="purge-queue"]')
  assert.ok(purge, 'the purge button')
  assert.equal([...(win.querySelector('.mail-folders .tab-count')?.classList ?? [])].some((c) => c.startsWith('prov-')), false,
    'no provider colour on its count')
})

/* ─── batch 2: the header and the message box ───────────────────────────── */

/** a project desk view the test can unmount and mount again */
async function deskView(t: TestContext, node: CanvasNode, h: {
  bare?: boolean; jump?: (id: string) => void; config?: () => void; dismiss?: () => void
  openDoc?: (id: string) => void; wrap?: (desk: ReactElement) => ReactElement
} = {}) {
  forgetDeskMemory()
  const desk = <ProjectDesk node={node} slug="org" tree={{ slug: 'org', roots: [] } as unknown as TreePayload}
    map={mapOf(node)} op={() => Promise.resolve({} as OpResult)} toast={noop} refs={refs} bare={h.bare}
    onJump={h.jump ?? noop} onConfig={h.config} onOpenDoc={h.openDoc} {...{ onDismiss: h.dismiss }} />
  const view = await mountView(h.wrap ? h.wrap(desk) : desk, (el) => el)
  let unmounted = false
  t.after(async () => { if (!unmounted) await view.unmount() })
  await inAct(async () => { await flush(4) })
  return { el: view.el, unmount: async () => { unmounted = true; await view.unmount() } }
}
const typeInto = async (box: HTMLTextAreaElement, text: string) => inAct(() => {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text)
  box.dispatchEvent(new Event('input', { bubbles: true }))
})
const composerBox = (el: Element) => el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!
/** the draft keys a project composer stores under, cleared after each test */
const forgetDrafts = (t: TestContext) => t.after(() => {
  for (const k of Object.keys(localStorage)) if (k.includes('project:website')) localStorage.removeItem(k)
  resetNoticeStore()
})

test('G14 the header name is a link from a window, plain on the focused canvas desk, as the agent desk\'s', async (t) => {
  serve(t)
  const jumped: string[] = []
  const popped = await deskView(t, project('website', [agent('dev1')]), { bare: true, jump: (id) => jumped.push(id) })
  const link = popped.el.querySelector<HTMLButtonElement>('.cc-head-left button.cc-name-jump')
  assert.ok(link, 'the shared AgentName link')
  assert.equal(link!.textContent, 'website')
  assert.ok(popped.el.querySelector('.cc-head-left > .project-mark svg'), 'its folder mark')
  await inAct(() => { link!.click() })
  assert.deepEqual(jumped, ['website'], 'the click goes to the project')
  const canvas = await deskView(t, project('website', [agent('dev1')]), { jump: (id) => jumped.push(id) })
  const name = canvas.el.querySelector('.cc-head-left .cc-name.name')
  assert.ok(name, 'the name, with its .name hook kept for the title-bar rules')
  assert.equal(name!.tagName, 'SPAN', 'the focused desk is where a click would take you: plain text')
})

test('G15 the header shows the audiences the project holds, with a revoke on the explicit grant', async (t) => {
  const calls: string[] = []
  serve(t, (method, path) => {
    if (method === 'POST' && path === '/api/orgs/org/audiences') { calls.push(path); return json({ ok: true }) }
    return null
  })
  const { el } = await deskView(t, project('website', [agent('dev1')],
    { audiences_held: ['@user'], audiences_explicit: ['@user'] } as Partial<CanvasNode>))
  const chip = el.querySelector('.cc-head .badge.aud-user')
  assert.ok(chip, 'the user audience chip, as on the agent desk')
  assert.match(chip!.textContent ?? '', /user/)
  const revoke = chip!.querySelector<HTMLButtonElement>('button.chip-x[title="Revoke"]')
  assert.ok(revoke, 'an explicit grant can be revoked')
  await inAct(async () => { revoke!.click(); await flush(2) })
  assert.deepEqual(calls, ['/api/orgs/org/audiences'])
})

test('G16 a revealed retired project offers dismiss, as a revealed retired agent does', async (t) => {
  serve(t)
  let dismissed = 0
  const { el } = await deskView(t, project('website', [], { state: 'archived' } as Partial<CanvasNode>),
    { dismiss: () => { dismissed++ } })
  const button = el.querySelector<HTMLButtonElement>('.cc-actions button[data-action="dismiss"]')
  assert.ok(button, 'the dismiss action')
  await inAct(() => { button!.click() })
  assert.equal(dismissed, 1)
  const plain = await deskView(t, project('website', [], { state: 'archived' } as Partial<CanvasNode>))
  assert.equal(!!plain.el.querySelector('button[data-action="dismiss"]'), false, 'none without a dismiss route')
})

test('G20 a host without a settings handler still has the gear: the shell\'s route opens the project\'s settings', async (t) => {
  serve(t)
  const opened: string[] = []
  const routes = { open: noop, show: noop, settings: (id: string) => { opened.push(id) } }
  const { el } = await deskView(t, project('website', [agent('dev1')]),
    { wrap: (desk) => <AgentSurfaceRoutesProvider value={routes}>{desk}</AgentSurfaceRoutesProvider> })
  const gear = el.querySelector<HTMLButtonElement>('button[aria-label="settings for website"]')
  assert.ok(gear, 'the gear')
  await inAct(() => { gear!.click() })
  assert.deepEqual(opened, ['website'])
})

test('G17 using a project desk makes it the last desk, and its chrome stays neutral', async (t) => {
  serve(t)
  setButtonAgent('org', null)
  t.after(() => setButtonAgent('org', null))
  const { el } = await deskView(t, project('website', [agent('dev1')]), { bare: true })
  await inAct(() => { el.querySelector('.project-desk')!.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })) })
  assert.equal(buttonAgentOf('org'), 'website', 'a press on a pinned project desk registers it, as on an agent desk')
  assert.equal(buttonAccent('project'), 'var(--line-hover)', 'a project wears no provider colour')
  assert.equal(buttonAccent('opus'), 'var(--prov-claude)', 'positive control: an agent wears its provider')
})

test('G8 the message box grows thirty lines beyond its base, scrolls at the cap and shrinks with the draft', async (t) => {
  serve(t); forgetDrafts(t)
  const { el } = await deskView(t, project('website', [agent('dev1')]), { bare: true })
  const box = composerBox(el)
  assert.equal(box.rows, 2, 'the composer starts with two rows')
  box.style.padding = '0px'; box.style.border = '0px'; box.style.boxSizing = 'content-box'
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `Draft line ${i + 1}`).join('\n')
  for (const lineHeight of [20, 24]) {
    box.style.lineHeight = `${lineHeight}px`
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () =>
      Math.max(Math.max(box.rows, box.value.split('\n').length) * lineHeight, parseFloat(box.style.height) || 0) })
    await typeInto(box, lines(10))
    assert.equal(parseFloat(box.style.height) / lineHeight, 10, 'draft grows by rendered lines at either font scale')
    assert.equal(box.style.overflowY, 'hidden')
    await typeInto(box, lines(box.rows + 30))
    assert.equal(parseFloat(box.style.height) / lineHeight - box.rows, 30, 'thirty extra lines fit')
    await typeInto(box, lines(box.rows + 45))
    assert.equal(parseFloat(box.style.height) / lineHeight - box.rows, 30, 'longer drafts stop at the line cap')
    assert.equal(box.style.overflowY, 'auto', 'text beyond the cap scrolls inside')
    await typeInto(box, 'short')
    assert.equal(parseFloat(box.style.height) / lineHeight, box.rows, 'deleting restores the base height')
    assert.equal(box.style.overflowY, 'hidden')
  }
})

test('G13 the canvas desk\'s message box takes the caret when it opens; a window does not', async (t) => {
  serve(t); forgetDrafts(t)
  // booleans, never the elements themselves: a failing check would hand the
  // reporter a React-managed node, and inspecting it exhausts memory (team
  // notes, round 439; it took the whole file down at the red commit)
  const canvas = await deskView(t, project('website', [agent('dev1')]))
  assert.equal(document.activeElement === composerBox(canvas.el), true, 'focused on the canvas desk')
  await canvas.unmount()
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  const pinned = await deskView(t, project('website', [agent('dev1')]), { bare: true })
  assert.equal(document.activeElement === composerBox(pinned.el), false, 'a window keeps focus where it was')
})

const pickFiles = async (input: HTMLInputElement, files: File[]) => inAct(async () => {
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await flush(4)
})

test('G9 staged attachments survive closing and reopening the desk; an image shows as its thumbnail with its size', async (t) => {
  serve(t); forgetDrafts(t)
  const first = await deskView(t, project('website', [agent('dev1')]), { bare: true })
  await pickFiles(first.el.querySelector<HTMLInputElement>('.project-composer input[type="file"]')!,
    [new File(['x'], 'notes.txt'), new File(['y'], 'shot.png')])
  assert.equal(first.el.querySelectorAll('.attach-row .attach-chip, .attach-row .attach-thumbwrap').length, 2, 'positive control: both staged')
  await first.unmount()
  const again = await deskView(t, project('website', [agent('dev1')]), { bare: true })
  const chip = again.el.querySelector('.attach-row .attach-chip')
  assert.ok(chip, 'the file is still staged after reopening')
  assert.match(chip!.textContent ?? '', /notes\.txt/)
  assert.match(chip!.textContent ?? '', /0 B/, 'with its size, as on the agent desk')
  assert.ok(again.el.querySelector('.attach-row .attach-thumbwrap img.attach-thumb'), 'the image as its thumbnail')
})

test('G10 a file dropped anywhere on the desk is attached, as on the agent desk', async (t) => {
  const calls = serve(t); forgetDrafts(t)
  const { el } = await deskView(t, project('website', [agent('dev1')]), { bare: true })
  const drop = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['z'], 'dropped.txt')], types: ['Files'] } })
  await inAct(async () => { el.querySelector('.project-description-md')!.dispatchEvent(drop); await flush(4) })
  assert.ok(calls.some((c) => c.startsWith('POST /api/orgs/org/nodes/website/upload')), calls.join('\n'))
  assert.match(el.querySelector('.attach-row')?.textContent ?? '', /dropped\.txt/)
  assert.equal(drop.defaultPrevented, true, 'the browser does not navigate to the file')
})

const docs = [{ id: 'p1', title: 'Release plan', at: '2026-10-19T09:00:00.000Z', node: 'website' },
  { id: 'p2', title: 'Budget', at: '2026-10-19T10:00:00.000Z', node: 'website' }]
const replyTo = async (el: Element, id: string) => {
  const card = el.querySelector<HTMLElement>(`.desk-docs [data-doc-id="${id}"]`)!
  await inAct(() => { card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })) })
  const reply = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu [role="menuitem"]')].find((b) => b.textContent?.trim() === 'Reply')!
  await inAct(async () => { reply.click(); await flush(2) })
}

test('G11 reply previews are the agent composer\'s: several targets, Cancel all, Escape, kept with the draft, all sent', async (t) => {
  const bodies: unknown[] = []
  serve(t)
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' && new URL(String(url), 'http://x').pathname === '/api/orgs/org/nodes/website/message') {
      bodies.push(JSON.parse(String(init.body)))
      return json({ accepted: true, id: 'm1', delivery: 'queued' })
    }
    return inner(url, init)
  }) as typeof fetch
  forgetDrafts(t)
  const node = project('website', [agent('dev1')], { documents: docs } as Partial<CanvasNode>)
  const first = await deskView(t, node, { bare: true, openDoc: noop })
  await replyTo(first.el, 'p1')
  assert.equal(first.el.querySelectorAll('.reply-preview.reply-preview-composing').length, 1, 'the shared reply preview')
  assert.match(first.el.querySelector('.reply-preview')!.textContent ?? '', /Release plan/)
  await replyTo(first.el, 'p2')
  assert.equal(first.el.querySelectorAll('.reply-preview.reply-preview-composing').length, 2, 'a second target joins the first')
  assert.ok([...first.el.querySelectorAll('button.link')].some((b) => b.textContent === 'Cancel all replies'))
  await inAct(() => { composerBox(first.el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  assert.equal(first.el.querySelectorAll('.reply-preview').length, 0, 'Escape cancels the prepared replies')
  await replyTo(first.el, 'p1'); await replyTo(first.el, 'p2')
  await first.unmount()
  const again = await deskView(t, node, { bare: true, openDoc: noop })
  assert.equal(again.el.querySelectorAll('.reply-preview.reply-preview-composing').length, 2, 'kept with the draft')
  await typeInto(composerBox(again.el), 'About both')
  await inAct(async () => { composerBox(again.el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await flush(4) })
  assert.deepEqual(bodies, [{ text: 'About both', targets: [{ kind: 'document', org: 'org', id: 'p1' }, { kind: 'document', org: 'org', id: 'p2' }] }])
  assert.equal(again.el.querySelectorAll('.reply-preview').length, 0, 'a sent reply clears its targets')
})

test('G12 the notice toggle survives closing the desk, and Alt+N / Alt+B work anywhere inside it', async (t) => {
  serve(t); forgetDrafts(t)
  const node = project('website', [agent('dev1')])
  const first = await deskView(t, node, { bare: true })
  await inAct(() => { first.el.querySelector<HTMLButtonElement>('.project-composer .cc-notice-toggle')!.click() })
  assert.equal(first.el.querySelector('.project-composer .cc-notice-toggle')!.classList.contains('armed'), true)
  await first.unmount()
  const again = await deskView(t, node, { bare: true })
  const toggle = () => again.el.querySelector('.project-composer .cc-notice-toggle')!
  assert.equal(toggle().classList.contains('armed'), true, 'still armed after reopening, as an agent desk\'s')
  const tab = again.el.querySelector<HTMLButtonElement>('.cc-tabs button[data-tab="inbox"]')!
  tab.focus()
  await inAct(() => { tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', altKey: true, bubbles: true, cancelable: true })) })
  assert.equal(toggle().classList.contains('armed'), false, 'Alt+N from a tab button toggles it')
  await inAct(() => { tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', altKey: true, bubbles: true, cancelable: true })) })
  assert.equal(again.el.querySelector('.cc-broadcast-toggle')!.getAttribute('aria-pressed'), 'true', 'and Alt+B the broadcast')
})
