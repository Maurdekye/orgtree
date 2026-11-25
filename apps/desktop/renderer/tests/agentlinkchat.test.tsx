// A plain click on an agent link opens the user's chat with that agent when the agent holds a user
// audience, and does what it always did otherwise (USER 2026-11-24 md9120179f714: "make clicking an
// agent link anywhere in the app if they have an audience with you open a chat with them instead of
// focusing their desk on the canvas / switching the active agent desk in attention view. otherwise
// just do those things").
//
// One rule (mailboxpref.ts `agentLinkChat`), one route (agentnav.tsx: the registry the canonical agent
// menu already uses), read by the three components every agent link is drawn with: `NodeLink` (mention
// and reference chips), `AgentName` and `SenderChip`.
//
// Run:  node apps/desktop/renderer/tests/run.mjs agentlinkchat

import './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { AgentName, NodeLink } from '../src/canvas/identity'
import { SenderChip } from '../src/canvas/senderchip'
import { RefMdBody } from '../src/canvas/refmd'
import { useRefRoutes } from '../src/canvas/reflinks'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import { agentLinkChat, canChatWith, CLASSIC_MAILBOX_KEY, onChatRequest, setShownChat } from '../src/mailboxpref'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreeNode } from '../src/types'

const USER = '@user'
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, tier: 'opus', state: 'live', seat: 1, grant: 0, free: 0,
  children: [], audiences_held: [], scope: { tools: {}, add_dirs: [] }, ...extra }) as unknown as TreeNode
const NODES = new Map<string, TreeNode>([
  ['own', node('own', { audiences_held: [USER], audiences_explicit: [USER] })],
  // its audience comes through its project only
  ['member', node('member', { audiences_held: [USER], audiences_explicit: [], audiences_inherited: [{ grantor: USER, project: 'crew' }] })],
  ['plain', node('plain')],
  ['crew', node('crew', { kind: 'project', tier: null, audiences_held: [USER], audiences_explicit: [USER] })],
  ['gone', node('gone', { state: 'archived', audiences_held: [USER] })],
])

function Route() {
  useProvideAgentNav(null, null, id => { const n = NODES.get(id); return !!n && agentLinkChat('mine', n) })
  return null
}

async function fixture(t: TestContext) {
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  setShownChat('mine', null)
  const asked: string[] = [], focused: string[] = []
  const off = onChatRequest((org, peer) => { asked.push(`${org}:${peer}`) })
  const focus = (id: string) => { focused.push(id) }
  const view = await mountView(<AgentNavProvider><Route />
    {[...NODES.keys()].map(id => <div key={id} data-case={id}>
      <span data-kind="link"><NodeLink id={id} tier="opus" onFocus={focus} /></span>
      <span data-kind="name"><AgentName id={id} tier="opus" onFocus={focus} /></span>
      <span data-kind="sender"><SenderChip id={id} nodes={NODES} onFocusAgent={focus} /></span>
    </div>)}
  </AgentNavProvider>, el => el)
  t.after(async () => { off(); await view.unmount(); window.localStorage.removeItem(CLASSIC_MAILBOX_KEY); setShownChat('mine', null) })
  const click = async (id: string, kind: 'link' | 'name' | 'sender') => {
    const button = view.el.querySelector<HTMLButtonElement>(`[data-case="${id}"] [data-kind="${kind}"] button`)
    assert.ok(button, `${kind} of ${id} is a button`)
    asked.length = 0; focused.length = 0
    await inAct(async () => { button.click(); await flush(2) })
    return { asked: asked.slice(), focused: focused.slice() }
  }
  return { click }
}

const KINDS = ['link', 'name', 'sender'] as const

test('an agent with its own user audience: the click opens its chat, on every kind of agent link, and does not focus its desk', async t => {
  const f = await fixture(t)
  for (const kind of KINDS) assert.deepEqual(await f.click('own', kind), { asked: ['mine:own'], focused: [] }, kind)
})

test('an agent without a user audience: the click does what it did, on every kind of agent link', async t => {
  const f = await fixture(t)
  for (const kind of KINDS) assert.deepEqual(await f.click('plain', kind), { asked: [], focused: ['plain'] }, kind)
})

test('an audience held only through a project counts: the same test the chats list uses', async t => {
  const f = await fixture(t)
  for (const kind of KINDS) assert.deepEqual(await f.click('member', kind), { asked: ['mine:member'], focused: [] }, kind)
})

test('a project, a retired agent, the classic mailbox, and the chat already on screen keep the old click', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.click('crew', 'link'), { asked: [], focused: ['crew'] }, 'a project link goes to the project')
  assert.deepEqual(await f.click('gone', 'link'), { asked: [], focused: ['gone'] }, 'a retired agent has no chat in the list')
  // the chat that is open already: opening it again would be a click that does nothing
  setShownChat('mine', 'own')
  assert.deepEqual(await f.click('own', 'link'), { asked: [], focused: ['own'] }, 'its own open chat: the desk, as before')
  assert.deepEqual(await f.click('member', 'link'), { asked: ['mine:member'], focused: [] }, 'another agent still opens its chat')
  setShownChat('other', 'own')
  assert.deepEqual(await f.click('own', 'link'), { asked: ['mine:own'], focused: [] }, 'another organization\u2019s open chat is not this one')
  setShownChat('other', null); setShownChat('mine', null)
  window.localStorage.setItem(CLASSIC_MAILBOX_KEY, '1')
  assert.deepEqual(await f.click('own', 'link'), { asked: [], focused: ['own'] }, 'the classic mailbox has no chats')
})

test('without a window that provides the route (a popped-out desk) the click is the old one', async t => {
  const focused: string[] = []
  const view = await mountView(<NodeLink id="own" tier="opus" onFocus={id => { focused.push(id) }} />, el => el)
  t.after(async () => { await view.unmount() })
  await inAct(async () => { view.el.querySelector('button')!.click(); await flush(2) })
  assert.deepEqual(focused, ['own'])
})

test('the agent menu\u2019s Open submenu has Chat for an agent with a user audience, and only then', t => {
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  t.after(() => window.localStorage.removeItem(CLASSIC_MAILBOX_KEY))
  const asked: string[] = []
  const off = onChatRequest((org, peer) => { asked.push(`${org}:${peer}`) })
  t.after(off)
  const open = (n: TreeNode) => agentMenuEntries(n as unknown as CanvasNode, { onInbox() {}, onOpenDesk() {} } as never)
    .flatMap(e => e !== 'sep' && e.label === 'Open' ? e.children ?? [] : [])
  const labels = (n: TreeNode) => open(n).map(e => (e === 'sep' ? '-' : e.label))
  assert.deepEqual(labels(NODES.get('own')!).slice(0, 2), ['Chat', 'Mail'], 'first in Open, before Mail')
  assert.equal(labels(NODES.get('member')!).includes('Chat'), true, 'an inherited audience too')
  assert.equal(labels(NODES.get('plain')!).includes('Chat'), false, 'not without an audience')
  assert.equal(labels(NODES.get('plain')!).includes('Mail'), true, 'POSITIVE CONTROL: the Open submenu is the one read')
  const chat = open(NODES.get('own')!).find(e => e !== 'sep' && e.label === 'Chat')
  assert.ok(chat && chat !== 'sep')
  chat.onSelect?.()
  assert.deepEqual(asked, [':own'], 'it asks this window\u2019s organization for the chat')
  assert.equal(canChatWith(NODES.get('own')!), true)
  window.localStorage.setItem(CLASSIC_MAILBOX_KEY, '1')
  assert.equal(labels(NODES.get('own')!).includes('Chat'), false, 'not while the classic mailbox is on')
})

// ---- the links inside written text: a mail body, a chat bubble, a presentation, a ticket (USER 2026-11-25
// m1038dab63302: "i just clicked @hubchat-web-fable 's link and it opened them on the canvas instead of
// opening their dm, even though i have an audience with them"). MEASURED CAUSE: an @agent chip in rendered
// prose is drawn by refmd, not by NodeLink, and its click went through the reference router
// (reflinks.tsx `useRefRoutes`), whose agent arm called `onFocusAgent` without asking the chat. ----

function Prose({ text, focus }: { text: string; focus: (id: string) => void }) {
  const refs = useRefRoutes('mine', NODES, { onFocusAgent: focus })
  return <RefMdBody html={{ __html: `<p>${text}</p>` }} world={refs.world} onOpen={refs.onOpen} />
}

async function prose(t: TestContext) {
  window.localStorage.removeItem(CLASSIC_MAILBOX_KEY)
  setShownChat('mine', null)
  const asked: string[] = [], focused: string[] = []
  const off = onChatRequest((org, peer) => { asked.push(`${org}:${peer}`) })
  const view = await mountView(<AgentNavProvider><Route />
    <Prose text="ask @own, @member, @plain, @crew and @agent:mine/own" focus={id => { focused.push(id) }} />
  </AgentNavProvider>, el => el)
  t.after(async () => { off(); await view.unmount(); window.localStorage.removeItem(CLASSIC_MAILBOX_KEY); setShownChat('mine', null) })
  await inAct(async () => { await flush(4) })
  const click = async (token: string) => {
    const chip = view.el.querySelector<HTMLElement>(`[data-ref-token="${token}"]`)
    assert.ok(chip, `${token} is drawn as a chip`)
    asked.length = 0; focused.length = 0
    await inAct(async () => { chip.click(); await flush(2) })
    return { asked: asked.slice(), focused: focused.slice() }
  }
  return { click }
}

test('an @agent chip in written text opens the chat of an agent with a user audience, as the other agent links do', async t => {
  const f = await prose(t)
  assert.deepEqual(await f.click('@own'), { asked: ['mine:own'], focused: [] }, 'a bare @name')
  assert.deepEqual(await f.click('@agent:mine/own'), { asked: ['mine:own'], focused: [] }, 'the canonical @agent: form')
  assert.deepEqual(await f.click('@member'), { asked: ['mine:member'], focused: [] }, 'an audience through its project')
})

test('POSITIVE CONTROL: an @agent chip in written text without a user audience, or a project, still goes to the canvas', async t => {
  const f = await prose(t)
  assert.deepEqual(await f.click('@plain'), { asked: [], focused: ['plain'] })
  assert.deepEqual(await f.click('@crew'), { asked: [], focused: ['crew'] })
  setShownChat('mine', 'own')
  assert.deepEqual(await f.click('@own'), { asked: [], focused: ['own'] }, 'its chat already on screen: the desk, as NodeLink does')
})
