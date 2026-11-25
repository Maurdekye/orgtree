// inboxopenchat.test.tsx — "Open chat" on every agent and project link in the
// inbox, granting a user audience first when the target has none (USER
// 2026-11-25 14:24:01Z ma84dfc37f5a6: "actually add an open chat context menu
// entry to every agent / project link in the inbox context; if they don't have
// an audience, grant one before opening the chat. state that opening the chat
// grants an audience in the hover tooltip. clicking still focuses if they don't
// already have a chat open."; docket inbox-links-open-chat-on-every-agent-project-lin).
//
// WIDENED (USER 14:33:44Z m0a8fdb69edb9 "make it a universal entry in every
// agent's context menu"; 14:33:50Z m6da526799148 "everywhere throughout the
// app"; 14:34:30Z m46b47955f2ac: a classic mailbox switches to the chats first,
// and the tooltip lists exactly the changes): every live agent and project menu.
// The grant is the inbox's own New chat path (DmPanel startChat); its tests are
// in dmpanel.test.tsx; the canvas row and card wiring in agentrowmenu.test.tsx.
//
// MOVED INTO OPEN (USER 21:32:43Z m05fbc02357a7 "open chat should be in the
// open submenu everywhere in an agent's co text menu"): no top-level Open chat
// in a menu with an Open submenu; it merges with Open > Chat, one entry
// labelled "Chat" with this behaviour and tooltip.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs inboxopenchat

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import { useContextMenu } from '../src/canvas/contextmenu'
import * as pref from '../src/mailboxpref'
import { CLASSIC_MAILBOX_KEY, onChatRequest } from '../src/mailboxpref'
import type { CanvasNode } from '../src/canvas/shared'
import type { MenuEntry } from '../src/canvas/contextmenu'

const USER = '@user'
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, tier: 'opus', state: 'live', seat: 1, grant: 0, free: 0,
  children: [], audiences_held: [], scope: { tools: {}, add_dirs: [] }, ...extra }) as unknown as CanvasNode
// the canvas map: flatten() gives every card its parent, and the top-level cards the eye root (`@user`, state 'user')
const EYE = node(USER, { tier: null, state: 'user', parent: null })
const LEAD = node('lead', { parent: USER })
const PLAIN = node('plain', { parent: 'lead' })
const OWN = node('own', { parent: 'lead', audiences_held: [USER], audiences_explicit: [USER] })
const CREW = node('crew', { kind: 'project', tier: null, parent: 'lead' })
const HELD = node('held', { kind: 'project', tier: null, parent: 'lead', audiences_held: [USER], audiences_explicit: [USER] })
const MATE = node('mate', { parent: 'crew' })
const TOPCREW = node('topcrew', { kind: 'project', tier: null, parent: USER })
const UNDERTOP = node('undertop', { parent: 'topcrew' })
const GONE = node('gone', { parent: 'lead', state: 'archived' })
const nodes = new Map([EYE, LEAD, PLAIN, OWN, CREW, HELD, MATE, TOPCREW, UNDERTOP, GONE].map(n => [n.id, n]))

const top = (entries: MenuEntry[]) => entries.map(e => (e === 'sep' ? '-' : e.label))
const entry = (entries: MenuEntry[], label: string) => {
  const e = entries.find(x => x !== 'sep' && x.label === label)
  return e && e !== 'sep' ? e : null
}
const H = { onInbox() {}, onOpenDesk() {}, onSettings() {} } as never
// Open > Chat, the one chat entry (USER m05fbc02357a7)
const chatIn = (entries: MenuEntry[]) => {
  const open = entry(entries, 'Open')
  const kids = (open?.children ?? []).filter(e => e !== 'sep' && e.label === 'Chat')
  assert.ok(kids.length <= 1, 'one Chat entry in Open, no duplicate')
  const k = kids[0]
  return k && k !== 'sep' ? k : null
}
const GRANTS = /opening it grants .* an audience with you/i

test('every live agent and project is a chat target; it needs a grant unless it can already write to the user', t => {
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  t.after(() => window.localStorage.removeItem(CLASSIC_MAILBOX_KEY))
  assert.equal(typeof pref.chatTargetFor, 'function', 'mailboxpref exports chatTargetFor')
  const at = (n: CanvasNode) => pref.chatTargetFor(nodes, n)
  assert.deepEqual(at(PLAIN), { needsGrant: true }, 'an agent with no audience: the chat grants one')
  assert.deepEqual(at(CREW), { needsGrant: true }, 'a project with no audience too')
  assert.deepEqual(at(OWN), { needsGrant: false }, 'its own audience')
  assert.deepEqual(at(HELD), { needsGrant: false }, 'a project holding one')
  assert.deepEqual(at(node('member', { parent: 'held', audiences_held: [USER] })), { needsGrant: false },
    'an audience through its project (the tree lists it in audiences_held)')
  assert.deepEqual(at(LEAD), { needsGrant: false }, 'a top-level agent writes to the user without a grant')
  assert.deepEqual(at(UNDERTOP), { needsGrant: false }, 'so does one under a top-level project: a project is not a superior')
  assert.deepEqual(at(MATE), { needsGrant: true }, 'one under a project under an agent is not top level')
  assert.equal(at(GONE), null, 'a retired agent cannot be granted an audience')
  window.localStorage.setItem(CLASSIC_MAILBOX_KEY, '1')
  assert.deepEqual(at(PLAIN), { needsGrant: true }, 'the classic mailbox too: Open chat switches it')
})

test('every agent and project menu has Open > Chat and no top-level Open chat; the tooltip says when opening grants an audience', t => {
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  t.after(() => window.localStorage.removeItem(CLASSIC_MAILBOX_KEY))
  const asked: unknown[] = []
  const off = onChatRequest((org, peer, opts) => { asked.push([org, peer, opts?.grant ?? false]) }); t.after(off)
  for (const [n, needsGrant] of [[PLAIN, true], [OWN, false], [CREW, true], [HELD, false]] as const) {
    const entries = agentMenuEntries(n, H, { tiers: [{ tier: 'opus' }], chat: { needsGrant } } as never)
    const labels = top(entries)
    assert.equal(labels.includes('Open chat'), false, `${n.id}: no top-level Open chat: ${JSON.stringify(labels)}`)
    const open = chatIn(entries)!
    assert.ok(open, `${n.id}: Open > Chat is offered`)
    assert.match(open.title ?? '', new RegExp(`your chat with ${n.id}`), `${n.id}: what it opens`)
    if (needsGrant) assert.match(open.title ?? '', GRANTS, `${n.id}: the tooltip says opening grants an audience`)
    else assert.equal(open.title, `your chat with ${n.id}, in Chats`, `${n.id}: nothing changes, so it only says what it opens`)
    open.onSelect?.()
  }
  assert.deepEqual(asked, [['', 'plain', true], ['', 'own', true], ['', 'crew', true], ['', 'held', true]],
    'each asks the inbox for the chat, granting first where needed (the inbox decides, as New chat does)')
})

test('a retired target gets no Chat; a builder given no chat state keeps the 4e1df11 rule', t => {
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  t.after(() => window.localStorage.removeItem(CLASSIC_MAILBOX_KEY))
  assert.equal(chatIn(agentMenuEntries(GONE, H, { chat: null } as never)), null, 'retired: none')
  for (const n of [PLAIN, CREW]) assert.equal(chatIn(agentMenuEntries(n, H)), null, `${n.id}: no state, no audience: none`)
  assert.ok(chatIn(agentMenuEntries(OWN, H)), 'POSITIVE CONTROL: own still has it')
  assert.equal(top(agentMenuEntries(OWN, H)).includes('Open chat'), false, 'and not at the top level')
})

test('in the classic mailbox, Open chat switches to the chats with the toggle\'s setting, then asks for the chat (granting where needed); the tooltip lists each change', t => {
  window.localStorage.setItem(CLASSIC_MAILBOX_KEY, '1')
  t.after(() => window.localStorage.removeItem(CLASSIC_MAILBOX_KEY))
  const asked: unknown[] = []
  const off = onChatRequest((org, peer, opts) => { asked.push([org, peer, opts?.grant ?? false, pref.classicMailbox()]) }); t.after(off)
  const plain = chatIn(agentMenuEntries(PLAIN, H, { chat: { needsGrant: true } } as never))!
  assert.equal(plain.title, 'your chat with plain, in Chats. Opening it switches your mailbox from the classic view to Chats and grants plain an audience with you')
  const own = chatIn(agentMenuEntries(OWN, H, { chat: { needsGrant: false } } as never))!
  assert.equal(own.title, 'your chat with own, in Chats. Opening it switches your mailbox from the classic view to Chats')
  plain.onSelect?.()
  assert.equal(pref.classicMailbox(), false, 'the classic view is off: the same setting the toggle writes')
  assert.deepEqual(asked, [['', 'plain', true, false]], 'switched BEFORE the chat is asked for, with the grant')
})

test('in the drawn menu, Open is second and there is no top-level Open chat, for an agent and a project without an audience', async t => {
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  t.after(() => window.localStorage.removeItem(CLASSIC_MAILBOX_KEY))
  for (const n of [PLAIN, CREW]) {
    const entries = agentMenuEntries(n, { ...(H as object), onHire() {}, onNewProject() {} } as never,
      { tiers: [{ tier: 'opus' }], chat: { needsGrant: true } } as never)
    function Host() {
      const menu = useContextMenu()
      return <><button data-copy-agent-name={n.id} onContextMenu={e => menu.open(e, entries)}>{n.id}</button>{menu.node}</>
    }
    const v = await mountView(<Host />, el => el)
    const button = v.el.querySelector('button')!
    await inAct(() => { button.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })) })
    await flush()
    const menu = button.ownerDocument.querySelector('.ctxmenu')
    assert.ok(menu, `${n.id}: the menu is drawn`)
    const real = [...menu!.querySelectorAll(':scope > .ctxmenu-branch > [role="menuitem"]')]
      .map(el => el.textContent?.replace('▸', '').trim() ?? '')
    const open = real.indexOf('Open')
    assert.equal(open, 1, `${n.id}: Open is second: ${JSON.stringify(real)}`)
    assert.equal(real.includes('Open chat'), false, `${n.id}: Open chat lives in Open: ${JSON.stringify(real)}`)
    assert.ok(real.length > 2, `${n.id}: POSITIVE CONTROL, the rest of the menu is drawn`)
    await v.unmount()
  }
})
