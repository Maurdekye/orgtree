// symmetrymenus.test.tsx — UX SYMMETRY, MENUS (docket symmetry-fixes-s1-orgtree-menus-links-and-node-f).
// USER 2026-10-29 12:50:22Z mb6da9f3ee862: "the more symmetries a program contains, the closer to 'perfect' it
// is"; 13:25:12Z m72500eeca0c0 authorized the audit's findings ("symmetry wins unless my ruling overrides it").
//
//   §1 (#1)  an urgent mail or a question in the Attention view raises the SAME context menu the Inbox raises for
//            that row, and each entry does there what it does in the Inbox. Before: no menu at all.
//   §2 (#3)  CONTROL. Agent and project node menus show their shared actions in one order. The builders differ,
//            but the shared renderer moves Open to second place in every menu (USER 2026-10-20), so the rendered
//            order already agrees. Passes before and after; it pins what the audit could not see from source.
//   §3 (#4)  inside Open, an agent and a project list their shared entries in one order: Docket before
//            Presentations, as both desks order their tabs. Before: a project listed Presentations first.
//
// Run:  node apps/desktop/renderer/tests/run.mjs symmetrymenus
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AttentionDeselectFixture, installAttentionServer, org, remaining, urgent } from './attentiondeselect-fixture'
import { MenuFixture, node } from './opensecond.fixture'
import { attentionMailRef } from '../src/attention/AttentionQueue'
import { agentMenuEntries, projectMenuEntries } from '../src/canvas/agentmenu'
import type { AgentMenuHandlers } from '../src/canvas/agentmenu'
import type { MenuEntry } from '../src/canvas/contextmenu'
import { MailList } from '../src/canvas/mail'
import { refToken } from '../src/canvas/reflinks'
import type { MailRow } from '../src/canvas/shared'
import { resetLocalReads } from '../src/mailread'
import { resetSeenMentions } from '../src/canvas/agentmentions'
import { bumpLive } from '../src/livebus'

const W = window as unknown as Window & typeof globalThis
const noop = () => {}
const settle = () => inAct(() => flush(8))
const repoll = () => inAct(async () => { bumpLive(); await new Promise(r => setTimeout(r, 220)); await flush(8) })
const rootMenu = () => document.querySelector<HTMLElement>('.ctxmenu:not(.ctxmenu-submenu)')
/** the open menu's top level, separators included, as the reader sees it */
const shape = () => {
  const menu = rootMenu()
  return menu ? [...menu.children].map(el => el.getAttribute('role') === 'separator' ? 'sep'
    : (el.querySelector('[role="menuitem"]')?.textContent ?? el.textContent ?? '').replace(/\s*▸$/, '').trim()) : null
}
const item = (label: string) => [...(rootMenu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
  .find(b => b.textContent?.replace(/\s*▸$/, '').trim() === label)
/** choose an entry of the open menu, which must offer it */
async function choose(label: string) {
  const b = item(label)
  assert.ok(b, `the open menu offers ${label}: ${JSON.stringify(shape())}`)
  await inAct(() => { b.click() })
}
async function rightClick(el: Element) {
  await inAct(() => { el.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 12, clientY: 12 })) })
  await flush(3)
}
async function closeMenu() {
  const menu = rootMenu()
  if (menu) await inAct(() => { menu.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  await flush(2)
}
const attnRow = (el: HTMLElement, key: string) => el.querySelector<HTMLElement>(`[data-attn-row="${key}"] .mailrow`)
const selected = (el: HTMLElement) => el.querySelector('[data-attn-row][aria-selected="true"]')?.getAttribute('data-attn-row') ?? null
function stubClipboard() {
  const writes: string[] = []
  const nav = W.navigator as unknown as Record<string, unknown>
  const had = Object.getOwnPropertyDescriptor(nav, 'clipboard')
  Object.defineProperty(nav, 'clipboard', { configurable: true,
    value: { writeText: (t: string) => { writes.push(t); return Promise.resolve() } } })
  return { writes, restore: () => { if (had) Object.defineProperty(nav, 'clipboard', had); else delete nav.clipboard } }
}
/** the attention fixture's server, plus the inbox's DELETE route (removes the mail and records it) */
function installServer() {
  const state = installAttentionServer(urgent)
  const deletes: string[] = []
  const inner = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const hit = /\/inbox\/([^/]+)$/.exec(path)
    if (init?.method === 'DELETE' && hit && hit[1] !== 'read') {
      const id = decodeURIComponent(hit[1]!)
      deletes.push(id)
      state.pending = state.pending.filter(m => m.id !== id)
      state.delivered = state.delivered.filter(m => m.id !== id)
      return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return inner(url, init)
  }
  return { state, deletes }
}

/* ─── §1 (#1) the Attention view's mail rows raise the Inbox's mail menu ─────────────────── */

/** The user's Inbox as App.tsx wires it, reduced to what the row menu reads: reading, deleting, replying and the
 *  user box's reference token. Nothing is selected, as when a mail is right-clicked before it is opened. */
async function inboxShapeFor(m: MailRow) {
  const v = await mountView(<MailList org={org} pending={[m]} delivered={[]} toast={noop}
    onRead={noop} onDeleteUserMail={noop} onReply={noop}
    refOf={(row) => row.id && !row._ask ? refToken({ kind: 'mail', org, box: 'user', id: row.id }) : null} />, el => el)
  try {
    const row = v.el.querySelector('.mailrow')
    assert.ok(row, 'the Inbox drew the row')
    await rightClick(row)
    const got = shape()
    assert.ok(got, 'CONTROL: the Inbox row raises its menu in this harness')
    await closeMenu()
    return got
  } finally { await v.unmount() }
}

test('§1a an unread urgent mail in Attention raises the menu the Inbox raises for it', async t => {
  localStorage.clear(); resetLocalReads(); resetSeenMentions()
  installServer()
  // the question is newest, so it is the auto-selected row and the two urgent mails stay unread and unselected
  const v = await mountView(<AttentionDeselectFixture withQuestion marker={false} />, el => el)
  t.after(async () => { await v.unmount(); resetLocalReads(); resetSeenMentions() })
  await settle()
  assert.equal(selected(v.el), 'question:question', 'fixture: the question is the selected row')
  const want = await inboxShapeFor({ ...remaining, _wait: true })
  assert.deepEqual(want, ['Open', 'Reply', 'Mark as read', 'Delete', 'sep', 'Copy message text', 'Copy reference'],
    'CONTROL: the Inbox offers these for an unread received mail')
  const row = attnRow(v.el, 'mail:' + remaining.id)
  assert.ok(row, 'the unread urgent mail is listed')
  await rightClick(row)
  assert.deepEqual(shape(), want, 'Attention raises the same menu, in the same order, for the same mail')
  await closeMenu()
})

test('§1b in Attention, the selected question and an opened mail raise the menus the Inbox raises for them', async t => {
  localStorage.clear(); resetLocalReads(); resetSeenMentions()
  const { state } = installServer()
  const v = await mountView(<AttentionDeselectFixture withQuestion marker={false} />, el => el)
  t.after(async () => { await v.unmount(); resetLocalReads(); resetSeenMentions() })
  await settle()
  const question = attnRow(v.el, 'question:question')
  assert.ok(question, 'the question is listed')
  await rightClick(question)
  assert.deepEqual(shape(), ['Close', 'sep', 'Copy message text'],
    'a selected question: Close, then copying (an ask is not answered, read or deleted from the row)')
  await choose('Close')
  await settle()
  assert.equal(selected(v.el), null, 'Close clears the selection, as clicking the selected row does')
  // Open from the menu is the click: it selects the urgent mail, which (as in Attention) reads it
  const mail = attnRow(v.el, 'mail:' + urgent.id)!
  await rightClick(mail)
  await choose('Open')
  await settle()
  assert.equal(selected(v.el), 'mail:' + urgent.id, 'Open selects the mail')
  assert.deepEqual(state.reads, [urgent.id], 'opening reads it, exactly as a click does')
  await rightClick(attnRow(v.el, 'mail:' + urgent.id)!)
  assert.deepEqual(shape(), ['Close', 'Reply', 'Delete', 'sep', 'Copy message text', 'Copy reference'],
    'the opened (now read) mail: Close first and no Mark as read, as in the Inbox for a read mail')
  await closeMenu()
})

test('§1c each Attention entry does what the Inbox entry does: mark read, reply, copy, delete', async t => {
  localStorage.clear(); resetLocalReads(); resetSeenMentions()
  const { state, deletes } = installServer()
  const clip = stubClipboard()
  const confirm = W.confirm
  const asked: string[] = []
  W.confirm = (q?: string) => { asked.push(String(q)); return true }
  const v = await mountView(<AttentionDeselectFixture withQuestion marker={false} />, el => el)
  t.after(async () => { await v.unmount(); clip.restore(); W.confirm = confirm; resetLocalReads(); resetSeenMentions() })
  await settle()
  // Mark as read: the mail is read and, being unselected, leaves the list (Attention's read rule)
  await rightClick(attnRow(v.el, 'mail:' + remaining.id)!)
  await choose('Mark as read')
  await settle()
  assert.deepEqual(state.reads, [remaining.id], 'Mark as read posts the read for that mail only')
  assert.equal(attnRow(v.el, 'mail:' + remaining.id), null, 'the read, unselected mail leaves the Attention list')
  // Copy reference: the user box token, the one the Inbox copies
  await rightClick(attnRow(v.el, 'mail:' + urgent.id)!)
  await choose('Copy reference')
  await settle()
  assert.deepEqual(clip.writes, [attentionMailRef(org, urgent.id)], 'Copy reference copies the user box reference')
  // Copy message text
  await rightClick(attnRow(v.el, 'mail:' + urgent.id)!)
  await choose('Copy message text')
  await settle()
  assert.equal(clip.writes[1], urgent.body, 'Copy message text copies the message')
  // Reply: the mail opens and the caret lands in its reply box
  await rightClick(attnRow(v.el, 'mail:' + urgent.id)!)
  await choose('Reply')
  await settle()
  assert.equal(selected(v.el), 'mail:' + urgent.id, 'Reply opens the mail')
  const box = v.el.querySelector('.attn-mread .mail-reply textarea')
  assert.ok(box, 'the reading pane has its reply box')
  assert.equal(document.activeElement, box, 'the caret is in the reply box, as after the Inbox\'s Reply')
  // Delete: the Inbox's confirmation, then the user's copy is deleted and the mail leaves
  await rightClick(attnRow(v.el, 'mail:' + urgent.id)!)
  await choose('Delete')
  await settle()
  await repoll()
  assert.deepEqual(asked, ['Delete this message from your inbox? This permanently removes your copy.'],
    'the Inbox\'s confirmation, word for word')
  assert.deepEqual(deletes, [urgent.id], 'the user\'s copy is deleted through the Inbox\'s route')
  assert.equal(attnRow(v.el, 'mail:' + urgent.id), null, 'the deleted mail is no longer listed, even though it was selected')
  assert.equal(selected(v.el), 'question:question', 'the selection moves on, as when any selected row leaves Attention')
})

/* ─── §2 (#3) CONTROL: the rendered agent and project menus share one order ─────────────────── */

test('§2 CONTROL agent and project menus show Copy mention, Open, Focus, Hire, New project, Settings in one order', async () => {
  const seen: string[][] = []
  for (const kind of ['agent', 'project']) {
    const v = await mountView(<MenuFixture kind={kind} />, el => el)
    try {
      await rightClick(v.el.querySelector('[data-target]')!)
      const got = shape()
      assert.ok(got, `the ${kind} menu opened`)
      seen.push(got.filter(l => l !== 'sep').map(l => l.startsWith('Hire ') ? 'Hire' : l))
      await closeMenu()
    } finally { await v.unmount() }
  }
  assert.deepEqual(seen[0], ['Copy mention', 'Open', 'Focus', 'Hire', 'New project…', 'Settings'], 'the agent menu')
  assert.deepEqual(seen[1], seen[0], 'the project menu shows the same actions in the same order')
})

/* ─── §3 (#4) one Open order: Docket before Presentations, for agents and projects ───────────── */

const openKids = (entries: MenuEntry[]) => {
  const open = entries.find(e => e !== 'sep' && e.label === 'Open')
  assert.ok(open && open !== 'sep' && open.children, 'an Open submenu')
  return open.children.map(c => c === 'sep' ? 'sep' : c.label)
}
const both: AgentMenuHandlers = {
  onInbox: noop, onSettings: noop, onTeam: noop, onOpenDesk: noop, onOpenTemporary: noop, onPin: noop, onPopout: noop,
  onScratchFolder: noop, onDocket: noop, onPresentations: noop, onTeamPresentations: noop,
}
// a project's entries are the agent's, named for a project (PROJECT-NODES.md, Menus)
const asAgent: Record<string, string> = { 'Project mailbox': 'Mail', 'Team scratch folder': 'Scratch folder', 'Project docket': 'Docket' }

test('§3 inside Open, agents and projects list Docket before Presentations, in one shared order', () => {
  const agent = openKids(agentMenuEntries(node(false), both, {}))
  const project = openKids(projectMenuEntries(node(true), both, {}))
  assert.deepEqual(agent, ['Desk', 'Desk as a pinned window', 'Desk in a separate window', 'sep',
    'Mail', 'Team', 'Scratch folder', 'Docket', 'Presentations'], 'CONTROL: the agent\'s Open order (user 2026-10-07)')
  assert.ok(project.indexOf('Project docket') >= 0 && project.indexOf('Project docket') < project.indexOf('Presentations'),
    `a project lists Project docket before Presentations, as an agent does: ${JSON.stringify(project)}`)
  assert.deepEqual(project.map(l => asAgent[l] ?? l), agent, 'the same entries in the same order, named for a project')
})
