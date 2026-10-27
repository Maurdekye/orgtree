// tests/ticketmention.test.tsx — docket mention-entry-on-ticket-cards-in-transcripts-ins.
// USER 2026-10-21 19:12:54Z + 2026-10-22 18:15:39Z: a "Mention" entry in the shared ticket context menu, on every ticket
// card and chip, inserts the ticket's reference into the message box. USER 2026-10-22 18:16:44Z: the composer's
// @-mention tab-completion list offers tickets alongside agents and projects. Both insert @item:<org>/<slug>.
// Each test uses its own org slug: the completion's ticket answers are cached per org and query.
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CurrentOrg } from '../src/popout'
import { DocketRow } from '../src/canvas/docket'
import { WorkRefText, buildMentionIndex } from '../src/canvas/workrefs'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import { ToolRefs } from '../src/canvas/toolrefs'
import { IdleDocketCards } from '../src/events/idledocket'
import { useAgentMentions, useDeskMentionScope } from '../src/canvas/agentmentions'
import { QuickChat } from '../src/QuickChatBox'
import { legacyAppBackend } from './appfeed-fixture'
import { DeskChat } from '../src/canvas/desk'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { refreshConvo, resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, TreePayload, WorkItem } from '../src/types'

const ticket = (slug: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  slug, title: `Title of ${slug}`, rev: 1, kind: 'code', objective: 'Scope text',
  status: 'open', archived: false, owner: { node: 'owner', generation: 1 }, owner_current: true, owner_state: 'live',
  reviewer: null, participants: [], at: '2026-10-22T10:00:00Z', updated_at: '2026-10-22T10:01:00Z',
  docket_at: '2026-10-22T10:01:00Z', done_so_far: [], working_on_next: [], effective_attention: false,
  attention_sources: [], acceptance: [], dismissals: [], questions: [], dependencies: [], evidence: [],
  delivery: null, history: [], ...extra,
} as unknown as WorkItem)

const top = () => document.querySelector<HTMLElement>('.ctxmenu:not(.ctxmenu-submenu)')
const itemsOf = (root: Element) => [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  .filter(b => b.closest('[role="menu"]') === root)
const labels = (root: Element | null = top()) => root ? itemsOf(root).map(b => (b.textContent ?? '').replace('▸', '').trim()) : []
async function rightClick(el: Element) {
  await inAct(async () => {
    el.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 2 }))
    el.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 }))
    el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40 }))
    await flush(6)
  })
  // the object menu resolves the ticket asynchronously; let it land
  await inAct(async () => { await flush(8) })
}
async function choose(label: string, root: Element | null = top()) {
  const button = root ? itemsOf(root).find(b => (b.textContent ?? '').replace('▸', '').trim() === label) : undefined
  assert.ok(button, `"${label}" in ${JSON.stringify(labels(root))}`)
  await inAct(async () => {
    button!.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
    button!.click()
    await flush(4)
  })
}
async function escape() {
  await inAct(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flush(2)
  })
}
async function fill(box: HTMLTextAreaElement, value: string, caret?: number) {
  await inAct(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, value)
    box.dispatchEvent(new window.Event('input', { bubbles: true }))
    if (caret === undefined) box.blur()
    else {
      box.focus()
      box.setSelectionRange(caret, caret)
      box.dispatchEvent(new window.Event('select', { bubbles: true }))
    }
    await flush(3)
  })
}
/** type into a composer with the caret at the end, then let the completion's reads land */
async function typeInto(box: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await inAct(async () => {
    const proto = box instanceof window.HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(box, value)
    box.dispatchEvent(new window.Event('input', { bubbles: true }))
    box.focus()
    box.setSelectionRange(value.length, value.length)
    box.dispatchEvent(new window.Event('select', { bubbles: true }))
    await flush(6)
  })
  await inAct(async () => { await flush(10) })
}
async function press(box: Element, key: string) {
  await inAct(async () => {
    box.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await flush(4)
  })
}
const rows = () => [...document.querySelectorAll<HTMLElement>('.agent-mentions .agent-mention-item')]
const rowNames = () => rows().map(r => r.querySelector('.agent-mention-name')?.textContent ?? '')
const ticketRows = () => rows().filter(r => r.classList.contains('mention-ticket'))
  .map(r => r.querySelector('.agent-mention-name')?.textContent ?? '')

function AgentMenus() {
  useProvideAgentNav(name => [{ label: 'Focus', onSelect: () => {} }, { label: `Agent action ${name}`, onSelect: () => {} }])
  return null
}

/** A desk composer as the agent and project desks wire it: the box, its @-completion and the desk's mention scope. */
function Composer({ children }: { children: ReactNode }) {
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement | null>(null)
  const mentions = useAgentMentions({ value: text, onChange: setText, inputRef: box, candidates: [] })
  const scope = useDeskMentionScope(mentions.captureMention, mentions.noteRightClickDown)
  return <div className="fake-desk" {...scope}>
    <textarea className="fake-composer" ref={box} value={text} onChange={e => setText(e.target.value)} />
    {children}{mentions.menu}
  </div>
}

/** Every ticket link surface the shared menu serves: a typed-reference chip, a slug in prose, a tool-call ticket chip,
 *  an idle-docket reminder's ticket card and a docket row. */
function TicketSurfaces({ org, item }: { org: string; item: WorkItem }) {
  const reminder = { v: 1, variant: 'reminder.idle_docket', engine_authored: true, more: 0,
    items: [{ slug: item.slug, title: item.title, status: item.status, role: 'owner' }] } as never
  return <div className="surfaces">
    <RefChip r={resolveRef({ kind: 'item', org, id: item.slug }, { org })} onOpen={() => {}} />
    <IdleDocketCards event={reminder} org={org} onOpen={() => {}} />
    <span className="prose"><WorkRefText text={`see ${item.slug} today`} index={buildMentionIndex([item])} onPick={() => {}} /></span>
    <ToolRefs refs={[{ kind: 'ticket', id: item.slug }]} owner="worker" org={org} onWorkLink={() => {}} agent={id => <span>{id}</span>} />
    <DocketRow org={org} item={item} selected={false} ageTick={0} facts={new Map()} toast={() => {}} onClick={() => {}}
      onDismiss={() => {}} onFocusAgent={() => {}} kids={0} folded={false} onFold={() => {}} />
  </div>
}

async function surfaceFixture(t: TestContext, org: string, item: WorkItem) {
  const original = globalThis.fetch
  const posts: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if ((init?.method ?? 'GET') !== 'GET') posts.push(url)
    const body = url.includes('/work-item-references')
      ? { references: [{ slug: item.slug, title: item.title, parent: null, archived: false, status: item.status, rev: 1 }] }
      : url.includes('/work-items/') ? { item } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const view = await mountView(
    <CurrentOrg.Provider value={org}><AgentNavProvider><ObjectNavProvider><AgentMenus />
      <ObjectNavHost org={org} dogs={[]} openDog={() => {}} openTicket={() => {}} toast={() => {}} />
      <ObjectMenuBoundary>
        <Composer><div className="inside"><TicketSurfaces org={org} item={item} /></div></Composer>
        <div className="outside"><TicketSurfaces org={org} item={item} /></div>
      </ObjectMenuBoundary>
    </ObjectNavProvider></AgentNavProvider></CurrentOrg.Provider>, el => el)
  await inAct(async () => { await flush(8) })
  t.after(async () => { await view.unmount(); globalThis.fetch = original })
  const box = view.el.querySelector<HTMLTextAreaElement>('.fake-composer')!
  const surface = (where: 'inside' | 'outside', kind: string): HTMLElement => {
    const selector = kind === 'chip' ? '.ref-chip.ref-item' : kind === 'prose' ? '.docket-ref'
      : kind === 'tool' ? '.tool-ref .ref-chip.ref-item' : kind === 'card' ? '.idle-ticket button.ref-chip' : '.docket-row'
    const el = view.el.querySelector<HTMLElement>(`.${where} ${selector}`)
    assert.ok(el, `${where} ${kind} surface rendered (${selector})`)
    return el!
  }
  return { view, box, surface, posts }
}

const SURFACES = ['chip', 'prose', 'tool', 'card', 'row'] as const

test('inside a desk, every ticket chip, card and docket row offers Mention first; it inserts @item:<org>/<slug> into the message box without sending', async t => {
  const org = 'tm-surfaces'
  const item = ticket('parity-ticket')
  const f = await surfaceFixture(t, org, item)
  for (const kind of SURFACES) {
    await fill(f.box, '')
    assert.notEqual(document.activeElement, f.box, `precondition (${kind}): the message box is unfocused`)
    await rightClick(f.surface('inside', kind))
    const menu = labels()
    assert.equal(menu[0], 'Mention', `${kind}: Mention is first inside a desk (${JSON.stringify(menu)})`)
    assert.equal(menu[1], 'Open details', `${kind}: the shared ticket actions follow unchanged (${JSON.stringify(menu)})`)
    assert.equal(menu.filter(label => label === 'Mention').length, 1, `${kind}: one Mention entry`)
    await choose('Mention')
    assert.equal(f.box.value, '@item:tm-surfaces/parity-ticket ', `${kind}: Mention inserts the ticket reference`)
    assert.equal(document.activeElement === f.box, true, `${kind}: Mention focuses the message box`)
    assert.equal(f.box.selectionStart, '@item:tm-surfaces/parity-ticket '.length, `${kind}: caret after the reference`)
    assert.equal(top(), null, `${kind}: the menu closes`)
  }
  // an unfocused box with text gets the reference appended after a space
  await fill(f.box, 'Please look at')
  await rightClick(f.surface('inside', 'chip'))
  await choose('Mention')
  assert.equal(f.box.value, 'Please look at @item:tm-surfaces/parity-ticket ')
  assert.deepEqual(f.posts, [], 'Mention never sends or writes anything')
})

test('outside a desk composer the same ticket surfaces keep their menus without Mention (control)', async t => {
  const org = 'tm-outside'
  const f = await surfaceFixture(t, org, ticket('outside-ticket'))
  for (const kind of SURFACES) {
    await rightClick(f.surface('outside', kind))
    const menu = labels()
    assert.equal(menu[0], 'Open details', `${kind}: outside a desk the menu starts with Open details (${JSON.stringify(menu)})`)
    assert.equal(menu.includes('Mention'), false, `${kind}: no Mention without a composer`)
    await escape()
  }
})

test('a focused message box gets the ticket reference at its caret, and the Owner submenu Mention still lands at the caret too', async t => {
  const org = 'tm-caret'
  const f = await surfaceFixture(t, org, ticket('caret-ticket'))
  await fill(f.box, 'Hello world', 6)
  assert.equal(document.activeElement === f.box, true, 'precondition: the box is focused')
  await rightClick(f.surface('inside', 'chip'))
  await choose('Mention')
  assert.equal(f.box.value, 'Hello @item:tm-caret/caret-ticket world')
  assert.equal(f.box.selectionStart, 'Hello @item:tm-caret/caret-ticket '.length)
  // one right-click captures the caret for the ticket AND for its Owner… submenu's own Mention, which the
  // chip's menu builds only after the ticket has loaded, when the open menu already holds the focus
  await fill(f.box, 'Ask now', 4)
  await rightClick(f.surface('inside', 'chip'))
  const owner = itemsOf(top()!).find(b => (b.textContent ?? '').startsWith('Owner…'))
  assert.ok(owner, `Owner… submenu exists (${JSON.stringify(labels())})`)
  await inAct(async () => {
    owner!.closest('.ctxmenu-branch')!.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await flush(3)
  })
  const submenu = document.querySelector<HTMLElement>('.ctxmenu-submenu')
  assert.ok(submenu, 'owner submenu opened')
  assert.equal(labels(submenu)[0], 'Mention', `the owner's own Mention stays first (${JSON.stringify(labels(submenu))})`)
  await choose('Mention', submenu)
  assert.equal(f.box.value, 'Ask @owner now', "the owner's Mention inserts @owner at the caret")
})

// ---------------------------------------------------------------- the real desks

const mkNode = (id: string, tier = 'sol', kind?: string, children: CanvasNode[] = []): CanvasNode => ({
  id, title: id, generation: 1, state: 'live', tier, kind, children, seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
} as unknown as CanvasNode)

test('the agent desk: its transcript ticket chip and its Docket tab row offer Mention into that desk\'s message box', async t => {
  localStorage.clear(); resetConvos()
  const org = 'tm-desk'
  const alpha = mkNode('worker-alpha')
  const server = new FakeServer()
  server.messages = [{ role: 'assistant', text: 'Tracked in @item:tm-desk/desk-ticket for now.', seq: 0, event_id: 'r-1' }]
  server.workItems = [ticket('desk-ticket', { owner: { node: 'worker-alpha', generation: 1 } as never })]
  const previous = globalThis.fetch
  installFetch(server)
  t.after(() => { globalThis.fetch = previous; resetConvos() })
  const map = new Map<string, CanvasNode>([[alpha.id, alpha]])
  const v = await mountView(
    <AgentNavProvider><ObjectNavProvider><AgentMenus />
      <ObjectNavHost org={org} dogs={[]} openDog={() => {}} openTicket={() => {}} toast={() => {}} />
      <ObjectMenuBoundary>
        <DeskChat node={alpha} map={map} slug={org} op={async () => ({})} toast={() => {}} bare
          onJump={() => {}} onWorkLink={() => {}} onOpenDoc={() => {}} onMailLink={() => {}} />
      </ObjectMenuBoundary>
    </ObjectNavProvider></AgentNavProvider>, h => h)
  t.after(async () => { await v.unmount() })
  await inAct(async () => { await refreshConvo(org, 'worker-alpha'); await flush(8) })
  const desk = v.el.querySelector<HTMLElement>('fieldset.desk-control-scope')!
  const box = desk.querySelector<HTMLTextAreaElement>('textarea')!
  assert.ok(desk && box, 'agent desk and its message box rendered')

  const chip = desk.querySelector<HTMLElement>('[data-transcript-row] [data-object-nav="ticket"]')
  assert.ok(chip, 'the transcript drew the ticket reference as a ticket chip')
  await fill(box, '')
  await rightClick(chip!)
  assert.deepEqual(labels().slice(0, 3), ['Mention', 'Reply', 'Open details'], `transcript chip menu: ${JSON.stringify(labels())}`)
  await choose('Mention')
  assert.equal(box.value, '@item:tm-desk/desk-ticket ')
  assert.equal(document.activeElement === box, true)

  const tab = desk.querySelector<HTMLButtonElement>('.cc-tabs button[data-tab="docket"]')!
  await inAct(async () => { tab.click(); await flush(8) })
  await inAct(async () => { await flush(8) })
  const row = desk.querySelector<HTMLElement>('.desk-tabpanel .docket-row')
  assert.ok(row, 'the Docket tab drew the ticket row')
  await fill(box, '')
  await rightClick(row!)
  assert.deepEqual(labels().slice(0, 3), ['Mention', 'Reply', 'Open details'], `docket tab row menu: ${JSON.stringify(labels())}`)
  await choose('Mention')
  assert.equal(box.value, '@item:tm-desk/desk-ticket ')
})

test('the agent desk @-completion offers current and backlogged tickets, newest first among agents; Tab inserts @item:<org>/<slug>', async t => {
  localStorage.clear(); resetConvos()
  const org = 'tm-complete'
  const alpha = mkNode('worker-alpha'), beta = mkNode('worker-beta', 'haiku')
  const server = new FakeServer()
  server.messages = [{ role: 'assistant', text: 'Hello.', seq: 0, event_id: 'r-1' }]
  // the parity ticket changed last (the engine's read ranks by the latest change or mention)
  server.workItems = [ticket('parity-ticket', { title: 'Composer completes tickets', docket_at: '2026-10-22T10:05:00Z' }), ticket('worker-guide')]
  server.workBacklogged = [ticket('parity-backlog', { status: 'backlogged' })]
  server.workArchived = [ticket('parity-archived', { status: 'done', archived: true })]
  const previous = globalThis.fetch
  installFetch(server)
  t.after(() => { globalThis.fetch = previous; resetConvos() })
  const map = new Map<string, CanvasNode>([[alpha.id, alpha], [beta.id, beta]])
  const v = await mountView(
    <AgentNavProvider><ObjectMenuBoundary>
      <DeskChat node={alpha} map={map} slug={org} op={async () => ({})} toast={() => {}} bare onJump={() => {}} />
    </ObjectMenuBoundary></AgentNavProvider>, h => h)
  t.after(async () => { await v.unmount() })
  await inAct(async () => { await refreshConvo(org, 'worker-alpha'); await flush(8) })
  const box = v.el.querySelector<HTMLTextAreaElement>('fieldset.desk-control-scope textarea')!
  assert.ok(box, 'desk message box rendered')

  await typeInto(box, 'Ask @parity')
  assert.ok(document.querySelector('.agent-mentions'), 'the @ list opened')
  assert.deepEqual(ticketRows().sort(), ['parity-backlog', 'parity-ticket'], `current and backlogged tickets, never archived (${JSON.stringify(rowNames())})`)
  const row = rows().find(r => r.querySelector('.agent-mention-name')?.textContent === 'parity-ticket')!
  assert.equal(row.getAttribute('data-object-tooltip-kind'), 'ticket', 'a ticket row hovers with the shared ticket identity')
  assert.equal(row.getAttribute('data-object-tooltip-id'), 'parity-ticket')
  assert.equal(row.getAttribute('data-object-tooltip-org'), org)
  assert.equal(rowNames().at(-1), 'parity-ticket', 'the most recently updated current ticket sits nearest the box')
  await press(box, 'Tab')
  assert.equal(box.value, 'Ask @item:tm-complete/parity-ticket ', 'Tab inserts the ticket reference')
  assert.equal(document.querySelector('.agent-mentions'), null, 'the list closes on completion')

  // a title word finds the ticket too
  await typeInto(box, 'Ask @composer')
  assert.deepEqual(ticketRows(), ['parity-ticket'], 'title words match')

  // newest first across kinds (USER 2026-10-27 m79e889ce1609): a ticket changed on Oct 22 comes before
  // agents with no known activity, which follow by name; drawn bottom-up, the best sits nearest the box
  await typeInto(box, 'Ask @worker-')
  assert.deepEqual(rowNames(), ['@worker-beta', '@worker-alpha', 'worker-guide'], `newest first, then by name (${JSON.stringify(rowNames())})`)
  await press(box, 'Tab')
  assert.equal(box.value, 'Ask @item:tm-complete/worker-guide ', 'Tab completes the newest')
})

test('a ticket mentioned in the open transcript is offered first, like a recently mentioned agent', async t => {
  localStorage.clear(); resetConvos()
  const org = 'tm-recent'
  const alpha = mkNode('worker-alpha')
  const server = new FakeServer()
  server.messages = [{ role: 'assistant', text: 'Earlier: @item:tm-recent/parity-backlog is the one.', seq: 0, event_id: 'r-1' }]
  server.workItems = [ticket('parity-ticket')]
  server.workBacklogged = [ticket('parity-backlog', { status: 'backlogged' })]
  const previous = globalThis.fetch
  installFetch(server)
  t.after(() => { globalThis.fetch = previous; resetConvos() })
  const v = await mountView(
    <AgentNavProvider><ObjectMenuBoundary>
      <DeskChat node={alpha} map={new Map([[alpha.id, alpha]])} slug={org} op={async () => ({})} toast={() => {}} bare onJump={() => {}} />
    </ObjectMenuBoundary></AgentNavProvider>, h => h)
  t.after(async () => { await v.unmount() })
  await inAct(async () => { await refreshConvo(org, 'worker-alpha'); await flush(8) })
  const box = v.el.querySelector<HTMLTextAreaElement>('fieldset.desk-control-scope textarea')!
  await typeInto(box, '@parity')
  assert.equal(rowNames().at(-1), 'parity-backlog', `the transcript's ticket sits nearest the box (${JSON.stringify(rowNames())})`)
  await press(box, 'Enter')
  assert.equal(box.value, '@item:tm-recent/parity-backlog ')
})

test('the project desk composer offers tickets in its @-completion', async t => {
  localStorage.clear(); resetConvos()
  const org = 'tm-project'
  const member = mkNode('worker-beta', 'haiku')
  const project = mkNode('worker-project', 'project', 'project', [member])
  member.parent = 'worker-project'
  const server = new FakeServer()
  server.workItems = [ticket('project-ticket', { owner: { node: 'worker-beta', generation: 1 } as never })]
  const previous = globalThis.fetch
  installFetch(server)
  t.after(() => { globalThis.fetch = previous; resetConvos() })
  const map = new Map<string, CanvasNode>([[project.id, project], [member.id, member]])
  const tree = { slug: org, roots: [project], slot_leases: [], watchdogs: [] } as unknown as TreePayload
  const v = await mountView(
    <AgentNavProvider><ObjectMenuBoundary>
      <ProjectDesk node={project} slug={org} tree={tree} map={map} op={async () => ({} as OpResult)} toast={() => {}}
        refs={{ world: { org }, onOpen: () => {} }} onJump={() => {}} />
    </ObjectMenuBoundary></AgentNavProvider>, h => h)
  t.after(async () => { await v.unmount() })
  await inAct(async () => { await flush(8) })
  const box = v.el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!
  assert.ok(box, 'project composer rendered')
  await typeInto(box, 'Team, see @project-t')
  assert.deepEqual(ticketRows(), ['project-ticket'], `project composer lists the ticket (${JSON.stringify(rowNames())})`)
  await press(box, 'Tab')
  assert.equal(box.value, 'Team, see @item:tm-project/project-ticket ')
})

test('Quick chat offers tickets in its @-completion from the engine\'s read of live things, never the archive', async t => {
  const org = 'tm-quick'
  const requests: string[] = []
  // the engine's read leaves the docket's archive out; the fake serves what the docket lists
  const server = new FakeServer()
  server.workItems = [ticket('quick-ticket', { docket_at: '2026-10-22T10:05:00Z' })]
  server.workBacklogged = [ticket('quick-backlog', { status: 'backlogged' })]
  server.workArchived = [ticket('quick-archived', { status: 'done', archived: true })]
  const old = globalThis.fetch
  globalThis.fetch = legacyAppBackend((async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/mention-candidates')) {
      requests.push(url.searchParams.get('kinds') ?? '')
      return new Response(JSON.stringify(server.mentionCandidates(url)), { status: 200 })
    }
    return new Response(JSON.stringify({ providers: [] }), { status: 200 })
  }) as typeof fetch)
  t.after(() => { globalThis.fetch = old })
  const node = (id: string) => ({ id, state: 'live', kind: 'agent', tier: 'haiku', children: [] })
  const tree = { slug: org, roots: [node('worker-alpha')] } as unknown as TreePayload
  const view = await mountView(<QuickChat slug={org} tree={tree} op={async () => ({} as never)} toast={() => {}} onHired={() => {}} />, h => h)
  t.after(() => view.unmount())
  const box = view.el.querySelector<HTMLInputElement>('.quickchat-input')!
  await typeInto(box, 'ping @quick')
  assert.deepEqual(ticketRows().sort(), ['quick-backlog', 'quick-ticket'], `quick chat lists tickets (${JSON.stringify(rowNames())})`)
  assert.ok(requests.length && requests.every(k => k === 'item,doc,app,panel'), `one read for every kind the engine offers (${requests})`)
  await press(box, 'Tab')
  assert.equal(box.value, 'ping @item:tm-quick/quick-ticket ', 'the newest ticket completes first')
})
