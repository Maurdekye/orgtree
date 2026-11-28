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
import { InboxView, MailList } from '../src/canvas/mail'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import { CLASSIC_MAILBOX_KEY, VIEW_IN_CHAT, VIEW_IN_CLASSIC, classicMailbox, onMailViewRequest } from '../src/mailboxpref'

const labels = (entries: MenuEntry[]) => entries.map(e => (e === 'sep' ? '-' : e.label))
type Row = Record<string, unknown>
const build = (row: Row, holder: { box: 'user' | 'org' | 'node'; node?: string }, here: MailPlace | null = null,
  chat?: string) => {
  const opened: MailboxSide[] = []
  const entries = mailboxViewEntries({ row: { id: 'm1', ...row }, holder, here, view: s => { opened.push(s) },
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
  assert.deepEqual(labels(build({ from: '@net:someone.abc', _delivered: ['reader'], copies: [{ agent: 'reader', id: 'c1' }] }, { box: 'org' }).entries),
    ['View in @reader’s inbox', 'View in org inbox'])
  assert.deepEqual(labels(build({ from: '@net:someone.abc', org_row: 'o1' }, { box: 'node', node: 'reader' }).entries),
    ['View in @reader’s inbox', 'View in org inbox'])
  // outgoing: the agent sent it; the org mailbox sent it on
  // outgoing: the org mailbox's row, which the agent's Sent lists as it is
  assert.deepEqual(labels(build({ from: '@org:mine', _by: 'writer', to: '@net:x.y' }, { box: 'org' }).entries),
    ['View in org outbox', 'View in @writer’s outbox'])
  // already in the org mailbox's inbox
  assert.deepEqual(labels(build({ from: '@net:someone.abc', _delivered: ['reader'], copies: [{ agent: 'reader', id: 'c1' }] }, { box: 'org' },
    { box: 'org', folder: 'inbox' }).entries), ['View in @reader’s inbox'])
  // Orgtree's own mail has no sender side
  assert.deepEqual(labels(build({ from: '@system' }, { box: 'node', node: 'reader' }).entries), ['View in @reader’s inbox'])
})

test('several recipients: one entry each, in order; more than three in one submenu', () => {
  const cs = (n: number) => Array.from({ length: n }, (_, i) => ({ agent: `r${i + 1}`, id: `c${i + 1}` }))
  assert.deepEqual(labels(build({ from: '@net:a.b', _delivered: ['r1', 'r2', 'r3'], copies: cs(3) }, { box: 'org' }).entries),
    ['View in @r1’s inbox', 'View in @r2’s inbox', 'View in @r3’s inbox', 'View in org inbox'])
  const { entries } = build({ from: '@net:a.b', _delivered: ['r1', 'r2', 'r3', 'r4'], copies: cs(4) }, { box: 'org' })
  assert.deepEqual(labels(entries), ['View in a recipient’s inbox', 'View in org inbox'])
  const { children: sub = [] } = entries[0] as MenuItem
  assert.deepEqual(labels(sub),
    ['View in @r1’s inbox', 'View in @r2’s inbox', 'View in @r3’s inbox', 'View in @r4’s inbox'])
})

test('transcripts: the sender\'s always, each recipient\'s once it read the mail; agents only', () => {
  const opened: string[] = []
  const views = (row: Record<string, unknown>, holder: { box: 'user' | 'org' | 'node'; node?: string }, here: MailPlace | null = null) =>
    labels(mailboxViewEntries({ row: { id: 'm1', ...row }, holder, here, view() {},
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

// ---- bounce m782724ff17a3: every shape the boxes give, and each place at its own copy ----

test('the org mailbox row read by id (dir, peer, by, delivered_to): incoming opens each holder at its own copy', () => {
  const opened: [MailboxSide, string][] = []
  const view = (side: MailboxSide, id: string) => { opened.push([side, id]) }
  const row = { id: 'org-in', dir: 'in', peer: '@net:external.demo', delivered_to: ['reader'], copies: [{ agent: 'reader', id: 'copy-r' }] }
  const entries = mailboxViewEntries({ row, holder: { box: 'org' }, view })
  assert.deepEqual(labels(entries), ['View in @reader’s inbox', 'View in org inbox'])
  for (const e of entries) (e as MenuItem).onSelect()
  assert.deepEqual(opened, [[{ box: 'node', node: 'reader', folder: 'inbox' }, 'copy-r'], [{ box: 'org', folder: 'inbox' }, 'org-in']],
    'the agent at its copy, the org mailbox at its row')
  // the holder read its copy: its transcript, at that copy (rig-sol-b m54a67753d15a); unread: none
  const seen: [string, string][] = []
  const transcript = { has: () => true, open: (n: string, id: string) => { seen.push([n, id]) } }
  const read = mailboxViewEntries({ row: { ...row, copies: [{ agent: 'reader', id: 'copy-r', read: true }] }, holder: { box: 'org' }, view, transcript })
  assert.deepEqual(labels(read), ['View in @reader’s inbox', 'View in org inbox', 'View in @reader’s transcript'])
  ;(read[2] as MenuItem).onSelect()
  assert.deepEqual(seen, [['reader', 'copy-r']])
  assert.deepEqual(labels(mailboxViewEntries({ row: { ...row, copies: [{ agent: 'reader', id: 'copy-r', read: false }] }, holder: { box: 'org' }, view, transcript })),
    ['View in @reader’s inbox', 'View in org inbox'])
  // a copy made before the link (none found): no entry for that agent
  assert.deepEqual(labels(mailboxViewEntries({ row: { ...row, copies: [] }, holder: { box: 'org' }, view })), ['View in org inbox'])
})

test('the org mailbox row read by id: outgoing is the org outbox, the sender\'s outbox at the same row, and its transcript', () => {
  // an agent's mail to an outside party is in its Sent as the org mailbox's own row (USER 2026-11-28 m3b0568389632)
  const row = { id: 'org-out', dir: 'out', peer: '@net:external.demo', by: 'writer' }
  const opened: [string, string][] = []
  const entries = mailboxViewEntries({ row, holder: { box: 'org' }, view: (s, id) => { opened.push([s.box + ':' + (s.node ?? ''), id]) },
    transcript: { has: () => true, open: (n, id) => { opened.push(['transcript:' + n, id]) } } })
  assert.deepEqual(labels(entries), ['View in org outbox', 'View in @writer’s outbox', 'View in @writer’s transcript'])
  for (const e of entries) (e as MenuItem).onSelect()
  assert.deepEqual(opened, [['org:', 'org-out'], ['node:writer', 'org-out'], ['transcript:writer', 'org-out']],
    'one id in all three: the agent\'s Sent lists the org row itself, and its send call names it')
})

test('that mail in the agent\'s own Sent: View in org outbox at the same row', () => {
  const opened: [MailboxSide, string][] = []
  const row = { id: 'org-out', from: 'writer', to: '@net:external.demo', org_row: 'org-out' }
  const entries = mailboxViewEntries({ row, holder: { box: 'node', node: 'writer' }, here: { box: 'node', node: 'writer', folder: 'sent' },
    view: (s, id) => { opened.push([s, id]) } })
  assert.deepEqual(labels(entries), ['View in org outbox'])
  ;(entries[0] as MenuItem).onSelect()
  assert.deepEqual(opened, [[{ box: 'org', folder: 'sent' }, 'org-out']])
})

test('a listed org row (to repeats the peer, _delivered): the holder\'s inbox, its copy read on choosing', async () => {
  const opened: [MailboxSide, string][] = []
  let missing = 0
  const row = { id: 'org-row', from: '@net:external.demo', to: '@net:external.demo', _delivered: ['reader'] }
  const make = (copies: { agent: string; id: string }[], here: MailPlace | null = null) => mailboxViewEntries({ row, holder: { box: 'org' }, here,
    view: (s, id) => { opened.push([s, id]) }, lookupCopies: async () => copies, missing: () => { missing++ } })
  assert.deepEqual(labels(make([])), ['View in @reader’s inbox', 'View in org inbox'], 'never View in org outbox')
  assert.deepEqual(labels(make([], { box: 'org', folder: 'inbox' })), ['View in @reader’s inbox'], 'already in the org inbox')
  ;(make([{ agent: 'reader', id: 'copy-r' }])[0] as MenuItem).onSelect()
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(opened, [[{ box: 'node', node: 'reader', folder: 'inbox' }, 'copy-r']])
  ;(make([])[0] as MenuItem).onSelect()
  await new Promise(r => setTimeout(r, 0))
  assert.equal(missing, 1, 'an older copy says so')
})

test('a holder\'s copy of outside mail opens the org inbox at its row (org_row); without one, no org entry', () => {
  const opened: [MailboxSide, string][] = []
  const view = (s: MailboxSide, id: string) => { opened.push([s, id]) }
  const entries = mailboxViewEntries({ row: { id: 'copy-r', from: '@net:external.demo', org_row: 'org-in' }, holder: { box: 'node', node: 'reader' }, view })
  assert.deepEqual(labels(entries), ['View in @reader’s inbox', 'View in org inbox'])
  ;(entries[1] as MenuItem).onSelect()
  assert.deepEqual(opened, [[{ box: 'org', folder: 'inbox' }, 'org-in']])
  assert.deepEqual(labels(mailboxViewEntries({ row: { id: 'copy-r', from: '@net:external.demo' }, holder: { box: 'node', node: 'reader' }, view })),
    ['View in @reader’s inbox'])
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

test('a link to the user\'s own sent mail (the user box read by id names its recipient): chat, the agent\'s inbox, classic', async (t) => {
  const saved = fetch
  const mail = { id: 'user-sent', at: '2026-11-20T10:00:00Z', kind: 'message', body: 'the body', from: '@user', to: 'reader', delivered: true, unread: false }
  globalThis.fetch = (async () => new Response(JSON.stringify({ found: true, mail }), { status: 200 })) as typeof fetch
  t.after(() => { globalThis.fetch = saved })
  const world = { org: 'org', agents: new Map([['reader', 'reader']]) }
  const v = await mountView(<ObjectNavProvider><ObjectNavHost org="org" dogs={[]} openDog={() => {}} toast={() => {}} openMail={() => {}} />
    <ObjectMenuBoundary>
      <RefChip r={resolveRef({ kind: 'mail', org: 'org', box: 'user', id: 'user-sent' }, world)} onOpen={() => {}} />
    </ObjectMenuBoundary></ObjectNavProvider>, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(4) })
  await right(v.el.querySelector('.ref-mail')!)
  assert.deepEqual(menuLabels().slice(0, 3), [VIEW_IN_CHAT, VIEW_IN_CLASSIC, 'View in @reader’s inbox'])
})

test('an agent mailbox asked for an older mail it SENT opens on Sent, not Inbox (the exact read answers for sent mail too)', async (t) => {
  const saved = fetch
  const old = { id: 'old-sent', from: 'me', to: 'other', at: '2026-10-01T10:00:00Z', kind: 'message', body: 'an old one' }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('/mail/node/old-sent') ? { found: true, mail: old } : url.includes('/inbox') ? { pending: [], delivered: [], sent: [] } : {}
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = saved })
  const v = await mountView(<InboxView slug="org" nid="me" tier={null} jumpTo="old-sent" jumpSeq={1} />, el => el)
  t.after(() => v.unmount())
  for (let i = 0; i < 20 && !v.el.querySelector('.mail-folders button.on'); i++) await inAct(async () => { await flush(4) })
  await inAct(async () => { await flush(8) })
  assert.equal(v.el.querySelector('.mail-folders button.on')?.textContent?.trim(), 'sent', v.el.querySelector('.mail-folders')?.textContent ?? '(no folders)')
})

test('your own mail to an outside party (the org row\'s by is "user"): no sender entry and no transcript, only the org outbox', () => {
  // USER via @coordinator-opus m304bad3acdc4: the user has no mailbox copy of it (no ot.mail row; chats hold none)
  const view = () => {}
  const transcript = { has: () => true, open: () => {} }
  const byId = { id: 'o9', dir: 'out', peer: '@net:external.demo', by: 'user' }
  assert.deepEqual(labels(mailboxViewEntries({ row: byId, holder: { box: 'org' }, view, transcript })), ['View in org outbox'])
  const listed = { id: 'o9', from: '@net:external.demo', to: '@net:external.demo', _by: 'user' }
  assert.deepEqual(labels(mailboxViewEntries({ row: listed, holder: { box: 'org' }, here: { box: 'org', folder: 'sent' }, view, transcript })), [],
    'on its own org outbox row nothing is left')
  assert.deepEqual(labels(mailboxViewEntries({ row: listed, holder: { box: 'org' }, view, transcript })), ['View in org outbox'])
  assert.deepEqual(mailSides(listed, { box: 'org' }).sender, null)
})

test('more than three recipients\' transcripts go in one submenu, as their inboxes do; three stay flat', () => {
  // USER 2026-11-28 mcc3039b5cc7c (deck slide 37), via @coordinator-opus m58b801835f42
  const cs = (n: number) => Array.from({ length: n }, (_, i) => ({ agent: `r${i + 1}`, id: `c${i + 1}`, read: true }))
  const row = (n: number) => ({ id: 'o4', dir: 'in', peer: '@net:a.b', delivered_to: cs(n).map(c => c.agent), copies: cs(n) })
  const transcript = { has: () => true, open: () => {} }
  const four = mailboxViewEntries({ row: row(4), holder: { box: 'org' }, view: () => {}, transcript })
  const sub = four.find(e => e.label === 'View in a recipient’s transcript')
  assert.deepEqual(sub?.children?.map(c => c === 'sep' ? '-' : c.label), ['r1', 'r2', 'r3', 'r4'].map(n => `View in @${n}’s transcript`))
  assert.equal(four.filter(e => /^View in @r\d’s transcript$/.test(e.label)).length, 0, 'none flat')
  assert.deepEqual(labels(mailMenuEntries({ leading: four, copy: () => {}, canCopy: true })),
    ['View in a recipient’s inbox', 'View in org inbox', 'View in a recipient’s transcript', '-', 'Copy message text'], 'in the transcripts\' place')
  const three = mailboxViewEntries({ row: row(3), holder: { box: 'org' }, view: () => {}, transcript })
  assert.deepEqual(labels(three).filter(l => l.endsWith('transcript')), ['r1', 'r2', 'r3'].map(n => `View in @${n}’s transcript`))
})

test('org mailbox rows offer transcripts as a link to the same mail does: the sender\'s on an outbox row, a reader\'s once it read its copy', async (t) => {
  // @coordinator-opus m304bad3acdc4 (finding 1 of the deck): the org lists get the desk route, and an inbound row reads
  // its copies (with read) when its menu opens
  const saved = fetch
  let read = true
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('/mail/org/in-1') ? { found: true, mail: { id: 'in-1', dir: 'in', peer: '@net:alice.fixture', body: 'Hello org',
      at: '2026-10-18T12:00:00Z', delivered_to: ['reader'], copies: [{ agent: 'reader', id: 'copy-1', read }] } } : {}
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = saved })
  const map = new Map([['reader', { id: 'reader', tier: 'opus', state: 'live' }], ['writer', { id: 'writer', tier: 'opus', state: 'live' }]])
  const entries = [{ id: 'in-1', dir: 'in', peer: '@net:alice.fixture', body: 'Hello org', at: '2026-10-18T12:00:00Z', delivered_to: ['reader'] },
    { id: 'out-1', dir: 'out', peer: '@net:peer.fixture', by: 'writer', body: 'Outbox body', at: '2026-10-18T12:05:00Z', state: 'read' }]
  const focus: string[] = []
  const { OrgInboxModal } = await import('../src/canvas/mail')
  const v = await mountView(<ObjectMenuBoundary><OrgInboxModal slug="fixture" inbox={{ entries, total: entries.length, unread: 0, visible: true, holders: [] } as never}
    map={map as never} onFocusAgent={(id: string) => { focus.push(id) }} toast={() => {}} close={() => {}} /></ObjectMenuBoundary>, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(5) })
  await right(v.el.querySelector('.mailrow')!)
  await inAct(async () => { await flush(6) })
  assert.equal(menuLabels().includes('View in @reader’s transcript'), true, `a read copy: ${menuLabels()}`)
  await choose('View in @reader’s transcript')
  assert.deepEqual(focus, ['reader'])
  read = false
  await right(v.el.querySelector('.mailrow')!)
  await inAct(async () => { await flush(6) })
  assert.equal(menuLabels().some(l => l.endsWith('transcript')), false, `an unread copy: ${menuLabels()}`)
  await dismiss()
  const sentTab = [...v.el.querySelectorAll('button')].find(b => b.textContent?.trim() === 'sent')!
  await inAct(async () => { (sentTab as HTMLButtonElement).click(); await flush(4) })
  await right(v.el.querySelector('.mailrow')!)
  assert.equal(menuLabels().includes('View in @writer’s transcript'), true, `the outbox row: ${menuLabels()}`)
})

test('a retired agent (not on the canvas): no entry for its mailbox, which does not open, and none for its transcript', async (t) => {
  // @coordinator-opus m304bad3acdc4 "keep the retired-agent entries if the mailbox opens": the canvas's mail router opens
  // only its own nodes' mailboxes (OrgCanvas openMailRef), so a retired agent's entries would do nothing
  const view = () => {}
  const live = new Set(['writer', 'reader'])
  const row = { id: 'mR', from: 'gone', to: 'reader', delivered: true }
  assert.deepEqual(labels(mailboxViewEntries({ row, holder: { box: 'node', node: 'reader' }, view, mailbox: { has: n => live.has(n) },
    transcript: { has: n => live.has(n), open: () => {} } })), ['View in @reader’s inbox', 'View in @reader’s transcript'])
  // the classic inbox: its sender's outbox and transcript, gone for a retired sender; projects have no transcript
  const nodeKind = (id: string) => id === 'writer' ? 'agent' as const : id === 'desk' ? 'project' as const : undefined
  const rows = [{ id: 'u1', from: 'writer', at: '2026-11-20T10:00:00Z', kind: 'message', body: 'from writer' }]
  const refs = { world: { org: 'mine', agents: new Map([['writer', 'writer']]) }, onOpen: () => {} }
  const open = async (list: typeof rows) => {
    const v = await mountView(<ObjectMenuBoundary><MailList userBox org="mine" delivered={list} refs={refs as never} toast={() => {}}
      onFocusAgent={() => {}} nodeKind={nodeKind} /></ObjectMenuBoundary>, el => el)
    t.after(() => v.unmount())
    await inAct(async () => { await flush(4) })
    await right(v.el.querySelector('.mailrow')!)
    const got = menuLabels(); await dismiss(); return got
  }
  const a = await open(rows)
  assert.equal(a.includes('View in @writer’s transcript'), true, `the classic inbox offers the sender's transcript: ${a}`)
  assert.equal(a.includes('View in @writer’s outbox'), true, `${a}`)
  const b = await open([{ ...rows[0], from: 'gone' }])
  assert.equal(b.some(l => l.includes('@gone')), false, `a retired sender: ${b}`)
  const c = await open([{ ...rows[0], from: 'desk' }])
  assert.equal(c.includes('View in @desk’s outbox'), true, `${c}`)
  assert.equal(c.includes('View in @desk’s transcript'), false, `a project has no transcript: ${c}`)
})

test('a link names no retired agent\'s mailbox or transcript where its host knows the canvas (isNode)', async (t) => {
  const saved = fetch
  const mail = { id: 'mR', at: '2026-11-20T10:00:00Z', kind: 'message', body: 'b', from: 'writer', to: 'gone', delivered: true }
  globalThis.fetch = (async () => new Response(JSON.stringify({ found: true, mail }), { status: 200 })) as typeof fetch
  t.after(() => { globalThis.fetch = saved })
  const world = { org: 'org', agents: new Map([['writer', 'writer'], ['gone', 'gone']]) }
  const v = await mountView(<ObjectNavProvider><ObjectNavHost org="org" dogs={[]} openDog={() => {}} toast={() => {}} openMail={() => {}}
    focusAgent={() => {}} isNode={id => id === 'writer'} />
    <ObjectMenuBoundary>
      <RefChip r={resolveRef({ kind: 'mail', org: 'org', box: 'node', node: 'gone', id: 'mR' }, world)} onOpen={() => {}} />
    </ObjectMenuBoundary></ObjectNavProvider>, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(4) })
  await right(v.el.querySelector('.ref-mail')!)
  assert.deepEqual(menuLabels().filter(l => l.startsWith('View in')), ['View in @writer’s outbox', 'View in @writer’s transcript'])
})
