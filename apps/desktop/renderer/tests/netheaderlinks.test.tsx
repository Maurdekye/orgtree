// netheaderlinks.test.tsx — an outside address in a mail HEADER is the same
// link it is in a message body, and that link can open the org inbox.
//
// USER 2026-10-29 10:00:45Z m14ad537c5eb8, about a desk header reading
// "Message @net:<address> <time>": "these addresses should also be embedded
// hubchat / outbox links". The shared event-card header routed only AGENT
// senders through the surface's sender renderer and printed every other actor
// id as text, so a typed mail from outside showed its address plain; the user
// inbox's SenderChip did the same for untyped rows. Every other mail surface
// already draws @net:/@org: as the shared Hub contact link (`HubContactChip`).
//
//   §1 the desk transcript header (the user's screenshot)
//   §2 the shared header itself, on every surface that mounts it
//   §3 the reading panes: desk/node inbox, user inbox (SenderChip)
//   §4 "Open in org inbox" in the shared Hub contact menu, through the canvas
//   §5 the org inbox's view of one address that entry opens
//
// The click stays what every Hub contact link does (Hubchat when installed,
// a local org's window, inert otherwise: DECISIONS "Hub-contact availability",
// user 2026-10-18); the org inbox is the menu's other destination.

import { withoutMailTransfers } from './mailtransfers.fixture'
import { FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { refreshConvo, resetConvos } from '../src/convo'
import { DeskChat } from '../src/canvas/desk'
import { MailList, OrgInboxModal } from '../src/canvas/mail'
import { SenderChip } from '../src/canvas/senderchip'
import { EventCard } from '../src/events/card'
import { HubContactChip, setHubchatInstalled } from '../src/canvas/agentmentions'
import { hubAddressTitle, resetNetMentions } from '../src/canvas/netmentions'
import type { CanvasNode, MailRow } from '../src/canvas/shared'
import type { ChatMessage, OpResult, OrgInboxEntry, TreeNode, TreePayload } from '../src/types'

// jsdom has no layout: a list jump scrolls its row into view
;(globalThis as unknown as
  { window: { Element: { prototype: Record<string, unknown> } } })
  .window.Element.prototype.scrollIntoView ??= () => {}

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const PEER = '@net:peer.fixture.abc123'
const OTHER = '@net:other.fixture.def456'
const REMOTE_ORG = '@org:faraway'
const dm = (address: string) => 'hubchat://chat?to=' + encodeURIComponent(address)
const q = (el: ParentNode, sel: string) => [...el.querySelectorAll(sel)] as HTMLElement[]
const txt = (el: Element | null | undefined) => el?.textContent ?? ''
const chipSel = (address: string) => `[data-hub-address="${address}"]`
/** ⚠ never assert.equal(node, null) on a DOM node (see mailsender.test.tsx): count instead */
const count = (el: ParentNode, sel: string) => el.querySelectorAll(sel).length

/** Hubchat installed (or not) and every window.open recorded, undone after. */
function hubchat(t: TestContext, installed = true): string[] {
  const saved = window.open
  const opened: string[] = []
  window.open = ((url: unknown) => { opened.push(String(url)); return null }) as typeof window.open
  setHubchatInstalled(installed)
  t.after(() => { window.open = saved; resetNetMentions(); setHubchatInstalled(false) })
  return opened
}

/** A typed mail row as the engine sends it: an outside sender is actor kind `external`. */
const typedRow = (from: string, id = 'typed-fixture', body = 'Hi Orgtree, a word from outside') => ({
  id, from, relationship: 'outside party', kind: 'message', at: '2026-10-29T09:59:55Z', body,
  ev: { v: 1, variant: 'ordinary.message', actor: { kind: from.startsWith('@') ? 'external' : 'agent', id: from },
    object: null, engine_authored: false, body },
})
/** …and its untyped sibling: no `ev`, the legacy envelope. */
const legacyRow = (from: string, id = 'legacy-fixture', body = 'Hi Orgtree, an older envelope') => ({
  id, from, relationship: 'outside party', kind: 'message', at: '2026-10-29T09:59:55Z', body,
})

function agent(id: string): CanvasNode {
  return { id, state: 'live', tier: 'opus', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'opus' } as unknown as CanvasNode
}

const menuItems = () => q(document, '[role="menu"] [role="menuitem"]') as HTMLButtonElement[]
async function openMenu(link: HTMLElement): Promise<HTMLButtonElement[]> {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  await inAct(async () => { link.dispatchEvent(event); await flush(2) })
  assert.equal(event.defaultPrevented, true, 'positive control: the link owns its context menu')
  return menuItems()
}
async function closeMenu(): Promise<void> {
  const menu = document.querySelector('[role="menu"]')
  if (menu) await inAct(() => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
}

// ═══════════════════════════════════════════════════════════════════ §1
// THE DESK — the screenshot: an outside mail on an agent's desk.
// ═══════════════════════════════════════════════════════════════════ §1

let deskSeq = 0
async function desk(t: TestContext, row: Record<string, unknown>): Promise<HTMLElement> {
  useFakeClock()
  const s = new FakeServer()
  installFetch(s)
  const nd = agent(`nh${++deskSeq}`)
  s.userMsg('Agent projection fallback').segments = [{ kind: 'mail', rows: [row] }] as unknown as ChatMessage['segments']
  const v = await mountView(
    <DeskChat node={nd} map={new Map([[nd.id, nd]])} op={op} slug="org" toast={noop} bare onJump={noop} />,
    (host) => host)
  t.after(async () => {
    try { await v.unmount() } catch { /* gone */ }
    resetConvos()
    realClock()
  })
  await refreshConvo('org', nd.id, { force: true })
  await flush()
  return v.el
}

const mailHead = (el: HTMLElement) => {
  const head = el.querySelector<HTMLElement>('.turn-mail .turn-mail-head')
  assert.ok(head, 'positive control: the mail card and its header rendered')
  return head!
}

test('§1.1 the desk header names an outside sender with the shared Hub contact link, not plain text', async t => {
  const opened = hubchat(t)
  const head = mailHead(await desk(t, typedRow(PEER)))
  const link = head.querySelector<HTMLButtonElement>(chipSel(PEER))
  assert.ok(link, `the sender in the header is a link: ${JSON.stringify(txt(head))}`)
  assert.equal(link!.tagName, 'BUTTON')
  assert.ok(link!.classList.contains('ref-hub'), 'the element a body mention of the address is')
  assert.equal(link!.title, hubAddressTitle(PEER), 'the one shared hover')
  assert.match(txt(link), /peer\.fixture\.abc123/, 'the address stays the visible text')
  assert.equal(count(head, chipSel(PEER)), 1, 'named once')
  await inAct(async () => { link!.click(); await flush(2) })
  assert.deepEqual(opened, [dm(PEER)], 'a click opens its Hubchat conversation, as every Hub contact link does')
})

test('§1.2 CONTROL: an untyped outside mail already wears the link in the same header (MailFrom)', async t => {
  hubchat(t)
  const head = mailHead(await desk(t, legacyRow(PEER)))
  assert.equal(count(head, chipSel(PEER)), 1, 'the legacy envelope path draws the shared link today')
})

// ═══════════════════════════════════════════════════════════════════ §2
// THE SHARED HEADER — events/card.tsx, mounted by the desk, every inbox's
// reading pane, the history view and nested event cards.
// ═══════════════════════════════════════════════════════════════════ §2

async function headers(t: TestContext, ids: string[], actor: (id: string) => React.ReactNode) {
  const v = await mountView(<div>
    {ids.map(id => <header key={id} className="event-head" data-case={id}>
      <EventCard part="header" row={typedRow(id)} profile="operator" org="org" actor={actor} />
    </header>)}
  </div>, (host) => host)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(2) })
  return (id: string) => v.el.querySelector<HTMLElement>(`[data-case="${id}"]`)!
}

test('§2.1 the shared mail header draws an outside @net:/@org: actor as the Hub contact link', async t => {
  hubchat(t)
  const head = await headers(t, [PEER, REMOTE_ORG], (id) => <b className="surface-name">{id}</b>)
  for (const id of [PEER, REMOTE_ORG]) {
    assert.equal(count(head(id), chipSel(id)), 1, `${id}: one Hub contact link in the header`)
    assert.equal(count(head(id), '.surface-name'), 0,
      `${id}: never an agent renderer's plain name, whatever the surface hands in`)
    assert.equal(head(id).querySelector<HTMLElement>(chipSel(id))!.title, hubAddressTitle(id))
  }
})

test('§2.2 CONTROL: an agent actor keeps the surface renderer, and a non-hub outside id keeps its recorded text', async t => {
  hubchat(t)
  const head = await headers(t, ['ceo', '@mcp:old-tool'], (id) => <b className="surface-name">{id}</b>)
  assert.equal(count(head('ceo'), '.surface-name'), 1, 'agents still route through the surface')
  assert.match(txt(head('@mcp:old-tool')), /@mcp:old-tool/, 'a pre-2026-09-25 @mcp: actor stays readable')
  assert.equal(count(head('@mcp:old-tool'), '[data-hub-address]'), 0, 'and is no Hub contact')
})

// ═══════════════════════════════════════════════════════════════════ §3
// THE READING PANES — the same row in an inbox.
// ═══════════════════════════════════════════════════════════════════ §3

async function list(t: TestContext, el: React.ReactElement) {
  const v = await mountView(el, (host) => host)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(3) })
  const pane = v.el.querySelector<HTMLElement>('.mailer-head')
  assert.ok(pane, 'positive control: the jump opened the reading pane')
  return { el: v.el, pane: pane! }
}
const userSender = (id: string) => <SenderChip id={id} nodes={new Map<string, TreeNode>()} />

test('§3.1 a desk or node inbox reading pane names an outside sender with the link (typed row)', async t => {
  hubchat(t)
  const { el, pane } = await list(t, <MailList org="org" delivered={[typedRow(PEER) as unknown as MailRow]} jumpTo="typed-fixture" />)
  assert.equal(count(pane, chipSel(PEER)), 1, `the pane header links the sender once: ${JSON.stringify(txt(pane))}`)
  assert.equal(count(el.querySelector('.mailrow')!, chipSel(PEER)), 1, 'and agrees with its list row')
})

test('§3.2 the user inbox reading pane names an outside sender with the link, typed or untyped', async t => {
  hubchat(t)
  for (const row of [typedRow(PEER), legacyRow(PEER)]) {
    const { pane } = await list(t, <MailList org="org" delivered={[row as unknown as MailRow]} jumpTo={row.id}
      sender={(id) => userSender(id)} rowSender={(id) => <span>{id}</span>} />)
    assert.equal(count(pane, chipSel(PEER)), 1, `${row.id}: the pane links the sender: ${JSON.stringify(txt(pane))}`)
  }
})

test('§3.3 CONTROL: the user inbox LIST row keeps its plain name (user 2026-09-11 e56a491)', async t => {
  hubchat(t)
  const { el } = await list(t, <MailList org="org" delivered={[typedRow(PEER) as unknown as MailRow]} jumpTo="typed-fixture"
    sender={(id) => userSender(id)} rowSender={(id) => <span>{id}</span>} />)
  const row = el.querySelector('.mailrow .mfrom')!
  assert.match(txt(row), /peer\.fixture\.abc123/)
  assert.equal(count(row, '[data-hub-address]'), 0, 'the list row is the plain name the user chose')
})

test('§3.4 SenderChip, shared by the user inbox and the Attention view, draws a Hub address as its link', async t => {
  hubchat(t)
  const nodes = new Map<string, TreeNode>([['ceo', agent('ceo') as unknown as TreeNode]])
  const v = await mountView(<div>
    <span data-case="peer"><SenderChip id={PEER} nodes={nodes} /></span>
    <span data-case="org"><SenderChip id={REMOTE_ORG} nodes={nodes} /></span>
  </div>, (host) => host)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(2) })
  assert.equal(count(v.el.querySelector('[data-case="peer"]')!, chipSel(PEER)), 1)
  assert.equal(count(v.el.querySelector('[data-case="org"]')!, chipSel(REMOTE_ORG)), 1)
})

test('§3.5 CONTROL: SenderChip keeps an agent\'s model chip and the user\'s "you"', async t => {
  const nodes = new Map<string, TreeNode>([['ceo', agent('ceo') as unknown as TreeNode]])
  const v = await mountView(<div>
    <span data-case="ceo"><SenderChip id="ceo" nodes={nodes} /></span>
    <span data-case="user"><SenderChip id="@user" nodes={nodes} /></span>
  </div>, (host) => host)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(2) })
  assert.equal(count(v.el.querySelector('[data-case="ceo"]')!, '.tier'), 1)
  assert.equal(txt(v.el.querySelector('[data-case="user"]')), 'you')
})

// ═══════════════════════════════════════════════════════════════════ §4
// "OPEN IN ORG INBOX" — the menu's other destination, through the canvas.
// ═══════════════════════════════════════════════════════════════════ §4

const inboxRows: OrgInboxEntry[] = [
  { id: 'p-in', dir: 'in', peer: PEER, body: 'first word from the peer', at: '2026-10-29T09:00:00Z' },
  { id: 'o-in', dir: 'in', peer: OTHER, body: 'someone else writes', at: '2026-10-29T09:10:00Z' },
  { id: 'p-out', dir: 'out', peer: PEER, by: 'ceo', body: 'our answer to the peer', at: '2026-10-29T09:20:00Z', state: 'read' },
  { id: 'o-out', dir: 'out', peer: OTHER, by: 'ceo', body: 'our answer to someone else', at: '2026-10-29T09:30:00Z', state: 'sent' },
]

/** Every request answers: the org inbox log for /org_inbox, empty elsewhere. */
function inboxServer(t: TestContext, rows: OrgInboxEntry[] = inboxRows) {
  const saved = globalThis.fetch
  globalThis.fetch = withoutMailTransfers((async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.endsWith('/org_inbox') ? { entries: rows, total: rows.length, unread: 0 }
      : url.endsWith('/api/desktop/phone') ? { hubchat_pc: true } : {}
    return { ok: true, status: 200, headers: new Headers(), json: async () => body }
  }) as unknown as typeof fetch)
  t.after(() => { globalThis.fetch = saved })
}

function canvasTree(enabled: boolean): TreePayload {
  const ceo = {
    id: 'ceo', title: 'ceo', tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  }
  return {
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: [ceo], cost_usd_total: 0,
    audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    auto_resume: false, fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, audience_requests: [],
    org_inbox: { entries: inboxRows.slice(-2), total: inboxRows.length, unread: 0, holders: ['ceo'], visible: true, enabled },
    net: { slug: 'mine.ncola.abc123', hubs: [] },
  } as unknown as TreePayload
}

async function canvas(t: TestContext, enabled = true) {
  useFakeClock()
  t.after(() => realClock())
  inboxServer(t)
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const v = await mountView(<div>
    <OrgCanvas tree={canvasTree(enabled)} op={op as never} slug="mine" toast={noop} mailEvt={null} />
    <p className="outside-mail-head"><HubContactChip address={PEER} /></p>
  </div>, (host) => host)
  t.after(async () => { await closeMenu(); try { await v.unmount() } catch { /* gone */ } })
  await inAct(async () => { await flush(4) })
  return v.el.querySelector<HTMLElement>(`.outside-mail-head ${chipSel(PEER)}`)!
}
const orgInboxOpen = () => q(document, 'h3').some(h => txt(h).includes('The org inbox'))

test('§4.1 in an org window, the link\'s menu offers Open in org inbox, which opens that address\'s mail there', async t => {
  hubchat(t)
  const link = await canvas(t)
  assert.equal(orgInboxOpen(), false, 'positive control: the panel starts closed')
  const items = await openMenu(link)
  assert.deepEqual(items.map(i => txt(i)), ['Open in Hubchat', 'Open in org inbox', 'Copy identity'],
    'the second destination sits with the first')
  const entry = items[1]!
  assert.equal(entry.disabled, false)
  await inAct(async () => { entry.click(); await flush(6) })
  assert.ok(orgInboxOpen(), 'the org inbox opened')
  const filter = document.querySelector<HTMLInputElement>('.mail-filter')
  assert.ok(filter, 'the panel shows its filter')
  assert.equal(filter!.value, PEER, 'filtered to the address')
  assert.match(txt(document.querySelector('.mailer-read .mailer-body')), /our answer to the peer/,
    'with the newest mail exchanged with it open')
})

test('§4.2 an org whose inbox is closed off says so on the entry and opens nothing', async t => {
  hubchat(t)
  const link = await canvas(t, false)
  const entry = (await openMenu(link)).find(i => txt(i) === 'Open in org inbox')
  assert.ok(entry, 'the entry is still offered in an org window')
  assert.equal(entry!.disabled, true)
  assert.equal(entry!.title, 'The org inbox is closed off')
  await inAct(async () => { entry!.click(); await flush(3) })
  assert.equal(orgInboxOpen(), false)
})

test('§4.3 CONTROL: where no org inbox exists in the window the menu is unchanged', async t => {
  hubchat(t)
  const v = await mountView(<HubContactChip address={PEER} />, (host) => host)
  t.after(async () => { await closeMenu(); await v.unmount() })
  await inAct(async () => { await flush(2) })
  const items = await openMenu(v.el.querySelector<HTMLElement>(chipSel(PEER))!)
  assert.deepEqual(items.map(i => txt(i)), ['Open in Hubchat', 'Copy identity'])
})

// ═══════════════════════════════════════════════════════════════════ §5
// THE ORG INBOX, OPENED ON ONE ADDRESS — OrgInboxModal's party view.
// ═══════════════════════════════════════════════════════════════════ §5

async function orgInbox(t: TestContext, party: { address: string; seq: number } | null,
  rows: OrgInboxEntry[] = inboxRows) {
  hubchat(t)
  inboxServer(t, rows)
  const map = new Map<string, CanvasNode>([['ceo', agent('ceo')]])
  const props = { inbox: { entries: rows, total: rows.length, unread: 0, holders: ['ceo'], visible: true } as TreePayload['org_inbox'],
    net: { slug: 'mine.ncola.abc123', hubs: [] } as TreePayload['net'], map, slug: 'mine', toast: noop, close: noop,
    jumpTo: null, onFocusAgent: noop }
  // `party` is the new prop; spread so this file still bundles where it does not exist yet
  const v = await mountView(<OrgInboxModal {...props} {...({ party } as object)} />, (host) => host)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(5) })
  const rerender = async (next: { address: string; seq: number } | null) => {
    await v.render(<OrgInboxModal {...props} {...({ party: next } as object)} />)
    await inAct(async () => { await flush(5) })
  }
  return { el: v.el, rerender }
}
const folderOn = (el: HTMLElement) => txt(el.querySelector('.mail-folders button.on')).trim()
const folder = (el: HTMLElement, name: string) => inAct(async () => {
  q(el, '.mail-folders button').find(b => txt(b).trim().startsWith(name))!.click(); await flush(3)
})
const listed = (el: HTMLElement) => q(el, '.mailrow').map(r => txt(r.querySelector('.mfrom')))
const filterOf = (el: HTMLElement) => el.querySelector<HTMLInputElement>('.mail-filter')?.value ?? null

test('§5.1 opened on an address: its newest mail\'s folder, filtered to it, that mail selected; the other folder keeps the filter', async t => {
  const { el } = await orgInbox(t, { address: PEER, seq: 1 })
  assert.equal(folderOn(el), 'sent', 'the newest mail with the peer is our answer')
  assert.equal(filterOf(el), PEER)
  assert.equal(listed(el).length, 1, `only the peer's mail is listed: ${JSON.stringify(listed(el))}`)
  assert.match(txt(el.querySelector('.mailer-read .mailer-body')), /our answer to the peer/)
  await folder(el, 'inbox')
  assert.equal(filterOf(el), PEER, 'the view is of the address, not of one folder')
  assert.equal(listed(el).length, 1)
  assert.match(listed(el)[0]!, /peer\.fixture\.abc123/)
})

test('§5.2 editing the filter ends the address view: the other folder opens unfiltered', async t => {
  const { el } = await orgInbox(t, { address: PEER, seq: 1 })
  const input = el.querySelector<HTMLInputElement>('.mail-filter')
  assert.ok(input, 'the address view shows its filter')
  await inAct(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    set.call(input!, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush(2)
  })
  assert.equal(listed(el).length, 2, 'cleared in this folder: both sent mails')
  await folder(el, 'inbox')
  assert.equal(filterOf(el) ?? '', '', 'not re-applied on the next folder')
  assert.equal(listed(el).length, 2)
})

test('§5.3 an address with no mail here opens on the inbox, filtered, saying there are no matches', async t => {
  const { el } = await orgInbox(t, { address: '@net:nobody.fixture.000000', seq: 1 })
  assert.equal(folderOn(el), 'inbox')
  assert.equal(filterOf(el), '@net:nobody.fixture.000000')
  assert.match(txt(el), /no matches/)
})

test('§5.4 a new request while open moves the view to the new address', async t => {
  const { el, rerender } = await orgInbox(t, { address: PEER, seq: 1 })
  assert.equal(folderOn(el), 'sent')
  await rerender({ address: OTHER, seq: 2 })
  assert.equal(filterOf(el), OTHER)
  assert.equal(folderOn(el), 'sent', 'the newest mail with the other party is ours too')
  assert.match(txt(el.querySelector('.mailer-read .mailer-body')), /our answer to someone else/)
  // and its incoming mail is in the inbox folder
  await folder(el, 'inbox')
  assert.deepEqual(listed(el).length, 1)
  assert.match(listed(el)[0]!, /other\.fixture\.def456/)
})

test('§5.5 CONTROL: without a request the panel opens as it always did', async t => {
  const { el } = await orgInbox(t, null)
  assert.equal(folderOn(el), 'inbox')
  assert.equal(filterOf(el) ?? '', '')
  assert.equal(listed(el).length, 2)
})
