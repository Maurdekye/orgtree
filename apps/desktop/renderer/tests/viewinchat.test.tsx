// VIEW IN CHAT / VIEW IN CLASSIC INBOX for a mail between the user and an agent or project (4.7.0).
//
// USER 2026-11-25 m70e86c04946e: "any mail between you and an agent in an agent's or your classic mailbox gets a
// context menu "view in chat" which switches to the chat view and highlights the message".
// USER 2026-11-25 m53e908235395: "clicking a mail mention to you in a transcript or body elsewhere will do the same
// if chats is open".
// USER 2026-11-25 m2fb0c88ab8f8: "mail mentions should have context menu entries both for "view in chat" and "view in
// classic inbox", which switches to the appropriate one before opening". Coordinator: both only on the user's mail.
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, flush } from './harness'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { MailList } from '../src/canvas/mail'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import {
  CLASSIC_MAILBOX_KEY, chatPeerOf, classicMailbox, mailLinkToChat, onMailViewRequest, setClassicMailbox,
} from '../src/mailboxpref'

const USER = '@user'

function asked(t: TestContext) {
  const requests: { org: string; id: string; peer?: string; classic: boolean }[] = []
  const off = onMailViewRequest((org, id, peer) => { requests.push({ org, id, peer, classic: classicMailbox() }) })
  t.after(() => { off(); window.localStorage.removeItem(CLASSIC_MAILBOX_KEY) })
  return requests
}
const labels = () => [...document.querySelectorAll('.ctxmenu:not(.ctxmenu-submenu) > .ctxmenu-branch > [role="menuitem"]')]
  .map(el => el.textContent!.trim())
async function right(el: Element) {
  await inAct(() => el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
  await flush(4)
}
async function choose(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('.ctxmenu [role="menuitem"]')].find(el => el.textContent?.trim() === label)
  assert.ok(item, `${label} is in the menu (${labels()})`)
  await inAct(() => item!.click()); await flush(4)
}
async function dismiss() {
  await inAct(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await flush(2)
}

test('chatPeerOf: the agent or project on the other side of the user\'s mail, and nothing for any other mail', () => {
  assert.equal(chatPeerOf({ from: USER, to: 'quoter' }), 'quoter', 'the user wrote to it')
  assert.equal(chatPeerOf({ from: 'quoter', to: USER }), 'quoter', 'it wrote to the user')
  assert.equal(chatPeerOf({ from: 'quoter' }, true), 'quoter', 'the user\'s own box: received mail has no to')
  assert.equal(chatPeerOf({ from: USER }), '', 'the user\'s own, recipient unknown: a chat mail, chat unnamed')
  assert.equal(chatPeerOf({ from: 'quoter' }), null, 'no to, outside the user\'s box: not the user\'s')
  assert.equal(chatPeerOf({ from: 'a', to: 'b' }), null, 'agent to agent')
  assert.equal(chatPeerOf({ from: '@system', to: USER }), null, 'the system')
  assert.equal(chatPeerOf({ from: '@net:someone.abc', to: USER }), null, 'outside mail')
  assert.equal(chatPeerOf({ from: USER, to: '@org:mine' }), null, 'org mail')
  assert.equal(chatPeerOf({ from: '@system' }, true), null)
})

test('a mail row between the user and an agent has View in chat; it switches to the chats first, then asks for that mail', async (t) => {
  const requests = asked(t)
  setClassicMailbox(true)
  const rows = [
    { id: 'in1', from: 'quoter', at: '2026-11-20T10:00:00Z', kind: 'message', body: 'from the agent' },
    { id: 'sys1', from: '@system', at: '2026-11-20T10:01:00Z', kind: 'message', body: 'from the system' },
  ]
  const v = await mountView(<ObjectMenuBoundary><MailList userBox org="mine" delivered={rows} toast={() => {}} /></ObjectMenuBoundary>, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(4) })
  const row = (id: string) => [...v.el.querySelectorAll<HTMLElement>('.mailrow')].find(r => r.textContent?.includes(id === 'in1' ? 'from the agent' : 'from the system'))!
  await right(row('sys1'))
  assert.equal(labels().includes('View in chat'), false, 'the system\'s mail has no chat entry')
  await dismiss()
  await right(row('in1'))
  assert.deepEqual(labels().slice(0, 2), ['Open', 'View in chat'], 'beside Open')
  await choose('View in chat')
  assert.deepEqual(requests, [{ org: 'mine', id: 'in1', peer: 'quoter', classic: false }], 'the chats are on before the mailbox opens on it')
  assert.equal(classicMailbox(), false)
})

test('in an agent\'s mailbox only the user\'s mail with it has View in chat', async (t) => {
  const requests = asked(t)
  const rows = [
    { id: 'u1', from: USER, to: 'quoter', at: '2026-11-20T10:00:00Z', kind: 'message', body: 'the user wrote' },
    { id: 'a1', from: 'worker', to: 'quoter', at: '2026-11-20T10:01:00Z', kind: 'message', body: 'a colleague wrote' },
  ]
  const v = await mountView(<ObjectMenuBoundary><MailList org="mine" delivered={rows} toast={() => {}} /></ObjectMenuBoundary>, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(4) })
  const row = (text: string) => [...v.el.querySelectorAll<HTMLElement>('.mailrow')].find(r => r.textContent?.includes(text))!
  await right(row('a colleague wrote'))
  assert.equal(labels().includes('View in chat'), false, 'agent to agent: none')
  await dismiss()
  await right(row('the user wrote'))
  await choose('View in chat')
  assert.deepEqual(requests, [{ org: 'mine', id: 'u1', peer: 'quoter', classic: false }])
})

for (const c of [
  { name: 'the user\'s mail to an agent, in its box', box: 'node' as const, mail: { from: USER, to: 'reader' }, views: true, peer: 'reader' },
  { name: 'an agent\'s mail to the user, in its box', box: 'node' as const, mail: { from: 'reader', to: USER }, views: true, peer: 'reader' },
  { name: 'mail in the user\'s box', box: 'user' as const, mail: { from: 'reader' }, views: true, peer: 'reader' },
  { name: 'agent to agent', box: 'node' as const, mail: { from: 'writer', to: 'reader' }, views: false },
  { name: 'org mail', box: 'org' as const, mail: { from: '@net:someone.abc', to: '@org:org' }, views: false },
]) test(`a mail mention's menu: ${c.name} ${c.views ? 'has both views, each set before it opens' : 'has neither view'}`, async (t) => {
  const requests = asked(t)
  const saved = fetch
  const mail = { id: 'mm1', at: '2026-11-20T10:00:00Z', kind: 'message', body: 'the body', ...c.mail }
  globalThis.fetch = (async () => new Response(JSON.stringify({ found: true, mail }), { status: 200 })) as typeof fetch
  t.after(() => { globalThis.fetch = saved })
  const world = { org: 'org', agents: new Map([['reader', 'reader']]) }
  const v = await mountView(<ObjectNavProvider><ObjectNavHost org="org" dogs={[]} openDog={() => {}} toast={() => {}} openMail={() => {}} />
    <ObjectMenuBoundary>
      <RefChip r={resolveRef({ kind: 'mail', org: 'org', box: c.box, node: c.box === 'node' ? 'reader' : undefined, id: 'mm1' }, world)} onOpen={() => {}} />
    </ObjectMenuBoundary></ObjectNavProvider>, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(4) })
  const chip = v.el.querySelector('.ref-mail')!
  await right(chip)
  const have = labels()
  assert.equal(have.includes('View in chat'), c.views, `View in chat (${have})`)
  assert.equal(have.includes('View in classic inbox'), c.views, `View in classic inbox (${have})`)
  if (!c.views) { assert.deepEqual(requests, []); return }
  assert.deepEqual(have.slice(0, 3), ['Open', 'View in chat', 'View in classic inbox'])
  setClassicMailbox(true)
  await choose('View in chat')
  await right(chip)
  await choose('View in classic inbox')
  assert.deepEqual(requests, [
    { org: 'org', id: 'mm1', peer: c.peer, classic: false },
    { org: 'org', id: 'mm1', peer: undefined, classic: true },
  ], 'each view is set before the mailbox opens on the mail')
})

test('a mail link into an agent\'s mailbox opens the user\'s chat while the chats are on; otherwise the agent\'s mailbox', async (t) => {
  const requests = asked(t)
  const saved = fetch, asks: string[] = []
  let answer: unknown = { found: true, mail: { id: 'x1', from: USER, at: '2026-11-20T10:00:00Z', kind: 'message', body: 'b' } }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asks.push(new URL(String(input), 'http://test').pathname)
    if (answer instanceof Error) throw answer
    return new Response(JSON.stringify(answer), { status: 200 })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = saved })
  let elsewhere = 0
  const go = async () => { mailLinkToChat('org', 'x1', 'reader', () => { elsewhere++ }); await flush(6) }

  setClassicMailbox(true)
  await go()
  assert.deepEqual([elsewhere, asks.length, requests.length], [1, 0, 0], 'classic: the agent\'s mailbox, as before, nothing read')

  setClassicMailbox(false)
  await go()
  assert.deepEqual(asks, ['/api/orgs/org/mail/user/x1'], 'the user\'s box answers by id for the user\'s mail')
  assert.deepEqual(requests, [{ org: 'org', id: 'x1', peer: 'reader', classic: false }], 'the chat with that agent')
  assert.equal(elsewhere, 1)

  answer = { found: false, mail: null }
  await go()
  assert.equal(elsewhere, 2, 'not the user\'s mail: the agent\'s mailbox')
  answer = { found: true, mail: { id: 'x1', from: '@system', at: '2026-11-20T10:00:00Z', kind: 'message', body: 'b' } }
  await go()
  assert.equal(elsewhere, 3, 'the system\'s mail to the user is no chat with that agent')
  answer = new Error('offline')
  await go()
  assert.equal(elsewhere, 4, 'a failed read keeps the agent\'s mailbox')
  assert.equal(requests.length, 1)
})
