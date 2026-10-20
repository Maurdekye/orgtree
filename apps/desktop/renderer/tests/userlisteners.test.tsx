// userlisteners.test.tsx — the Listeners tab lets the user register an event
// listener and a listener watch themselves (docket
// let-the-user-manually-hold-a-number-of-a-project; USER 2026-10-20
// 13:03Z "allow them to register an event listener or listen watcher
// manually", 13:04Z "they both arrive as normal mail in your inbox", 13:22Z
// layout B: focused Add dialogs; 13:50Z: the @user mention, never "you").
// The tab itself exists only while the project's event listeners are on
// (user 2026-10-20 10:50Z; coordinator 14:11Z): registering starts from the
// settings toggle, so these controls live on the existing tab.
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 "Register event listener…" and "Register listener watch…" open
//      focused dialogs and send user_listener_register (every event, or the
//      next only) and user_watch_register (a count); each is offered only
//      while the user has none, and the hint names the inbox
//   §2 the user's rows (their listener and watch in the tree's dogs, owner
//      "user") wear the @user chip, each with its own remove, which sends
//      user_registration_remove; an agent's rows keep their agent link and
//      no remove
//   §3 Recently Fired names the user as the @user chip too
//   §4 nothing on the tab says "you"
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs userlisteners

import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { ListenersView } from '../src/canvas/listenersdesk'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'

const refs = { world: { org: 'org' }, onOpen: () => {} } as never
const node = (extra: Record<string, unknown> = {}) =>
  ({ id: 'sync', kind: 'project', tier: 'project', state: 'live', children: [], ...extra }) as unknown as CanvasNode
const dog = (kind: Watchdog['kind'], owner: string, name: string, extra: Partial<Watchdog> = {}): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind, target: 'sync', interval_s: 5, state: 'armed',
    at: '2026-10-20T07:00:00.000Z', fired: 0, once: true, spent: false, ...extra } as Watchdog)
const agentListener = dog('project_listener', 'sa', 'ready-a', { once: false })
const mine = dog('project_listener', 'user', 'u1abc', { name: 'user-listener', once: false })
const myWatch = dog('listener_watch', 'user', 'u2def', { name: 'user-watch', count: 3 })

const history = {
  history: [{ id: 7, at: '2026-10-20T09:00:00Z', kind: 'event', by: '@user', message: 'go',
    listeners: [{ agent: 'user', dog: 'u1abc', name: 'user-listener', once: false, since: '2026-10-20T08:00:00Z', mail: 'm1' },
      { agent: 'sa', dog: 'ready-a', since: '2026-10-20T08:00:00Z' }] }],
  history_next: null,
}
const serve = (requests: OpRequest[]) => async (req: OpRequest): Promise<OpResult> => {
  requests.push(req)
  return (req.op === 'listener_history' ? history : { ok: true }) as unknown as OpResult
}
const mount = async (dogs: Watchdog[], requests: OpRequest[], extra: Record<string, unknown> = {}, toasts: string[][] = []) => {
  const v = await mountView(<ListenersView node={node(extra)} dogs={dogs} map={new Map()} op={serve(requests)}
    toast={(m) => { toasts.push(m as string[]) }} refs={refs} />, (el) => el)
  await inAct(async () => { await flush(6) })
  return v
}
const setInput = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  const proto = el instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(el instanceof window.HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (root: ParentNode, label: RegExp) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => label.test(b.textContent ?? ''))

test('§1 Register event listener opens a dialog and sends user_listener_register', async (t) => {
  const requests: OpRequest[] = []
  const toasts: string[][] = []
  const v = await mount([agentListener], requests, {}, toasts)
  t.after(() => v.unmount())
  const open = v.el.querySelector<HTMLButtonElement>('[data-action="register-listener"]')
  assert.ok(open, 'offered while the user has no listener')
  assert.match(open.textContent ?? '', /Register event listener/)
  await inAct(async () => { open.click() })
  const box = dialog()!
  assert.ok(box, 'a focused dialog')
  assert.match(box.textContent ?? '', /inbox/, 'the hint says where fires arrive')
  assert.ok(!/\byou\b/i.test(box.textContent ?? ''), 'the dialog does not say "you" either')
  assert.ok(button(box, /^Register event listener$/)!.classList.contains('primary'), 'a form dialog: its main button is the primary action, not a red confirmation')
  const mode = box.querySelector<HTMLSelectElement>('select')!
  assert.deepEqual([...mode.options].map((o) => o.textContent), ['Every event', 'Next event only'])
  await inAct(async () => { button(box, /^Register event listener$/)!.click(); await flush(4) })
  assert.deepEqual(requests.find((r) => r.op === 'user_listener_register'), { op: 'user_listener_register', node: 'sync', once: false })
  assert.ok(toasts.length > 0)
  await inAct(async () => { open.click() })
  const second = dialog()!
  await inAct(async () => { setInput(second.querySelector<HTMLSelectElement>('select')!, 'once') })
  await inAct(async () => { button(second, /^Register event listener$/)!.click(); await flush(4) })
  const sends = requests.filter((r) => r.op === 'user_listener_register')
  assert.deepEqual(sends.at(-1), { op: 'user_listener_register', node: 'sync', once: true }, 'next event only is a one-shot')
})

test('§1 Register listener watch sends user_watch_register with its count', async (t) => {
  const requests: OpRequest[] = []
  const v = await mount([agentListener], requests)
  t.after(() => v.unmount())
  const open = v.el.querySelector<HTMLButtonElement>('[data-action="register-watch"]')!
  assert.ok(open)
  await inAct(async () => { open.click() })
  const box = dialog()!
  const count = box.querySelector<HTMLInputElement>('input[type="number"]')!
  assert.equal(count.min, '1')
  for (const bad of ['0', '', '1.5']) {
    await inAct(async () => { setInput(count, bad) })
    assert.equal(button(box, /^Register listener watch$/)!.disabled, true, `"${bad}" cannot be sent`)
  }
  await inAct(async () => { setInput(count, '3') })
  await inAct(async () => { button(box, /^Register listener watch$/)!.click(); await flush(4) })
  assert.deepEqual(requests.find((r) => r.op === 'user_watch_register'), { op: 'user_watch_register', node: 'sync', count: 3 })
  assert.match(box.textContent ?? '', /one-time notification/i)
})

test('§1 each registration is offered only while the user has none', async (t) => {
  const none = await mount([agentListener], [])
  t.after(() => none.unmount())
  assert.ok(none.el.querySelector('[data-action="register-listener"]'))
  assert.ok(none.el.querySelector('[data-action="register-watch"]'))
  const both = await mount([agentListener, mine, myWatch], [])
  t.after(() => both.unmount())
  assert.ok(!both.el.querySelector('[data-action="register-listener"]'), 'the user\'s listener is already registered')
  assert.ok(!both.el.querySelector('[data-action="register-watch"]'), 'the user\'s watch is already registered')
  const listenerOnly = await mount([mine], [])
  t.after(() => listenerOnly.unmount())
  assert.ok(!listenerOnly.el.querySelector('[data-action="register-listener"]'))
  assert.ok(listenerOnly.el.querySelector('[data-action="register-watch"]'))
})

test('§1 a retired project takes no registration', async (t) => {
  const v = await mount([], [], { state: 'archived' })
  t.after(() => v.unmount())
  for (const a of ['register-listener', 'register-watch']) {
    const b = v.el.querySelector<HTMLButtonElement>(`[data-action="${a}"]`)
    assert.ok(!b || b.disabled, a)
  }
})

test('§2 the user\'s rows wear the @user chip and remove only their own', async (t) => {
  const requests: OpRequest[] = []
  const v = await mount([agentListener, mine, myWatch], requests)
  t.after(() => v.unmount())
  const events = [...v.el.querySelectorAll('.listeners-events tr.listener-row')]
  assert.equal(events.length, 2)
  const user = events.find((r) => r.querySelector('.slot-agent .ref-chip'))!
  assert.ok(user, 'the user\'s listener row')
  assert.equal(user.querySelector('.slot-agent .ref-chip')!.textContent, '@user')
  const agent = events.find((r) => r !== user)!
  assert.ok(!agent.querySelector('.slot-agent .ref-chip'), 'an agent keeps its agent link')
  assert.ok(!agent.querySelector('[data-action="remove-registration"]'), 'the user removes nobody else\'s dog here')
  const remove = user.querySelector<HTMLButtonElement>('[data-action="remove-registration"]')!
  assert.ok(remove)
  await inAct(async () => { remove.click(); await flush(4) })
  assert.deepEqual(requests.find((r) => r.op === 'user_registration_remove'), { op: 'user_registration_remove', node: 'sync', dog: 'u1abc' })
  const watch = v.el.querySelector('.listeners-watches tr.listener-row')!
  assert.equal(watch.querySelector('.slot-agent .ref-chip')!.textContent, '@user')
  await inAct(async () => { watch.querySelector<HTMLButtonElement>('[data-action="remove-registration"]')!.click(); await flush(4) })
  assert.deepEqual(requests.filter((r) => r.op === 'user_registration_remove').at(-1),
    { op: 'user_registration_remove', node: 'sync', dog: 'u2def' })
})

test('§3 Recently Fired names the user as the @user chip, as the firer and as a listener reached', async (t) => {
  const v = await mount([agentListener, mine], [])
  t.after(() => v.unmount())
  const fired = v.el.querySelector('.listeners-fired')!
  const chips = [...fired.querySelectorAll('.ref-chip.ref-mail')].map((c) => c.textContent)
  assert.ok(chips.length >= 2, 'the firer (@user) and the listener reached (user)')
  assert.ok(chips.every((c) => c === '@user'))
})

test('§4 nothing on the tab says "you"', async (t) => {
  const v = await mount([agentListener, mine, myWatch], [])
  t.after(() => v.unmount())
  assert.ok(!/\byou\b/i.test(v.el.textContent ?? ''), v.el.textContent?.match(/.{20}\byou\b.{20}/i)?.[0])
  await inAct(async () => { v.el.querySelector<HTMLButtonElement>('[data-action="register-listener"]')?.click() })
})
