// registermenu.test.tsx — the Listeners tab's "Register…" menu button (docket
// slots-tab-header-hold-n-slots-button-with-number; USER 2026-10-20 16:43Z:
// "make this one menu button in the same row as those buttons: "Register..."
// the modal that pops out will have three rows: one with a button for
// "Register one time event listener", a row for "Register continuous event
// listener", and "Register watcher for N listeners" with the same number input
// variadically updating. clicking any of the three buttons does the respective
// thing ... grey out the event listener buttons as appropriate ... if listen
// watcher is already registered, grey it out, unless you changed the value;
// then change the text to read "Watch for N listeners". for the other two,
// leave the opposing button enabled saying "Switch to one-time event listener"
// or "Switch to continuous event listener"", and "keep the helptext in the
// hover tooltips").
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 one "Register…" trigger opens a panel of three rows (one time, continuous,
//      watcher for N with a number input, default 1, 1 to 1024); it closes on a
//      second press, Escape, or a press outside
//   §2 each button acts at once: user_listener_register once true / false,
//      user_watch_register with the count; the panel closes
//   §3 with a listener registered its own kind is grey and the other kind reads
//      "Switch to ..." and re-registers (the engine switches it in place)
//   §4 with a watch registered the input shows its count and the button is grey
//      until the number differs; then it reads "Watch for N listeners" and
//      sends the same op (the engine updates the count in place)
//   §5 the count is brought into 1..1024; an empty or fractional one is grey
//   §6 the trigger is enabled while any of the three is possible
//   §7 the help text lives in tooltips on the trigger, the input and all three
//      buttons, and nothing says "you"
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs registermenu

import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { RegisterMenu, registerOptions } from '../src/canvas/registermenu'
import { projectListenerState } from '../src/canvas/listeners'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'

const node = (extra: Record<string, unknown> = {}) =>
  ({ id: 'sync', kind: 'project', tier: 'project', state: 'live', children: [], ...extra }) as unknown as CanvasNode
const dog = (kind: Watchdog['kind'], owner: string, name: string, extra: Partial<Watchdog> = {}): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind, target: 'sync', interval_s: 5, state: 'armed',
    at: '2026-10-20T07:00:00.000Z', fired: 0, once: true, spent: false, ...extra } as Watchdog)
const agentListener = dog('project_listener', 'sa', 'ready-a', { once: false })
const mineOnce = dog('project_listener', 'user', 'u1abc', { name: 'user-listener', once: true })
const mineContinuous = dog('project_listener', 'user', 'u1abc', { name: 'user-listener', once: false })
const myWatch = (count: number) => dog('listener_watch', 'user', 'u2def', { name: 'user-watch', count })

const setInput = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
async function mount(dogs: Watchdog[], requests: OpRequest[], toasts: string[][] = [], extra: Record<string, unknown> = {}) {
  const op = async (req: OpRequest): Promise<OpResult> => { requests.push(req); return { ok: true } as unknown as OpResult }
  const v = await mountView(<RegisterMenu node={node(extra)} state={projectListenerState('sync', dogs)} op={op}
    toast={(m) => { toasts.push(m as string[]) }} />, (el) => el)
  await inAct(async () => { await flush(2) })
  return v
}
const trigger = (root: ParentNode) => root.querySelector<HTMLButtonElement>('[data-action="register-menu"]')
const panel = () => document.querySelector<HTMLElement>('.register-panel')
const row = (name: 'register-once' | 'register-continuous' | 'register-watch') =>
  panel()?.querySelector<HTMLButtonElement>(`[data-action="${name}"]`) ?? null
const count = () => panel()?.querySelector<HTMLInputElement>('input[type="number"]') ?? null
const openPanel = async (v: { el: HTMLElement }) => { await inAct(async () => { trigger(v.el)!.click() }) }

test('§1 one Register… trigger opens a panel of three rows; a second press, Escape or a press outside closes it', async (t) => {
  const v = await mount([agentListener], [])
  t.after(() => v.unmount())
  const open = trigger(v.el)
  assert.ok(open, 'a Register… trigger')
  assert.match(open.textContent ?? '', /^Register…$|^Register\.\.\.$/)
  assert.ok(!panel(), 'closed to begin with')
  await openPanel(v)
  const box = panel()!
  assert.ok(box, 'the panel opens')
  assert.deepEqual([...box.querySelectorAll('button')].map((b) => b.dataset.action), ['register-once', 'register-continuous', 'register-watch'])
  assert.equal(row('register-once')!.textContent, 'Register one time event listener')
  assert.equal(row('register-continuous')!.textContent, 'Register continuous event listener')
  assert.equal(row('register-watch')!.textContent, 'Register watcher for 1 listener', 'singular at one')
  const n = count()!
  assert.equal(n.value, '1')
  assert.equal(n.min, '1')
  assert.equal(n.max, '1024')
  await openPanel(v)
  assert.ok(!panel(), 'a second press closes it')
  await openPanel(v)
  await inAct(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  assert.ok(!panel(), 'Escape closes it')
  await openPanel(v)
  await inAct(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
  assert.ok(!panel(), 'a press outside closes it')
})

test('§2 each button acts at once and the panel closes', async (t) => {
  const requests: OpRequest[] = []
  const toasts: string[][] = []
  const v = await mount([agentListener], requests, toasts)
  t.after(() => v.unmount())
  await openPanel(v)
  await inAct(async () => { row('register-once')!.click(); await flush(4) })
  assert.deepEqual(requests.at(-1), { op: 'user_listener_register', node: 'sync', once: true })
  assert.ok(!panel(), 'closed after acting')
  await openPanel(v)
  await inAct(async () => { row('register-continuous')!.click(); await flush(4) })
  assert.deepEqual(requests.at(-1), { op: 'user_listener_register', node: 'sync', once: false })
  await openPanel(v)
  await inAct(async () => { setInput(count()!, '3') })
  assert.equal(row('register-watch')!.textContent, 'Register watcher for 3 listeners', 'the label follows the number')
  await inAct(async () => { row('register-watch')!.click(); await flush(4) })
  assert.deepEqual(requests.at(-1), { op: 'user_watch_register', node: 'sync', count: 3 })
  assert.ok(!panel())
  assert.ok(toasts.length >= 3, 'the user is told each time')
})

test('§3 with a listener registered its own kind is grey and the other kind switches it', async (t) => {
  const requests: OpRequest[] = []
  const once = await mount([agentListener, mineOnce], requests)
  t.after(() => once.unmount())
  await openPanel(once)
  assert.equal(row('register-once')!.disabled, true, 'already one-time')
  assert.equal(row('register-continuous')!.textContent, 'Switch to continuous event listener')
  assert.equal(row('register-continuous')!.disabled, false)
  await inAct(async () => { row('register-continuous')!.click(); await flush(4) })
  assert.deepEqual(requests.at(-1), { op: 'user_listener_register', node: 'sync', once: false }, 'the same op: the engine switches it in place')
  const cont = await mount([agentListener, mineContinuous], requests)
  t.after(() => cont.unmount())
  await openPanel(cont)
  assert.equal(row('register-continuous')!.disabled, true, 'already continuous')
  assert.equal(row('register-once')!.textContent, 'Switch to one-time event listener')
  await inAct(async () => { row('register-once')!.click(); await flush(4) })
  assert.deepEqual(requests.at(-1), { op: 'user_listener_register', node: 'sync', once: true })
})

test('§4 with a watch registered the input shows its count; grey until the number differs, then "Watch for N listeners"', async (t) => {
  const requests: OpRequest[] = []
  const v = await mount([agentListener, myWatch(3)], requests)
  t.after(() => v.unmount())
  await openPanel(v)
  assert.equal(count()!.value, '3', 'the input shows the watch\'s count')
  assert.equal(row('register-watch')!.textContent, 'Register watcher for 3 listeners')
  assert.equal(row('register-watch')!.disabled, true, 'nothing to change yet')
  await inAct(async () => { setInput(count()!, '4') })
  assert.equal(row('register-watch')!.textContent, 'Watch for 4 listeners')
  assert.equal(row('register-watch')!.disabled, false)
  await inAct(async () => { setInput(count()!, '1') })
  assert.equal(row('register-watch')!.textContent, 'Watch for 1 listener', 'singular at one')
  await inAct(async () => { setInput(count()!, '4') })
  await inAct(async () => { row('register-watch')!.click(); await flush(4) })
  assert.deepEqual(requests.at(-1), { op: 'user_watch_register', node: 'sync', count: 4 }, 'the same op: the engine updates the count in place')
  await openPanel(v)
  await inAct(async () => { setInput(count()!, '3') })
  assert.equal(row('register-watch')!.disabled, true, 'back to the registered count: grey again')
})

test('§5 the count is brought into 1..1024; an empty or fractional one is grey', async (t) => {
  const requests: OpRequest[] = []
  const v = await mount([agentListener], requests)
  t.after(() => v.unmount())
  await openPanel(v)
  for (const bad of ['', '2.5', 'e']) {
    await inAct(async () => { setInput(count()!, bad) })
    assert.equal(row('register-watch')!.disabled, true, `"${bad}" cannot be sent`)
  }
  await inAct(async () => { setInput(count()!, '0') })
  assert.equal(count()!.value, '1')
  await inAct(async () => { setInput(count()!, '5000') })
  assert.equal(count()!.value, '1024')
  assert.equal(row('register-watch')!.textContent, 'Register watcher for 1024 listeners')
  assert.ok(!requests.some((r) => r.op === 'user_watch_register'), 'nothing was sent')
})

test('§6 the trigger is enabled while any of the three is possible', () => {
  const live = { live: true }
  const cases: [string, Parameters<typeof registerOptions>[0], boolean][] = [
    ['nothing registered', { ...live, listener: null, watch: null, count: 1 }, true],
    ['a one-time listener and a watch at the shown count', { ...live, listener: 'once', watch: 2, count: 2 }, true],
    ['a continuous listener and a watch at the shown count', { ...live, listener: 'continuous', watch: 2, count: 2 }, true],
    ['an empty count with nothing registered (the listeners can still be)', { ...live, listener: null, watch: null, count: null }, true],
    ['a retired project', { live: false, listener: null, watch: null, count: 1 }, false],
  ]
  for (const [what, input, any] of cases) assert.equal(registerOptions(input).any, any, what)
  const full = registerOptions({ ...live, listener: 'once', watch: 2, count: 2 })
  assert.equal(full.once.disabled, true)
  assert.equal(full.continuous.disabled, false)
  assert.equal(full.watch.disabled, true)
})

test('§7 the help text lives in tooltips on the trigger, the input and the three buttons; nothing says "you"', async (t) => {
  const v = await mount([agentListener], [])
  t.after(() => v.unmount())
  await openPanel(v)
  const tip = (el: Element | null) => el?.getAttribute('title') ?? ''
  assert.ok(tip(trigger(v.el)).length > 0, 'the trigger')
  assert.match(tip(row('register-once')), /next event/i)
  assert.match(tip(row('register-once')), /inbox/i)
  assert.match(tip(row('register-continuous')), /every event/i)
  assert.match(tip(row('register-continuous')), /inbox/i)
  assert.match(tip(row('register-watch')), /one-time notification/i)
  assert.match(tip(row('register-watch')), /armed/i)
  assert.ok(tip(count()).length > 0, 'the input')
  const all = [trigger(v.el)!, ...panel()!.querySelectorAll('*')].flatMap((el) =>
    [el.textContent ?? '', el.getAttribute('title') ?? '', el.getAttribute('aria-label') ?? ''])
  assert.ok(!all.some((x) => /\byou\b/i.test(x)), 'none of the words say "you"')
  // close this panel first: the next one is found by its class
  await inAct(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  const switched = await mount([agentListener, mineOnce, myWatch(2)], [])
  t.after(() => switched.unmount())
  await openPanel(switched)
  assert.match(tip(row('register-continuous')), /switch|replace/i, 'a switch says what it does')
  assert.match(tip(row('register-watch')), /one-time notification/i)
})

test('§1 a retired project has no Register… trigger', async (t) => {
  const v = await mount([], [], [], { state: 'archived' })
  t.after(() => v.unmount())
  assert.ok(!trigger(v.el), 'a retired project takes no registration')
})
