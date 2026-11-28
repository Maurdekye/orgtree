// mailboxviews.test.tsx — every mail link's menu can show the mail from both of its mailboxes (4.7.1).
//
// USER 2026-11-28 m598c1e427fb7 "all mail links for mail between agents or the org mailbox everywhere should have two
// links: "open in (recipient)'s inbox" and "open in (sender)'s outbox"", m997bcd184a94 "in their context menu",
// m9492a72e8259 "unless the mail link is already at one of those, in which case it should show just the other";
// m43242cb6f7cc wording "view in..."; mee49b81a285f the user's mail gets both plus "view in chat"; m740b4ab70ccc mail
// to or from an outside party: the local agent's box and the org mailbox; m82b4e67c4b03 "View in org inbox" /
// "View in org outbox". Docket mail-link-context-menus-open-in-recipient-s-inbo. One shared builder
// (canvas/mailboxviews.ts) behind every message menu: mail links (objectnavhost), mail rows (MailList) and the chats
// panel's bubbles.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs mailboxviews

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, flush } from './harness'
import { mailboxViewEntries, mailSides } from '../src/canvas/mailboxviews'
import type { MailboxSide, MailPlace } from '../src/canvas/mailboxviews'
import { mailMenuEntries } from '../src/canvas/mailidentity'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import type { MenuEntry, MenuItem } from '../src/canvas/contextmenu'
import { MailList } from '../src/canvas/mail'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import { CLASSIC_MAILBOX_KEY, VIEW_IN_CHAT, VIEW_IN_CLASSIC, classicMailbox, onMailViewRequest } from '../src/mailboxpref'

const labels = (entries: MenuEntry[]) => entries.map(e => (e === 'sep' ? '-' : e.label))
type Row = { from?: string; to?: string; _by?: string; _delivered?: string[] }
const build = (row: Row, holder: { box: 'user' | 'org' | 'node'; node?: string }, here: MailPlace | null = null,
  chat?: string) => {
  const opened: MailboxSide[] = []
  const entries = mailboxViewEntries({ row, holder, here, view: s => { opened.push(s) },
    chat: chat ? { peer: chat, open() {} } : undefined })
  return { entries, opened }
}

test('agent to agent: the recipient\'s inbox and the sender\'s outbox', () => {
  const { entries, opened } = build({ from: 'writer' }, { box: 'node', node: 'reader' })
  assert.deepEqual(labels(entries), ['View in @reader’s inbox', 'View in @writer’s outbox'])
  for (const e of entries) (e as MenuItem).onSelect()
  assert.deepEqual(opened, [{ box: 'node', node: 'reader', folder: 'inbox' }, { box: 'node', node: 'writer', folder: 'sent' }])
  // the sender's Sent row names its recipient in `to`
  assert.deepEqual(labels(build({ from: 'writer', to: 'reader' }, { box: 'node', node: 'writer' }).entries),
    ['View in @reader’s inbox', 'View in @writer’s outbox'])
})

test('already in one of the two: only the other', () => {
  const row = { from: 'writer', to: 'reader' }
  assert.deepEqual(labels(build(row, { box: 'node', node: 'reader' }, { box: 'node', node: 'reader', folder: 'inbox' }).entries),
    ['View in @writer’s outbox'])
  assert.deepEqual(labels(build(row, { box: 'node', node: 'writer' }, { box: 'node', node: 'writer', folder: 'sent' }).entries),
    ['View in @reader’s inbox'])
  // a third mailbox hides nothing
  assert.equal(build(row, { box: 'node', node: 'reader' }, { box: 'node', node: 'other', folder: 'inbox' }).entries.length, 2)
})

test('the user\'s mail: View in chat, then both mailboxes, the user\'s side as View in classic inbox (its inbox or outbox folder)', () => {
  assert.deepEqual(labels(build({ from: '@user', to: 'reader' }, { box: 'node', node: 'reader' }, null, 'reader').entries),
    [VIEW_IN_CHAT, 'View in @reader’s inbox', VIEW_IN_CLASSIC])
  assert.deepEqual(labels(build({ from: 'reader' }, { box: 'user' }, null, 'reader').entries),
    [VIEW_IN_CHAT, VIEW_IN_CLASSIC, 'View in @reader’s outbox'])
  // the engine's shape for the user's mail in an agent's inbox: no `to`, the box is its recipient
  assert.deepEqual(labels(build({ from: '@user' }, { box: 'node', node: 'reader' }, null, 'reader').entries),
    [VIEW_IN_CHAT, 'View in @reader’s inbox', VIEW_IN_CLASSIC])
  // in that chat: no View in chat; in the classic inbox: no View in classic inbox
  assert.deepEqual(labels(build({ from: 'reader' }, { box: 'user' }, { chat: 'reader' }, 'reader').entries),
    [VIEW_IN_CLASSIC, 'View in @reader’s outbox'])
  assert.deepEqual(labels(build({ from: 'reader' }, { box: 'user' }, { box: 'user', folder: 'inbox' }, 'reader').entries),
    [VIEW_IN_CHAT, 'View in @reader’s outbox'])
})

test('outside parties: the local agent\'s mailbox and the org mailbox', () => {
  // incoming: delivered to an agent; the org mailbox received it
  assert.deepEqual(labels(build({ from: '@net:someone.abc', _delivered: ['reader'] }, { box: 'org' }).entries),
    ['View in @reader’s inbox', 'View in org inbox'])
  assert.deepEqual(labels(build({ from: '@net:someone.abc' }, { box: 'node', node: 'reader' }).entries),
    ['View in @reader’s inbox', 'View in org inbox'])
  // outgoing: the agent sent it; the org mailbox sent it on
  assert.deepEqual(labels(build({ from: 'writer', to: '@org:elsewhere' }, { box: 'node', node: 'writer' }).entries),
    ['View in org outbox', 'View in @writer’s outbox'])
  assert.deepEqual(labels(build({ from: '@org:mine', _by: 'writer', to: '@net:x.y' }, { box: 'org' }).entries),
    ['View in org outbox', 'View in @writer’s outbox'])
  // already in the org mailbox's inbox
  assert.deepEqual(labels(build({ from: '@net:someone.abc', _delivered: ['reader'] }, { box: 'org' },
    { box: 'org', folder: 'inbox' }).entries), ['View in @reader’s inbox'])
  // Orgtree's own mail has no sender side
  assert.deepEqual(labels(build({ from: '@system' }, { box: 'node', node: 'reader' }).entries), ['View in @reader’s inbox'])
})

test('several recipients: one entry each, in order; more than three in one submenu', () => {
  assert.deepEqual(labels(build({ from: '@net:a.b', _delivered: ['r1', 'r2', 'r3'] }, { box: 'org' }).entries),
    ['View in @r1’s inbox', 'View in @r2’s inbox', 'View in @r3’s inbox', 'View in org inbox'])
  const { entries } = build({ from: '@net:a.b', _delivered: ['r1', 'r2', 'r3', 'r4'] }, { box: 'org' })
  assert.deepEqual(labels(entries), ['View in a recipient’s inbox', 'View in org inbox'])
  const { children: sub = [] } = entries[0] as MenuItem
  assert.deepEqual(labels(sub),
    ['View in @r1’s inbox', 'View in @r2’s inbox', 'View in @r3’s inbox', 'View in @r4’s inbox'])
})

test('transcripts: the sender\'s always, each recipient\'s once it read the mail; agents only', () => {
  const opened: string[] = []
  const views = (row: Record<string, unknown>, holder: { box: 'user' | 'org' | 'node'; node?: string }, here: MailPlace | null = null) =>
    labels(mailboxViewEntries({ row, holder, here, view() {},
      transcript: { has: n => n !== 'proj', open: n => { opened.push(n) } } }))
  assert.deepEqual(views({ from: 'writer', delivered: true }, { box: 'node', node: 'reader' }),
    ['View in @reader’s inbox', 'View in @writer’s outbox', 'View in @writer’s transcript', 'View in @reader’s transcript'])
  assert.deepEqual(views({ from: 'writer', delivered: false }, { box: 'node', node: 'reader' }).filter(l => l.endsWith('transcript')),
    ['View in @writer’s transcript'], 'unread: the sender\'s only')
  assert.deepEqual(views({ from: 'writer', _wait: true }, { box: 'node', node: 'reader' }).filter(l => l.endsWith('transcript')),
    ['View in @writer’s transcript'], 'still waiting in the box: unread')
  assert.deepEqual(views({ from: '@user', to: 'reader', delivered: true }, { box: 'user' }).filter(l => l.endsWith('transcript')),
    ['View in @reader’s transcript'], 'the user has no transcript')
  assert.deepEqual(views({ from: 'writer', to: 'proj', delivered: true }, { box: 'node', node: 'writer' }).filter(l => l.endsWith('transcript')),
    ['View in @writer’s transcript'], 'a project has no transcript')
  assert.deepEqual(views({ from: 'writer', delivered: true }, { box: 'node', node: 'reader' }, { transcript: 'writer' }).filter(l => l.endsWith('transcript')),
    ['View in @reader’s transcript'], 'already in the writer\'s transcript')
})

test('mailSides names each side once', () => {
  assert.deepEqual(mailSides({ from: 'writer', to: 'reader' }, { box: 'node', node: 'reader' }),
    { sender: { box: 'node', node: 'writer', folder: 'sent' }, recipients: [{ box: 'node', node: 'reader', folder: 'inbox' }] })
})

test('the group order: View in chat, View in classic inbox, the other mailboxes, the transcripts', () => {
  const item = (label: string): MenuEntry => ({ label, onSelect() {} })
  const views = build({ from: '@user', to: 'reader' }, { box: 'node', node: 'reader' }, null, 'reader').entries
  const leading = [item('Open'), item('View in transcript'), ...views]
  assert.deepEqual(labels(mailMenuEntries({ leading, copy() {}, canCopy: true })),
    ['Open', '-', VIEW_IN_CHAT, VIEW_IN_CLASSIC, 'View in @reader’s inbox', 'View in transcript', '-', 'Copy message text'],
    'View in chat, View in classic inbox, the other mailboxes, then the transcripts')
})

// ---- surfaces ----

const menuLabels = () => [...document.querySelectorAll('.ctxmenu:not(.ctxmenu-submenu) > .ctxmenu-branch > [role="menuitem"]')]
  .map(el => el.textContent!.trim())
async function right(el: Element) {
  await inAct(() => el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
  await flush(4)
}
async function choose(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('.ctxmenu [role="menuitem"]')].find(el => el.textContent?.trim() === label)
  assert.ok(item, `${label} is in the menu (${menuLabels()})`)
  await inAct(() => item!.click()); await flush(4)
}
async function dismiss() {
  await inAct(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await flush(2)
}
function asked(t: TestContext) {
  const requests: { id: string; classic: boolean }[] = []
  const off = onMailViewRequest((_org, id) => { requests.push({ id, classic: classicMailbox() }) })
  t.after(() => { off(); window.localStorage.removeItem(CLASSIC_MAILBOX_KEY) })
  return requests
}

test('a mail link between agents: both mailboxes, each through the open-mail route to that box', async (t) => {
  const saved = fetch
  const mail = { id: 'mm1', at: '2026-11-20T10:00:00Z', kind: 'message', body: 'the body', from: 'writer' }
  globalThis.fetch = (async () => new Response(JSON.stringify({ found: true, mail }), { status: 200 })) as typeof fetch
  t.after(() => { globalThis.fetch = saved })
  const opened: { id?: string | null; to?: string | null }[] = []
  const world = { org: 'org', agents: new Map([['reader', 'reader'], ['writer', 'writer']]) }
  const v = await mountView(<ObjectNavProvider><ObjectNavHost org="org" dogs={[]} openDog={() => {}} toast={() => {}}
    openMail={m => { opened.push(m) }} />
    <ObjectMenuBoundary>
      <RefChip r={resolveRef({ kind: 'mail', org: 'org', box: 'node', node: 'reader', id: 'mm1' }, world)} onOpen={() => {}} />
    </ObjectMenuBoundary></ObjectNavProvider>, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(4) })
  const chip = v.el.querySelector('.ref-mail')!
  await right(chip)
  assert.deepEqual(menuLabels().slice(0, 2), ['View in @reader’s inbox', 'View in @writer’s outbox'],
    'the group takes the generic Open\'s place (USER mde95b23fb23d)')
  assert.equal(menuLabels().includes('Open'), false)
  await choose('View in @writer’s outbox')
  await right(chip)
  await choose('View in @reader’s inbox')
  assert.deepEqual(opened, [{ id: 'mm1', to: 'writer' }, { id: 'mm1', to: 'reader' }])
})

test('a mail link to the user\'s mail: View in chat, View in classic inbox and the agent\'s outbox', async (t) => {
  const requests = asked(t)
  const saved = fetch
  const mail = { id: 'mm2', at: '2026-11-20T10:00:00Z', kind: 'message', body: 'the body', from: 'reader' }
  globalThis.fetch = (async () => new Response(JSON.stringify({ found: true, mail }), { status: 200 })) as typeof fetch
  t.after(() => { globalThis.fetch = saved })
  const world = { org: 'org', agents: new Map([['reader', 'reader']]) }
  const v = await mountView(<ObjectNavProvider><ObjectNavHost org="org" dogs={[]} openDog={() => {}} toast={() => {}} openMail={() => {}} />
    <ObjectMenuBoundary>
      <RefChip r={resolveRef({ kind: 'mail', org: 'org', box: 'user', id: 'mm2' }, world)} onOpen={() => {}} />
    </ObjectMenuBoundary></ObjectNavProvider>, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(4) })
  await right(v.el.querySelector('.ref-mail')!)
  assert.deepEqual(menuLabels().slice(0, 3), [VIEW_IN_CHAT, VIEW_IN_CLASSIC, 'View in @reader’s outbox'])
  await choose(VIEW_IN_CLASSIC)
  assert.deepEqual(requests, [{ id: 'mm2', classic: true }], 'the classic mailbox, on that mail')
})

test('mail rows in an agent\'s mailbox: an inbox row offers the sender\'s outbox, a Sent row the recipient\'s inbox', async (t) => {
  const inbox = [{ id: 'i1', from: 'writer', at: '2026-11-20T10:00:00Z', kind: 'message', body: 'received one' }]
  const opened: unknown[] = []
  const refs = { world: { org: 'mine', agents: new Map([['reader', 'reader'], ['writer', 'writer']]) }, onOpen: (r: { ref: unknown }) => { opened.push(r.ref) } }
  const v = await mountView(<ObjectMenuBoundary><MailList org="mine" boxOwner="reader" delivered={inbox} refs={refs as never} toast={() => {}} /></ObjectMenuBoundary>, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(4) })
  await right(v.el.querySelector('.mailrow')!)
  assert.equal(menuLabels().includes('View in @writer’s outbox'), true, `${menuLabels()}`)
  assert.equal(menuLabels().includes('View in @reader’s inbox'), false, 'already there')
  await choose('View in @writer’s outbox')
  assert.deepEqual(opened, [{ kind: 'mail', org: 'mine', box: 'node', node: 'writer', id: 'i1' }], "the writer's mailbox, at that mail")
  const sent = [{ id: 's1', from: 'reader', to: 'writer', at: '2026-11-20T10:00:00Z', kind: 'message', body: 'sent one' }]
  const w = await mountView(<ObjectMenuBoundary><MailList org="mine" boxOwner="reader" outgoing delivered={sent} refs={refs as never} toast={() => {}} /></ObjectMenuBoundary>, el => el)
  t.after(() => w.unmount())
  await inAct(async () => { await flush(4) })
  await right(w.el.querySelector('.mailrow')!)
  assert.equal(menuLabels().includes('View in @writer’s inbox'), true, `${menuLabels()}`)
  assert.equal(menuLabels().includes('View in @reader’s outbox'), false, 'already there')
  await dismiss()
  // a list with no route to another mailbox offers none (the Attention-shaped control in symmetrymenus)
  const x = await mountView(<ObjectMenuBoundary><MailList org="mine" boxOwner="reader" delivered={inbox} toast={() => {}} /></ObjectMenuBoundary>, el => el)
  t.after(() => x.unmount())
  await inAct(async () => { await flush(4) })
  await right(x.el.querySelector('.mailrow')!)
  assert.equal(menuLabels().some(l => l.endsWith('box')), false, `${menuLabels()}`)
})
