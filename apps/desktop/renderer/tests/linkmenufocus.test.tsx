// linkmenufocus.test.tsx — the agent-link context menu: Focus closes the open
// floating panels first, and an "Open chat" entry for an agent with a user
// audience (USER 2026-11-25 13:04:54Z m9b2f753b0fa5: "the focus context menu
// entry should close any floating panels that are open (such as the chat
// window), and there should be an extra context menu entry for "open chat"
// for agent links that have audience with you directly or indirectly";
// docket agent-link-menu-focus-closes-open-floating-panel).
//
// "Floating" is the app's own word for a CENTRED panel (modalpin.tsx
// closeIfCentred, and the view shortcut's "Centred app/org panels are another
// view"): pinned and popped-out surfaces stay where the user put them.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs linkmenufocus

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import { useContextMenu } from '../src/canvas/contextmenu'
import { CLASSIC_MAILBOX_KEY, onChatRequest } from '../src/mailboxpref'
import * as modalpin from '../src/canvas/modalpin'
import { pinModal, unpinModal } from '../src/canvas/modalpin'
import { useModalInstances, type ModalInstances } from '../src/canvas/modalinstances'
import { instanceKind } from '../src/modalkinds'
import type { CanvasNode } from '../src/canvas/shared'
import type { MenuEntry } from '../src/canvas/contextmenu'

const USER = '@user'
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, tier: 'opus', state: 'live', seat: 1, grant: 0, free: 0,
  children: [], audiences_held: [], scope: { tools: {}, add_dirs: [] }, ...extra }) as unknown as CanvasNode
const OWN = node('own', { audiences_held: [USER], audiences_explicit: [USER] })
const MEMBER = node('member', { audiences_held: [USER], audiences_explicit: [], audiences_inherited: [{ grantor: USER, project: 'crew' }] })
const PLAIN = node('plain')
const CREW = node('crew', { kind: 'project', tier: null, audiences_held: [USER], audiences_explicit: [USER] })
const GONE = node('gone', { state: 'archived', audiences_held: [USER] })

const top = (entries: MenuEntry[]) => entries.map(e => (e === 'sep' ? '-' : e.label))
const entry = (entries: MenuEntry[], label: string) => {
  const e = entries.find(x => x !== 'sep' && x.label === label)
  return e && e !== 'sep' ? e : null
}

// MOVED INTO OPEN (USER 2026-11-25 21:32:43Z m05fbc02357a7 "open chat should be in the open submenu everywhere
// in an agent's co text menu"): Open > Chat is the one chat entry; no top-level Open chat.
const chatIn = (entries: MenuEntry[]) => {
  const kids = (entry(entries, 'Open')?.children ?? []).filter(e => e !== 'sep' && e.label === 'Chat')
  assert.ok(kids.length <= 1, 'one Chat entry in Open, no duplicate')
  const k = kids[0]
  return k && k !== 'sep' ? k : null
}

test('Open > Chat (no top-level "Open chat") for an agent with a user audience, own or through a project', t => {
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  t.after(() => window.localStorage.removeItem(CLASSIC_MAILBOX_KEY))
  const asked: string[] = []
  const off = onChatRequest((org, peer) => { asked.push(`${org}:${peer}`) }); t.after(off)
  const menu = (n: CanvasNode) => agentMenuEntries(n, { onInbox() {}, onOpenDesk() {} } as never)
  for (const n of [OWN, MEMBER]) {
    assert.equal(top(menu(n)).includes('Open chat'), false, `${n.id}: no top-level Open chat`)
    assert.ok(chatIn(menu(n)), `${n.id}: Open > Chat`)
  }
  chatIn(menu(OWN))!.onSelect?.()
  assert.deepEqual(asked, [':own'], 'it opens that agent’s chat in this window’s organization, as the plain click does')
  for (const n of [PLAIN, CREW, GONE])
    assert.equal(chatIn(menu(n)), null, `${n.id}: no Chat without a live agent’s user audience (no chat state given)`)
  assert.equal(top(menu(PLAIN)).includes('Focus'), true, 'POSITIVE CONTROL: the top level is the one read')
  window.localStorage.setItem(CLASSIC_MAILBOX_KEY, '1')
  assert.equal(chatIn(menu(OWN)), null, 'not while the classic mailbox is on (the chats are not the mailbox)')
})

test('Focus closes the floating panels first, then focuses, for an agent and for a project', () => {
  for (const n of [OWN, PLAIN, CREW]) {
    const order: string[] = []
    const entries = agentMenuEntries(n, { onInbox() {}, onOpenDesk: () => order.push('focus'),
      onCloseFloating: () => order.push('close') } as never)
    entry(entries, 'Focus')!.onSelect?.()
    assert.deepEqual(order, ['close', 'focus'], `${n.id}: panels close, then the node is focused`)
  }
  // a menu whose host has no floating panels to close still focuses
  const order: string[] = []
  entry(agentMenuEntries(PLAIN, { onInbox() {}, onOpenDesk: () => order.push('focus') } as never), 'Focus')!.onSelect?.()
  assert.deepEqual(order, ['focus'])
})

test('closeFloatingPanels reaches every surface listening for that organization, and only while it listens', () => {
  // read through the module so a missing export fails here, by name, not the whole file's build
  const { closeFloatingPanels, onCloseFloating } = modalpin as unknown as {
    closeFloatingPanels?: (org: string) => void; onCloseFloating?: (fn: (org: string) => void) => () => void }
  assert.equal(typeof closeFloatingPanels, 'function', 'modalpin has closeFloatingPanels')
  assert.equal(typeof onCloseFloating, 'function', 'and onCloseFloating')
  if (!closeFloatingPanels || !onCloseFloating) return
  const heard: string[] = []
  const off = onCloseFloating(org => { heard.push(org) })
  closeFloatingPanels('mine')
  assert.deepEqual(heard, ['mine'])
  off()
  closeFloatingPanels('mine')
  assert.deepEqual(heard, ['mine'], 'an unsubscribed surface hears nothing')
})

test('a modal kind’s closeCentred closes its centred instance and keeps the pinned one', async t => {
  const org = 'linkmenu-fixture'
  let api: ModalInstances | null = null
  function Host() { api = useModalInstances('node-config', org, id => ({ agent: id })); return null }
  const v = await mountView(<Host />, el => el); t.after(async () => { await v.unmount(); unpinModal(instanceKind('node-config', 'pinned'), org) })
  await inAct(() => { api!.open('pinned', { place: false }) }); await flush()
  pinModal(instanceKind('node-config', 'pinned'), { x: 10, y: 10, w: 400, h: 300 }, org)
  await inAct(() => { api!.open('centred', { place: false }) }); await flush()
  assert.deepEqual([...api!.ids], ['pinned', 'centred'], 'both open')
  let closed = 0
  const closeCentred = (api as unknown as { closeCentred?: () => number }).closeCentred
  assert.equal(typeof closeCentred, 'function', 'the instances have closeCentred')
  await inAct(() => { closed = api!.closeCentred() }); await flush()
  assert.deepEqual([...api!.ids], ['pinned'], 'the pinned window stays where the user put it')
  assert.equal(closed, 1, 'it says how many it closed')
})

// RENDERED, as the user sees it (integration bounce mda65bfe41ae4: the builder had Open chat after Open,
// but the renderer moves Open second after the prefix and left Open chat after New project)
test('in the drawn menu, Open is second and no top-level Open chat is drawn', async t => {
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  t.after(() => window.localStorage.removeItem(CLASSIC_MAILBOX_KEY))
  const entries = agentMenuEntries(OWN, { onInbox() {}, onOpenDesk() {}, onHire() {} } as never,
    { tiers: [{ tier: 'opus' }] } as never)
  assert.ok(top(entries).indexOf('Open') > 1, 'POSITIVE CONTROL: the builder does not already have Open second')
  function Host() {
    const menu = useContextMenu()
    return <><button data-copy-agent-name="own" onContextMenu={e => menu.open(e, entries)}>own</button>{menu.node}</>
  }
  const v = await mountView(<Host />, el => el); t.after(() => v.unmount())
  const button = v.el.querySelector('button')!
  await inAct(() => { button.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })) })
  await flush()
  const menu = button.ownerDocument.querySelector('.ctxmenu')
  assert.ok(menu, 'the menu is drawn')
  const real = [...menu!.querySelectorAll(':scope > .ctxmenu-branch > [role="menuitem"]')]
    .map(el => el.textContent?.replace('▸', '').trim() ?? '')
  const open = real.indexOf('Open')
  assert.equal(open, 1, `Open is second: ${JSON.stringify(real)}`)
  assert.equal(real.includes('Open chat'), false, `Open chat lives in Open: ${JSON.stringify(real)}`)
  assert.ok(real.includes('Focus') && real.indexOf('Focus') > open, 'Focus and the rest follow')
})
