// projectrecipientcard.test.tsx — the agent a project mail's queue state
// names wears its model card, as the sender beside it does (Orgtree 4.4.0;
// docket `project-inbox-list-rows-kind-tags-and-delivered-t`, reopened by the
// user 2026-10-18 17:01Z on alpha.9: "recipients are still missing model icon
// cards in project mailboxes").
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the project desk's inbox: a delivered mail's "→ @recipient" marker
//      carries the recipient's card, on the row's meta line and in the
//      reading pane's header, through the desk's own tree (projectdesk.tsx);
//   §2 the ack-mode states name their agent with its card and link, and keep
//      their labels: "<agent> · awaiting ack", "acked by <agent>",
//      "released (<agent>)";
//   §3 a Sent folder's mail to a project carries the same card;
//   §4 the project desk's sent tab draws its recipients with cards, in the
//      row and after "to" in the open message's header;
//   §5 no resolver, or an id it cannot place, draws no card (TierChip's
//      no-invented-identity rule).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectrecipientcard

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { MailList, QueueChip } from '../src/canvas/mail'
import { ProjectDesk } from '../src/canvas/projectdesk'
import type { CanvasNode, MailRow, OpResult } from '../src/canvas/shared'
import type { MailQueueState, TreePayload } from '../src/types'

const noop = () => {}
const refs = { world: { org: 'org' }, onOpen: noop } as never
const tree = { slug: 'org', roots: [] } as unknown as TreePayload
const tiers: Record<string, string> = { 'coordinator-opus': 'opus', 'hubchat-jumplist-sol': 'sol', dev1: 'haiku' }
const tierOf = (id: string) => tiers[id]

const mail = (queue: MailQueueState, extra: Partial<MailRow> = {}): MailRow => ({
  id: 'm1', from: 'hubchat-jumplist-sol', kind: 'question', body: 'Please check this project item.',
  at: '2026-10-18T12:00:00Z', queue,
  ev: { v: 1, variant: 'ordinary.question', actor: { kind: 'agent', id: 'hubchat-jumplist-sol' }, object: null,
    engine_authored: false, body: 'Please check this project item.' },
  ...extra,
} as MailRow)

/** a chip's own words: its text with every model card's letter left out */
const words = (el: Element) => [...el.childNodes]
  .filter((n) => !(n instanceof window.Element && n.classList.contains('tier')))
  .map((n) => n.textContent).join('')

/** the card for `id` inside `el`, checked to be that agent's and to sit right
 *  before its shared agent link */
function cardOf(el: Element | null | undefined, id: string, what: string) {
  assert.ok(el, `${what}: positive control, the queue state is drawn`)
  const card = el.querySelector('.tier')
  assert.ok(card, `${what}: ${id} wears its model card`)
  assert.equal(card.classList.contains('t-' + tiers[id]), true, `${what}: the card is ${id}'s own model (${card.className})`)
  assert.equal(card.getAttribute('data-copy-agent-name'), id, `${what}: the card names its agent`)
  const name = card.nextElementSibling
  assert.equal(name?.classList.contains('cc-name'), true, `${what}: the card sits right before the name`)
  return { card, name: name as HTMLElement }
}

/* ─── §1 the project desk's inbox ──────────────────────────────────────── */

const member = (id: string) => ({ id, title: id, tier: tiers[id], state: 'live', busy: false, children: [] })
function project(): CanvasNode {
  return {
    id: 'website', title: 'website', tier: 'project', kind: 'project', state: 'live', model_id: '',
    seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [] },
    parent: 'boss', charter: 'The site.', children: Object.keys(tiers).map(member),
    lineage: [], turns: [], audiences_held: [], mail_pending: 0,
    last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
  } as unknown as CanvasNode
}

/** the harness server, with this project's mailbox answered from `box` */
function serve(t: TestContext, box: { delivered?: MailRow[]; sent?: MailRow[] }) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  const inner = globalThis.fetch
  const json = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b),
    { status: 200, headers: { 'Content-Type': 'application/json' } }))
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url), 'http://x')
    if (u.pathname === '/api/orgs/org/nodes/website/inbox') {
      const folder = u.searchParams.get('folder')
      return json({ pending: [], delivered: folder === 'sent' ? [] : box.delivered ?? [],
        sent: folder === 'inbox' ? [] : box.sent ?? [], next_cursor: null })
    }
    if (u.pathname === '/api/app-settings/runtime') return json({ working_checkups_enabled: true })
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
}

async function openDesk(t: TestContext, box: { delivered?: MailRow[]; sent?: MailRow[] }, folder: 'inbox' | 'sent') {
  serve(t, box)
  const nd = project()
  const map = new Map<string, CanvasNode>([[nd.id, nd], ...nd.children.map((c) => [c.id, c] as [string, CanvasNode])])
  const jumps: string[] = []
  const view = await mountView(<ProjectDesk node={nd} slug="org" tree={tree} map={map}
    op={() => Promise.resolve({} as OpResult)} toast={noop} refs={refs} onJump={(id) => jumps.push(id)} />, (el) => el)
  t.after(() => view.unmount())
  await flush(2)
  await inAct(() => { view.el.querySelector<HTMLButtonElement>('.cc-tabs button[data-tab="inbox"]')!.click() })
  await inAct(async () => { await flush(6) })
  if (folder === 'sent') {
    const sent = [...view.el.querySelectorAll<HTMLButtonElement>('.mailwrap button')]
      .find((b) => b.textContent?.trim().toLowerCase() === 'sent')
    assert.ok(sent, 'positive control: the sent folder')
    await inAct(async () => { sent!.click(); await flush(6) })
  }
  return { view, jumps }
}

test('§1 the project inbox marker wears the recipient\'s model card in the row and the reading pane', async (t) => {
  const { view, jumps } = await openDesk(t, { delivered: [mail({ held_by: 'coordinator-opus', ack: false })] }, 'inbox')
  assert.ok(view.el.querySelector('.mailrow .mfrom .tier.t-sol'), 'positive control: the desk resolves the sender\'s card')
  const marker = view.el.querySelector('.mailrow .lmeta .queue-delivery')
  const { name } = cardOf(marker, 'coordinator-opus', 'row')
  assert.equal(name.textContent, '@coordinator-opus', 'the marker still reads → @recipient')
  assert.equal(name.getAttribute('data-agent-nav'), 'coordinator-opus', 'the name is still the shared agent link')
  await inAct(() => name.click())
  assert.deepEqual(jumps, ['coordinator-opus'], 'the link still focuses that agent')
  assert.equal(view.el.querySelector('.mailrow.on') === null, true, 'and does not select the mail')
  await inAct(async () => { view.el.querySelector<HTMLElement>('.mailrow .l2')!.click(); await flush(2) })
  cardOf(view.el.querySelector('.mailer-head .queue-delivery'), 'coordinator-opus', 'reading pane')
})

/* ─── §2 the ack-mode states ───────────────────────────────────────────── */

test('§2 an ack-mode state names its agent with the card and link, and keeps its label', async (t) => {
  for (const [queue, label] of [
    [{ held_by: 'coordinator-opus', ack: true }, 'coordinator-opus · awaiting ack'],
    [{ held_by: 'coordinator-opus', ack: true, acked_at: '2026-10-18T12:20:00Z', ack_mail: 'm9' }, 'acked by coordinator-opus'],
    [{ released: { by: 'coordinator-opus', why: 'was halted' } }, 'released (coordinator-opus)'],
  ] as const) {
    const jumps: string[] = []
    const v = await mountView(<MailList delivered={[mail(queue)]} projectMail onFocusAgent={(id) => jumps.push(id)}
      hasAgent={(id) => id in tiers} tierOf={tierOf} />, (el) => el)
    t.after(() => v.unmount())
    const chip = v.el.querySelector('.mailrow .lmeta .queuekind')
    const { name } = cardOf(chip, 'coordinator-opus', label)
    assert.equal(words(chip!), label, `${label}: the label reads as before`)
    assert.equal(name.getAttribute('data-agent-nav'), 'coordinator-opus', `${label}: the shared agent link`)
    await inAct(() => name.click())
    assert.deepEqual(jumps, ['coordinator-opus'], `${label}: the link focuses that agent`)
    assert.equal(v.el.querySelector('.mailrow.on') === null, true, `${label}: and does not select the mail`)
    await inAct(async () => { v.el.querySelector<HTMLElement>('.mailrow .l2')!.click(); await flush(2) })
    const head = v.el.querySelector('.mailer-head .queuekind')
    cardOf(head, 'coordinator-opus', `${label} in the reading pane`)
    assert.equal(words(head!), label, `${label}: the reading pane's label reads as before`)
  }
})

/* ─── §3 a Sent folder ─────────────────────────────────────────────────── */

test('§3 a Sent folder\'s mail to a project carries the recipient\'s card on its queue state', async (t) => {
  const v = await mountView(<MailList outgoing delivered={[mail({ held_by: 'dev1', ack: false }, { from: 'coordinator-opus', to: 'website' })]}
    onFocusAgent={noop} hasAgent={(id) => id in tiers} tierOf={(id) => id === 'website' ? 'project' : tierOf(id)} />, (el) => el)
  t.after(() => v.unmount())
  assert.ok(v.el.querySelector('.mailrow .mfrom .project-mark'), 'positive control: line 1 names the project with its mark')
  cardOf(v.el.querySelector('.mailrow .lmeta .queue-delivery'), 'dev1', 'sent row')
})

/* ─── §4 the project desk's sent tab ───────────────────────────────────── */

test('§4 the project desk\'s sent tab draws its recipients with cards', async (t) => {
  const { view } = await openDesk(t, { sent: [mail({}, { id: 's1', from: 'website', to: 'coordinator-opus', queue: undefined })] }, 'sent')
  const row = view.el.querySelector('.mailrow')
  assert.ok(row, 'positive control: the sent row')
  cardOf(row!.querySelector('.mfrom'), 'coordinator-opus', 'sent tab recipient')
  // the open message names its recipient after "to", with the same card
  await inAct(async () => { (row!.querySelector<HTMLElement>('.l2') ?? row as HTMLElement).click(); await flush(2) })
  const head = view.el.querySelector('.mailer-head')
  assert.ok(head, 'positive control: the sent mail opens')
  // the header's words abut in textContent ("...-solto..."), so find the "to" itself
  const to = [...head!.querySelectorAll('span.dim')].find((s) => s.textContent?.trim() === 'to')
  assert.ok(to, 'positive control: the header reads "to" before its recipient')
  cardOf(to!.nextElementSibling, 'coordinator-opus', 'sent tab reading pane')
})

/* ─── §5 honesty ───────────────────────────────────────────────────────── */

test('§5 no resolver, or an id it cannot place, draws no card', async (t) => {
  for (const props of [{}, { tierOf }] as const) {
    for (const q of [{ held_by: 'stranger', ack: false }, { held_by: 'stranger', ack: true }, { released: { by: 'stranger' } }]) {
      const v = await mountView(<QueueChip q={q} {...props} />, (el) => el)
      t.after(() => v.unmount())
      assert.ok(v.el.querySelector('.queuekind'), 'positive control: the state is drawn')
      assert.equal(v.el.querySelector('.tier') === null, true, `${JSON.stringify(q)} ${Object.keys(props)}: no invented card`)
    }
  }
})
