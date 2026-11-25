// inboxopenchat.test.tsx — "Open chat" on every agent and project link in the
// inbox, granting a user audience first when the target has none (USER
// 2026-11-25 14:24:01Z ma84dfc37f5a6: "actually add an open chat context menu
// entry to every agent / project link in the inbox context; if they don't have
// an audience, grant one before opening the chat. state that opening the chat
// grants an audience in the hover tooltip. clicking still focuses if they don't
// already have a chat open."; docket inbox-links-open-chat-on-every-agent-project-lin).
//
// The inbox context is the user's chats panel (`.dm-panel`). The grant is the
// inbox's own New chat path (DmPanel startChat); its tests are in dmpanel.test.tsx.
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
const GRANTS = /opening it grants .* an audience with you/i

function inPanel(t: { after: (fn: () => void) => void }) {
  const panel = document.createElement('div')
  panel.className = 'settings wide dm-panel'
  const link = document.createElement('span')
  panel.appendChild(link)
  document.body.appendChild(panel)
  const outside = document.createElement('span')
  document.body.appendChild(outside)
  t.after(() => { panel.remove(); outside.remove() })
  return { link, outside }
}

test('inbox context: a link inside the chats panel, for a live agent or project; it needs a grant unless it can already write to the user', t => {
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  t.after(() => window.localStorage.removeItem(CLASSIC_MAILBOX_KEY))
  assert.equal(typeof pref.inboxChatFor, 'function', 'mailboxpref exports inboxChatFor')
  const { link, outside } = inPanel(t)
  const at = (el: Element | undefined, n: CanvasNode) => pref.inboxChatFor(el, nodes, n)
  assert.deepEqual(at(link, PLAIN), { needsGrant: true }, 'an agent with no audience: the chat grants one')
  assert.deepEqual(at(link, CREW), { needsGrant: true }, 'a project with no audience too')
  assert.deepEqual(at(link, OWN), { needsGrant: false }, 'its own audience')
  assert.deepEqual(at(link, HELD), { needsGrant: false }, 'a project holding one')
  assert.deepEqual(at(link, node('member', { parent: 'held', audiences_held: [USER] })), { needsGrant: false },
    'an audience through its project (the tree lists it in audiences_held)')
  assert.deepEqual(at(link, LEAD), { needsGrant: false }, 'a top-level agent writes to the user without a grant')
  assert.deepEqual(at(link, UNDERTOP), { needsGrant: false }, 'so does one under a top-level project: a project is not a superior')
  assert.deepEqual(at(link, MATE), { needsGrant: true }, 'one under a project under an agent is not top level')
  assert.equal(at(link, GONE), null, 'a retired agent cannot be granted an audience')
  assert.equal(at(outside, PLAIN), null, 'outside the inbox: no inbox chat')
  assert.equal(at(undefined, PLAIN), null, 'no link element: no inbox chat')
  window.localStorage.setItem(CLASSIC_MAILBOX_KEY, '1')
  assert.equal(at(link, PLAIN), null, 'the classic mailbox has no chats')
})

test('in the inbox, every agent and project link gets Open chat right after Open; the tooltip says when opening grants an audience', t => {
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  t.after(() => window.localStorage.removeItem(CLASSIC_MAILBOX_KEY))
  const asked: unknown[] = []
  const off = onChatRequest((org, peer, opts) => { asked.push([org, peer, opts?.grant ?? false]) }); t.after(off)
  for (const [n, needsGrant] of [[PLAIN, true], [OWN, false], [CREW, true], [HELD, false]] as const) {
    const entries = agentMenuEntries(n, H, { tiers: [{ tier: 'opus' }], inboxChat: { needsGrant } } as never)
    const labels = top(entries)
    assert.equal(labels[labels.indexOf('Open') + 1], 'Open chat', `${n.id}: Open chat follows Open: ${JSON.stringify(labels)}`)
    const open = entry(entries, 'Open chat')!
    assert.equal(open.withOpen, true, `${n.id}: it travels with Open when the renderer moves Open second`)
    assert.match(open.title ?? '', new RegExp(`your chat with ${n.id}`), `${n.id}: what it opens`)
    if (needsGrant) assert.match(open.title ?? '', GRANTS, `${n.id}: the tooltip says opening grants an audience`)
    else assert.doesNotMatch(open.title ?? '', GRANTS, `${n.id}: no grant warning when it already has one`)
    open.onSelect?.()
  }
  assert.deepEqual(asked, [['', 'plain', true], ['', 'own', true], ['', 'crew', true], ['', 'held', true]],
    'each asks the inbox for the chat, granting first where needed (the inbox decides, as New chat does)')
})

test('outside the inbox the 4e1df11 rule stands: Open chat only for a live agent already holding a user audience', t => {
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  t.after(() => window.localStorage.removeItem(CLASSIC_MAILBOX_KEY))
  const asked: unknown[] = []
  const off = onChatRequest((org, peer, opts) => { asked.push([org, peer, opts?.grant ?? false]) }); t.after(off)
  for (const n of [PLAIN, CREW, HELD])
    assert.equal(top(agentMenuEntries(n, H, { inboxChat: null } as never)).includes('Open chat'), false, `${n.id}: none`)
  const open = entry(agentMenuEntries(OWN, H), 'Open chat')
  assert.ok(open, 'POSITIVE CONTROL: own still has it')
  assert.doesNotMatch(open!.title ?? '', GRANTS)
  open!.onSelect?.()
  assert.deepEqual(asked, [['', 'own', false]], 'and it grants nothing')
})

test('in the drawn inbox menu, Open chat comes right after Open for an agent and a project without an audience', async t => {
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  t.after(() => window.localStorage.removeItem(CLASSIC_MAILBOX_KEY))
  for (const n of [PLAIN, CREW]) {
    const entries = agentMenuEntries(n, { ...(H as object), onHire() {}, onNewProject() {} } as never,
      { tiers: [{ tier: 'opus' }], inboxChat: { needsGrant: true } } as never)
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
    assert.equal(real[open + 1], 'Open chat', `${n.id}: Open chat follows it: ${JSON.stringify(real)}`)
    await v.unmount()
  }
})
