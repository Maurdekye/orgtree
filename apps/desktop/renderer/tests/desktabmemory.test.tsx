// desktabmemory.test.tsx — EVERY DESK REOPENS WHERE IT WAS LEFT, and the
// desk's mailbox tab is called Mail (Orgtree 4.4.0; docket
// `desks-remember-their-last-tab-and-the-inbox-tab-i`, user 2026-10-20
// 06:22Z; coordinator-opus 06:33Z: the mailbox window's title and the agent
// menu's Open entry say Mail too).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 an agent desk reopens on the tab last picked on it, per organization
//      and node, from this origin's localStorage (so a restart keeps it); an
//      open desk keeps its own tab when another host of it picks; a
//      remembered Team tab without subordinates reopens on Chat, and a later
//      hire does not bring it back; an unknown value opens Chat;
//   §2 a project desk reopens on its last tab; a remembered tab it does not
//      offer opens Summary, and so does an open tab that goes away, which then
//      stays on Summary when the tab comes back; a host that switches
//      projects (the Attention panel) opens each on its own tab;
//   §3 the project desk's Mail tab reopens the folder last picked in its
//      folder strip, from the tab strip and on a revisit; a folder the mail
//      card opened is not a pick;
//   §4 the tab, its corner buttons, its window and the agent menu say Mail;
//      the folders inside stay inbox / sent / listeners.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs desktabmemory

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { ReactElement } from 'react'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { withoutMailTransfers } from './mailtransfers.fixture'
import { withReaderContent } from './readercontent.fixture'
import { DeskChat } from '../src/canvas/desk'
import { ProjectDesk, ProjectInboxModal } from '../src/canvas/projectdesk'
import { NodeInboxModal } from '../src/canvas/mail'
import { AgentSurfaceRoutesProvider } from '../src/canvas/panelcorner'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import type { MenuEntry, MenuItem } from '../src/canvas/contextmenu'
import { CurrentOrg } from '../src/popout'
import { resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload, Watchdog } from '../src/types'

const W = window as unknown as Window & typeof globalThis
if (!W.HTMLElement.prototype.scrollIntoView) W.HTMLElement.prototype.scrollIntoView = () => {}

const noop = () => {}
const op = async () => ({})
const refs = { world: { org: 'org' }, onOpen: noop } as never

const agent = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, title: id, generation: 1, state: 'live', tier: 'haiku', model_id: 'haiku', children: [], turns: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, ...extra,
} as unknown as CanvasNode)

const project = (id: string, extra: Record<string, unknown> = {}): CanvasNode => ({
  id, title: id, tier: 'project', kind: 'project', state: 'live', model_id: '', generation: 1,
  seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  // its event listeners are on, so its Listeners tab shows
  configured_scope: { tools: {}, add_dirs: [], event_listeners: true },
  parent: 'boss', charter: '', children: [], lineage: [], turns: [], audiences_held: [],
  mail_pending: 0, mail_held: 0, last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null, ...extra,
} as unknown as CanvasNode)

const populatedProject = (id: string) => project(id, { children: [agent(id+'-worker', {parent:id})] })

const dog = (kind: Watchdog['kind'], owner: string, name: string, target: string): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind, target, interval_s: 5, state: 'armed',
    at: '2026-10-20T06:00:00.000Z', fired: 0, once: false, spent: false } as Watchdog)

/** an event listener and a mail listener on each project of these tests */
const dogs = ['sync', 'pool', 'dl', 'alpha', 'beta'].flatMap((p) => [
  dog('project_listener', 'sa', 'ready-' + p, p), dog('fair_queue', 'sa', 'mail-' + p, p)])

const treeOf = (...roots: CanvasNode[]) =>
  ({ slug: 'org', roots, watchdogs: dogs, slot_leases: [] } as unknown as TreePayload)
const mapOf = (...nodes: CanvasNode[]) => new Map(nodes.map((n) => [n.id, n]))

/** the engine, with every mailbox empty */
function serve(t: TestContext, readerContent = false) {
  localStorage.clear(); resetConvos()
  const had = globalThis.fetch
  installFetch(new FakeServer())
  const inner = readerContent ? withReaderContent(globalThis.fetch,[{id:'writer'},{id:'other'},
    ...['sync','alpha','beta'].map(id=>({id,members:[id+'-worker']}))]) : globalThis.fetch
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body),
    { status: 200, headers: { 'Content-Type': 'application/json' } }))
  globalThis.fetch = withoutMailTransfers(((url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://x').pathname
    if (path === '/api/app-settings/runtime') return json({ working_checkups_enabled: true })
    if (/^\/api\/orgs\/[^/]+\/nodes\/[^/]+\/inbox$/.test(path)) return json({ pending: [], delivered: [], sent: [] })
    return inner(url, init)
  }) as typeof fetch)
  const open: { unmount: () => Promise<void> }[] = []
  t.after(async () => {
    for (const v of open.splice(0)) await v.unmount()
    globalThis.fetch = had; resetConvos(); localStorage.clear()
  })
  /** mount a desk; `close()` unmounts it (a revisit is a fresh mount) */
  const mount = async (element: ReactElement) => {
    const view = await mountView(element, (el) => el)
    let closed = false
    const close = async () => { if (!closed) { closed = true; await view.unmount() } }
    open.push({ unmount: close })
    await inAct(async () => { await flush(5) })
    return { ...view, close }
  }
  return { mount }
}

const agentDesk = (node: CanvasNode, map = mapOf(node), slug = 'org') =>
  <DeskChat node={node} map={map} slug={slug} bare op={op} toast={noop} />
const projectDesk = (node: CanvasNode, map = mapOf(node), tree = treeOf(node)) =>
  <ProjectDesk node={node} slug="org" tree={tree} map={map} op={op} toast={noop} refs={refs} />

const on = (el: Element) => el.querySelector('.cc-tabs button.on')?.getAttribute('data-tab') ?? null
const offered = (el: Element) => [...el.querySelectorAll('.cc-tabs button')].map((b) => b.getAttribute('data-tab'))
const labels = (el: Element) => [...el.querySelectorAll('.cc-tabs button')]
  .map((b) => (b.textContent ?? '').replace(/\s+\d+$/, '').trim())
const pick = (el: Element, tab: string) => inAct(async () => {
  const button = el.querySelector<HTMLButtonElement>(`.cc-tabs button[data-tab="${tab}"]`)
  assert.ok(button, `fixture: the desk offers the ${tab} tab`)
  button!.click(); await flush(4)
})
const openFolder = (el: Element) => (el.querySelector('.mail-folders > button.on')?.textContent ?? '').replace(/\s+\d+$/, '').trim()
const folders = (el: Element) => [...el.querySelectorAll('.mail-folders > button')]
  .map((b) => (b.textContent ?? '').replace(/\s+\d+$/, '').trim())
const pickFolder = (el: Element, name: string) => inAct(async () => {
  const button = [...el.querySelectorAll<HTMLButtonElement>('.mail-folders > button')]
    .find((b) => (b.textContent ?? '').trim().startsWith(name))
  assert.ok(button, `fixture: the Mail tab offers the ${name} folder`)
  button!.click(); await flush(4)
})

/* ─── §1 the agent desk ──────────────────────────────────────────────────── */

test('§1a an agent desk reopens on the tab last picked on it', async (t) => {
  const { mount } = serve(t, true)
  const writer = agent('writer')
  let desk = await mount(agentDesk(writer))
  assert.equal(on(desk.el), 'chat', 'a desk never visited opens on Chat')
  await pick(desk.el, 'docket')
  await desk.close()
  desk = await mount(agentDesk(writer))
  assert.equal(on(desk.el), 'docket', 'the revisit reopens the Docket tab')
  await pick(desk.el, 'inbox')
  await desk.close()
  desk = await mount(agentDesk(writer))
  assert.equal(on(desk.el), 'inbox', 'and then the Mail tab')
  assert.ok(desk.el.querySelector('.mail-folders'), 'showing the mailbox')
  await pick(desk.el, 'chat')
  await desk.close()
  desk = await mount(agentDesk(writer))
  assert.equal(on(desk.el), 'chat', 'picking Chat again is remembered as well')
})

test('§1b the memory is per organization and per node', async (t) => {
  const { mount } = serve(t, true)
  const writer = agent('writer'), other = agent('other')
  let desk = await mount(agentDesk(writer, mapOf(writer, other)))
  await pick(desk.el, 'presented')
  await desk.close()
  desk = await mount(agentDesk(other, mapOf(writer, other)))
  assert.equal(on(desk.el), 'chat', "another agent's desk opens on its own tab")
  await desk.close()
  desk = await mount(agentDesk(writer, mapOf(writer, other), 'elsewhere'))
  assert.equal(on(desk.el), 'chat', 'an agent of the same name in another organization too')
  await desk.close()
  desk = await mount(agentDesk(writer, mapOf(writer, other)))
  assert.equal(on(desk.el), 'presented', "and writer's own desk still reopens on Presented")
})

test('§1c an open desk keeps its own tab when another host of it picks; the next opening takes the last pick', async (t) => {
  const { mount } = serve(t, true)
  const writer = agent('writer')
  const both = await mount(<>
    <div data-host="a">{agentDesk(writer)}</div>
    <div data-host="b">{agentDesk(writer)}</div>
  </>)
  const a = both.el.querySelector<HTMLElement>('[data-host="a"]')!, b = both.el.querySelector<HTMLElement>('[data-host="b"]')!
  await pick(a, 'docket')
  assert.equal(on(a), 'docket')
  assert.equal(on(b), 'chat', 'the other host stays where it was')
  await pick(b, 'presented')
  assert.equal(on(a), 'docket', 'and so does the first')
  await both.close()
  const desk = await mount(agentDesk(writer))
  assert.equal(on(desk.el), 'presented', 'the last pick on any host is the one remembered')
})

test('§1d a remembered Team tab without subordinates reopens on Chat, and a later hire does not bring it back', async (t) => {
  const { mount } = serve(t)
  const kid = agent('kid', { parent: 'boss' } as Partial<CanvasNode>)
  const boss = agent('boss', { children: [kid] })
  const alone = agent('boss')
  let desk = await mount(agentDesk(boss, mapOf(boss, kid)))
  await pick(desk.el, 'team')
  await desk.close()
  desk = await mount(agentDesk(boss, mapOf(boss, kid)))
  assert.equal(on(desk.el), 'team', 'positive control: a remembered Team tab reopens while it is offered')
  await desk.close()
  desk = await mount(agentDesk(alone, mapOf(alone)))
  assert.equal(offered(desk.el).includes('team'), false, 'fixture: no subordinates, no Team tab')
  assert.equal(on(desk.el), 'chat', 'without subordinates the desk opens on Chat')
  assert.ok(desk.el.querySelector('.msgs-wrap'), 'showing the conversation, not an empty panel')
  await desk.close()
  desk = await mount(agentDesk(boss, mapOf(boss, kid)))
  assert.equal(on(desk.el), 'chat', 'a later hire does not reopen Team (agent-desk glossary rule)')
})

test('§1e the memory is kept in localStorage, so a restart keeps it; an unknown value opens Chat', async (t) => {
  const { mount } = serve(t, true)
  const writer = agent('writer')
  let desk = await mount(agentDesk(writer))
  await pick(desk.el, 'docket')
  await desk.close()
  const stored = JSON.parse(localStorage.getItem('orgtree-desk-tabs:org') ?? 'null') as Record<string, { tab?: string }> | null
  assert.equal(stored?.writer?.tab, 'docket', "the pick is in the origin's storage, keyed by organization")
  for (const bad of ['{"writer":{"tab":"bogus"}}', 'not json', '["docket"]', '{"writer":"docket"}']) {
    localStorage.setItem('orgtree-desk-tabs:org', bad)
    desk = await mount(agentDesk(writer))
    assert.equal(on(desk.el), 'chat', `stored ${bad} opens Chat`)
    await desk.close()
  }
  localStorage.setItem('orgtree-desk-tabs:org', '{"writer":{"tab":"presented"}}')
  desk = await mount(agentDesk(writer))
  assert.equal(on(desk.el), 'presented', 'a stored tab from an earlier session reopens')
})

/* ─── §2 the project desk ────────────────────────────────────────────────── */

test('§2a a project desk reopens on the tab last picked on it', async (t) => {
  const { mount } = serve(t, true)
  const sync = populatedProject('sync')
  let desk = await mount(projectDesk(sync))
  assert.equal(on(desk.el), 'desk', 'a project desk never visited opens on Summary')
  for (const tab of ['docket', 'listeners', 'inbox', 'presented', 'desk']) {
    await pick(desk.el, tab)
    await desk.close()
    desk = await mount(projectDesk(sync))
    assert.equal(on(desk.el), tab, `the revisit reopens ${tab}`)
  }
})

test('§2b a remembered tab the project desk does not offer opens Summary, which it keeps when the tab comes back', async (t) => {
  const { mount } = serve(t)
  const pool = (slots: number) => project('pool', { configured_scope: { tools: {}, add_dirs: [], slots_capacity: slots } })
  let desk = await mount(projectDesk(pool(2)))
  await pick(desk.el, 'slots')
  await desk.close()
  desk = await mount(projectDesk(pool(2)))
  assert.equal(on(desk.el), 'slots', 'positive control: the remembered Slots tab reopens while it is offered')
  await desk.close()
  desk = await mount(projectDesk(pool(0)))
  assert.equal(offered(desk.el).includes('slots'), false, 'fixture: no slot count, no Slots tab')
  assert.equal(on(desk.el), 'desk', 'it opens on Summary')
  assert.ok(desk.el.querySelector('.project-description-md, .project-description-edit'), 'showing the summary, not an empty panel')
  await desk.render(projectDesk(pool(2))); await inAct(() => flush(4))
  assert.equal(offered(desk.el).includes('slots'), true, 'fixture: the Slots tab is back')
  assert.equal(on(desk.el), 'desk', 'the open desk stays on Summary')
  await desk.close()
  desk = await mount(projectDesk(pool(2)))
  assert.equal(on(desk.el), 'desk', 'and the next opening is Summary too')
})

test('§2c an open tab that goes away gives way to Summary, which the desk keeps when the tab comes back', async (t) => {
  const { mount } = serve(t)
  const dl = (n: number) => project('dl', { dead_letters: n })
  const desk = await mount(projectDesk(dl(2)))
  await pick(desk.el, 'dead')
  await desk.render(projectDesk(dl(0))); await inAct(() => flush(4))
  assert.equal(offered(desk.el).includes('dead'), false, 'fixture: the last dead letter cleared')
  assert.equal(on(desk.el), 'desk', 'the desk shows Summary')
  await desk.render(projectDesk(dl(1))); await inAct(() => flush(4))
  assert.equal(offered(desk.el).includes('dead'), true, 'fixture: a new dead letter')
  assert.equal(on(desk.el), 'desk', 'the Dead letters tab coming back does not take the desk over')
})

test('§2d a host that switches projects opens each on its own remembered tab (the Attention panel)', async (t) => {
  const { mount } = serve(t, true)
  const alpha = populatedProject('alpha'), beta = populatedProject('beta')
  const map = mapOf(alpha, beta), tree = treeOf(alpha, beta)
  const desk = await mount(projectDesk(alpha, map, tree))
  await pick(desk.el, 'docket')
  await desk.render(projectDesk(beta, map, tree)); await inAct(() => flush(4))
  assert.equal(on(desk.el), 'desk', 'beta was never visited: Summary, not alpha\'s Docket')
  await pick(desk.el, 'presented')
  await desk.render(projectDesk(alpha, map, tree)); await inAct(() => flush(4))
  assert.equal(on(desk.el), 'docket', 'back on alpha: its own Docket')
  await desk.render(projectDesk(beta, map, tree)); await inAct(() => flush(4))
  assert.equal(on(desk.el), 'presented', 'and beta its Presented')
})

/* ─── §3 the project desk's Mail folders ─────────────────────────────────── */

test('§3a the Mail tab reopens the folder last picked in its folder strip, from the tab strip and on a revisit', async (t) => {
  const { mount } = serve(t, true)
  const sync = populatedProject('sync')
  let desk = await mount(projectDesk(sync))
  await pick(desk.el, 'inbox')
  assert.equal(openFolder(desk.el), 'inbox', 'a Mail tab never visited opens its inbox folder')
  await pickFolder(desk.el, 'listeners')
  await pick(desk.el, 'desk')
  await pick(desk.el, 'inbox')
  assert.equal(openFolder(desk.el), 'listeners', 'the Mail tab reopens on Listeners')
  await desk.close()
  desk = await mount(projectDesk(sync))
  assert.equal(on(desk.el), 'inbox', 'the revisit reopens the Mail tab')
  assert.equal(openFolder(desk.el), 'listeners', 'on its Listeners folder')
  await pickFolder(desk.el, 'sent')
  await pick(desk.el, 'docket')
  await pick(desk.el, 'inbox')
  assert.equal(openFolder(desk.el), 'sent', 'then on Sent')
  await pickFolder(desk.el, 'inbox')
  await desk.close()
  desk = await mount(projectDesk(sync))
  assert.equal(openFolder(desk.el), 'inbox', 'and back on the inbox folder once that is picked')
})

test('§3b a folder the mail card opens is not a pick: the tab strip reopens the last picked one', async (t) => {
  const { mount } = serve(t)
  const sync = project('sync', { mail_pending: 3 })
  const desk = await mount(projectDesk(sync))
  await pick(desk.el, 'inbox')
  await pickFolder(desk.el, 'sent')
  await inAct(async () => { desk.el.querySelector<HTMLButtonElement>('.project-queue-card')!.click(); await flush(6) })
  assert.equal(openFolder(desk.el), 'listeners', 'fixture: the card opens the mail listeners')
  await pick(desk.el, 'desk')
  await pick(desk.el, 'inbox')
  assert.equal(openFolder(desk.el), 'sent', 'the tab strip reopens Sent, the folder last picked')
})

/* ─── §4 the name ────────────────────────────────────────────────────────── */

test('§4a the agent desk\'s mailbox tab is called Mail; its route and folders are unchanged', async (t) => {
  const { mount } = serve(t)
  const writer = agent('writer', { mail_pending: 2 })
  const desk = await mount(agentDesk(writer))
  assert.deepEqual(labels(desk.el), ['chat', 'mail'], 'empty readers are not offered')
  assert.deepEqual(offered(desk.el), ['chat', 'inbox'], 'the visible tab ids (routes, pins) stay')
  assert.equal(desk.el.querySelector('.cc-tabs button[data-tab="inbox"] .tab-count')?.textContent, '2', 'with its count')
  await pick(desk.el, 'inbox')
  assert.deepEqual(folders(desk.el), ['inbox', 'sent'], 'the folders inside keep their names')
})

test('§4b the project desk\'s mailbox tab is called Mail; its folders are unchanged', async (t) => {
  const { mount } = serve(t)
  const desk = await mount(projectDesk(project('sync')))
  const tabs = labels(desk.el)
  assert.deepEqual(tabs, ['summary', 'mail', 'events'], 'empty readers are not offered; the enabled event listener remains')
  assert.equal(tabs.includes('inbox'), false, 'no tab says inbox')
  assert.equal(offered(desk.el)[1], 'inbox', 'the tab id stays')
  await pick(desk.el, 'inbox')
  assert.deepEqual(folders(desk.el), ['inbox', 'sent', 'listeners'])
})

test('§4c the Mail tab\'s corner buttons name it mail', async (t) => {
  const { mount } = serve(t)
  const writer = agent('writer')
  const routes = { open: noop, show: noop }
  const desk = await mount(<AgentSurfaceRoutesProvider value={routes}>{agentDesk(writer)}</AgentSurfaceRoutesProvider>)
  await pick(desk.el, 'inbox')
  const corner = desk.el.querySelector('.desk-tabpanel .panel-corner')
  assert.ok(corner, 'fixture: the tab has its corner')
  assert.equal(corner!.getAttribute('aria-label'), 'mail window actions')
  const named = [...corner!.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '')
  assert.equal(named.includes("open writer's mail as a standalone modal"), true, named.join(' | '))
  assert.equal(named.some((n) => /inbox/.test(n)), false, 'no corner button says inbox')
})

test('§4d the mailbox window is titled "· mail", for an agent and a project', async (t) => {
  serve(t)
  const writer = agent('writer'), sync = project('sync')
  for (const [name, element] of [
    ['agent', <NodeInboxModal slug="org" node={writer} toast={noop} close={noop} onFocusAgent={noop} />],
    ['project', <ProjectInboxModal node={sync} slug="org" tree={treeOf(sync)} map={mapOf(sync)} op={op} toast={noop} close={noop} />],
  ] as const) {
    const view = await mountView(<CurrentOrg.Provider value="org">{element}</CurrentOrg.Provider>, (el) => el)
    try {
      await inAct(async () => { await flush(6) })
      const heads = [...document.querySelectorAll('h3')].map((h) => (h.textContent ?? '').replace(/\s+/g, ' ').trim())
      assert.equal(heads.some((h) => /· mail$/.test(h)), true, `${name}: ${heads.join(' | ')}`)
      assert.equal(heads.some((h) => /· inbox/.test(h)), false, `${name}: the window no longer says inbox`)
      const titled = [...document.querySelectorAll('[title], [aria-label]')]
        .map((e) => (e.getAttribute('title') ?? '') + ' ' + (e.getAttribute('aria-label') ?? ''))
      assert.equal(titled.some((s) => /· inbox/.test(s)), false, `${name}: nor does its frame`)
    } finally { await view.unmount() }
  }
})

test('§4e the agent menu opens the mailbox as Open → Mail; a project keeps Project mailbox', () => {
  const all = (entries: MenuEntry[]): MenuItem[] => entries.flatMap((e) => e === 'sep' ? [] : [e, ...all(e.children ?? [])])
  let opened = 0
  const handlers = { onInbox: () => { opened++ }, onSettings: noop }
  const items = all(agentMenuEntries(agent('writer'), handlers))
  const open = items.find((e) => e.label === 'Open')
  assert.ok(open, 'fixture: the agent menu has its Open submenu')
  const labelsOf = (open!.children ?? []).flatMap((e) => e === 'sep' ? [] : [e.label])
  assert.equal(labelsOf.includes('Mail'), true, labelsOf.join(', '))
  assert.equal(labelsOf.includes('Inbox'), false)
  ;(open!.children ?? []).flatMap((e) => e === 'sep' ? [] : [e]).find((e) => e.label === 'Mail')?.onSelect()
  assert.equal(opened, 1, 'it opens the mailbox, as before')
  const projectItems = all(agentMenuEntries(project('sync'), handlers)).map((e) => e.label)
  assert.equal(projectItems.includes('Project mailbox'), true, 'the project menu keeps its own wording')
})
