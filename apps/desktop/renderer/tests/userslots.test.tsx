// userslots.test.tsx — the Slots tab lets the user hold slots themselves
// (docket let-the-user-manually-hold-a-number-of-a-project; USER 2026-10-20
// 13:03Z "allow the user to manually hold a number of slots themselves",
// 13:22Z "B, and yes to all three": a hold that waits in the line FIFO and is
// granted whole, a hold that lasts until released; 13:50Z: the user shows as
// the standard @user mention, never "you"; 16:35Z, docket
// slots-tab-header-hold-n-slots-button-with-number: the control moves into the
// desk header, left of the pin / pop-out / modal buttons, with a number input
// and a button that holds at once).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the desk header offers a number input (default 1) and a button "Hold 1
//      slot" / "Hold N slots" while the project is live: a click sends
//      user_slot_hold at once, no dialog; the count runs from 1 to the total
//      minus the slots the user holds or has asked for (a waiting request
//      counts, an agent's hold does not); the button is grey when none is left
//   §2 the user's rows wear the @user chip (Holding, Line, Recently Held);
//      the user releases their own hold (a plain release, no force, no
//      confirmation) and cancels their own waiting request; an agent's rows
//      keep force release and remove from line
//   §3 nothing on the tab says "you", the header control included
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs userslots

import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import type { ReactNode } from 'react'
import { SlotsView } from '../src/canvas/slotsdesk'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'

const refs = { world: { org: 'org' }, onOpen: () => {} } as never
const node = (extra: Record<string, unknown> = {}) =>
  ({ id: 'build', kind: 'project', tier: 'project', state: 'live', children: [], ...extra }) as unknown as CanvasNode
// the tree's view of the line: an agent's claim and the user's request
const state = {
  total: 3, held: [],
  line: [
    { agent: 'user', dog: 'user/u123', name: 'user-hold', place: 1, slots: 2, since: '2026-10-20T10:00:00Z' },
    { agent: 'dev', dog: 'dev/build-slot', name: 'build-slot', place: 2, slots: 1, since: '2026-10-20T10:01:00Z' },
  ],
}
const status = {
  project: 'build', slots: 3, held: 3,
  holders: [
    { lease: 'sU', agent: 'user', slots: 2, reason: 'signing run', since: '2026-10-20T09:00:00Z', queued: '2026-10-20T08:59:00Z' },
    { lease: 'sD', agent: 'dev', slots: 1, reason: 'compile', since: '2026-10-20T09:30:00Z' },
  ],
  line: [
    { position: 1, agent: 'user', dog: 'u123', slots: 2, since: '2026-10-20T10:00:00Z' },
    { position: 2, agent: 'dev', dog: 'build-slot', slots: 1, since: '2026-10-20T10:01:00Z' },
  ],
  history: [{ lease: 'sOld', agent: 'user', slots: 1, since: '2026-10-19T09:00:00Z', ended: '2026-10-19T10:00:00Z', how: 'released', by: '@user' }],
  history_next: null,
}

function ops(requests: OpRequest[]) {
  return async (req: OpRequest): Promise<OpResult> => {
    requests.push(req)
    return (req.op === 'slot_status' ? status : { ok: true }) as unknown as OpResult
  }
}
const mount = async (requests: OpRequest[], extra: Record<string, unknown> = {}, toasts: string[][] = []) => {
  const v = await mountView(<SlotsView node={node(extra)} state={state} map={new Map()} op={ops(requests)}
    toast={(m) => { toasts.push(m as string[]) }} refs={refs} />, (el) => el)
  await inAct(async () => { await flush(6) })
  return v
}
const setInput = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (root: ParentNode, label: RegExp) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => label.test(b.textContent ?? ''))

// the header's Hold control: the slot_status the test serves can be swapped between reads
// (`held` slots the user holds, `waiting` slots they have requested, `agent` slots an agent holds)
const rows = (held: number, waiting: number, agent = 0) => ({
  project: 'build', slots: 3, held: held + agent,
  holders: [
    ...(held ? [{ lease: 'sU', agent: 'user', slots: held, since: '2026-10-20T09:00:00Z' }] : []),
    ...(agent ? [{ lease: 'sD', agent: 'dev', slots: agent, since: '2026-10-20T09:30:00Z' }] : []),
  ],
  line: waiting ? [{ position: 1, agent: 'user', dog: 'u9', slots: waiting, since: '2026-10-20T10:00:00Z' }] : [],
  history: [], history_next: null,
})
const bareState = { total: 3, held: [], line: [] }
async function mountHold(box: { status: unknown }, requests: OpRequest[], extra: Record<string, unknown> = {}, toasts: string[][] = [], actions?: ReactNode) {
  const op = async (req: OpRequest): Promise<OpResult> => {
    requests.push(req)
    return (req.op === 'slot_status' ? box.status : { ok: true }) as unknown as OpResult
  }
  const v = await mountView(<SlotsView node={node(extra)} state={bareState} map={new Map()} op={op}
    toast={(m) => { toasts.push(m as string[]) }} refs={refs} actions={actions} />, (el) => el)
  await inAct(async () => { await flush(6) })
  return v
}
const holdControl = (root: ParentNode) => ({
  group: root.querySelector<HTMLElement>('.slot-hold'),
  input: root.querySelector<HTMLInputElement>('.slot-hold input[type="number"]'),
  button: root.querySelector<HTMLButtonElement>('.slot-hold [data-action="hold-slots"]'),
})

test('§1 the Hold control sits in the header, left of the pin / pop-out / modal buttons, not in the tab body', async (t) => {
  const corner = <span id="corner" className="panel-corner">corner</span>
  const v = await mountHold({ status: rows(0, 0) }, [], {}, [], corner)
  t.after(() => v.unmount())
  const bar = v.el.querySelector<HTMLElement>('[role="toolbar"]')!
  assert.ok(bar, 'the header toolbar')
  const { group, input, button } = holdControl(bar)
  assert.ok(group && input && button, 'a number input and a Hold button in the header')
  const cornerEl = bar.querySelector('#corner')!
  assert.ok(group.compareDocumentPosition(cornerEl) & 4, 'directly before the window buttons')
  assert.ok(!v.el.querySelector('.slots-table-scroll [data-action="hold-slots"]'), 'nothing in the tab body')
  assert.ok(!v.el.querySelector('.user-reg-tools'), 'the old body strip is gone')
  assert.equal(input.type, 'number')
  assert.equal(input.value, '1', 'the count starts at 1')
  assert.equal(input.min, '1')
  assert.equal(input.max, '3')
  assert.equal(button.textContent, 'Hold 1 slot')
})

test('§1 the Hold control also shows where the tab has no window buttons of its own (the standalone modal)', async (t) => {
  const v = await mountHold({ status: rows(0, 0) }, [])
  t.after(() => v.unmount())
  const { group, button } = holdControl(v.el)
  assert.ok(group && button, 'the control without actions')
  assert.ok(group.closest('[role="toolbar"]'), 'still in a header toolbar')
})

test('§1 the button names the count and a click holds at once: no dialog', async (t) => {
  const requests: OpRequest[] = []
  const toasts: string[][] = []
  const v = await mountHold({ status: rows(0, 0) }, requests, {}, toasts)
  t.after(() => v.unmount())
  const { input, button } = holdControl(v.el)
  await inAct(async () => { setInput(input!, '2') })
  assert.equal(button!.textContent, 'Hold 2 slots', 'the label follows the number')
  await inAct(async () => { setInput(input!, '1') })
  assert.equal(button!.textContent, 'Hold 1 slot', 'singular for one')
  await inAct(async () => { setInput(input!, '2') })
  await inAct(async () => { button!.click(); await flush(4) })
  assert.ok(!dialog(), 'no dialog opens')
  assert.deepEqual(requests.find((r) => r.op === 'user_slot_hold'), { op: 'user_slot_hold', node: 'build', slots: 2 })
  assert.ok(requests.filter((r) => r.op === 'slot_status').length >= 2, 'the tab re-reads after the hold')
  assert.ok(toasts.some((m) => /slot/i.test(m.join(' '))), 'the user is told')
  assert.equal(holdControl(v.el).input!.value, '1', 'the count goes back to 1')
})

test('§1 the count runs from 1 to the total minus what the user holds or has asked for; an agent\'s hold does not reduce it', async (t) => {
  const box = { status: rows(0, 0, 2) as unknown }
  const requests: OpRequest[] = []
  const v = await mountHold(box, requests)
  t.after(() => v.unmount())
  assert.equal(holdControl(v.el).input!.max, '3', 'agents\' holds leave the whole total open to the user')
  // the user asks for 2: a request still waiting in the line counts as held
  box.status = rows(0, 2, 2)
  await inAct(async () => { setInput(holdControl(v.el).input!, '2') })
  await inAct(async () => { holdControl(v.el).button!.click(); await flush(6) })
  const { input, button } = holdControl(v.el)
  assert.equal(input!.max, '1', 'the waiting request counts as already held')
  await inAct(async () => { setInput(input!, '5') })
  assert.equal(input!.value, '1', 'a larger count is brought back to the most the user may still ask for')
  assert.equal(button!.textContent, 'Hold 1 slot')
})

test('§1 a hold and a wait together leave only the rest', async (t) => {
  const v = await mountHold({ status: rows(1, 1) }, [])
  t.after(() => v.unmount())
  assert.equal(holdControl(v.el).input!.max, '1')
  assert.equal(holdControl(v.el).button!.disabled, false)
})

test('§1 the button is grey when the user holds or has asked for every slot', async (t) => {
  for (const status of [rows(3, 0), rows(2, 1), rows(1, 2, 0), rows(0, 3, 0)]) {
    const requests: OpRequest[] = []
    const v = await mountHold({ status }, requests)
    const { input, button } = holdControl(v.el)
    assert.equal(button!.disabled, true, 'nothing left to hold')
    assert.equal(input!.disabled, true)
    await inAct(async () => { button!.click(); await flush(2) })
    assert.ok(!requests.some((r) => r.op === 'user_slot_hold'), 'a grey button sends nothing')
    v.unmount()
  }
})

test('§1 a count that is not a whole number keeps the button grey', async (t) => {
  const v = await mountHold({ status: rows(0, 0) }, [])
  t.after(() => v.unmount())
  const { input } = holdControl(v.el)
  for (const bad of ['', '1.5', 'e']) {
    await inAct(async () => { setInput(input!, bad) })
    assert.equal(holdControl(v.el).button!.disabled, true, `"${bad}" cannot be sent`)
  }
  await inAct(async () => { setInput(input!, '0') })
  assert.equal(holdControl(v.el).input!.value, '1', 'zero is brought up to one')
  assert.equal(holdControl(v.el).button!.disabled, false)
  await inAct(async () => { setInput(input!, '4') })
  assert.equal(holdControl(v.el).input!.value, '3', 'four is brought down to the three slots')
})

test('§1 the help text of the old dialog is the control\'s tooltip', async (t) => {
  const v = await mountHold({ status: rows(0, 0) }, [])
  t.after(() => v.unmount())
  const { input, button } = holdControl(v.el)
  const tip = button!.getAttribute('title') ?? ''
  assert.match(tip, /first come first served/i, 'it waits in the line like an agent\'s claim')
  assert.match(tip, /all .*free|whole/i, 'and is granted when all the requested slots are free together')
  assert.match(tip, /until .*released/i, 'it lasts until released')
  assert.match(tip, /restart/i, 'across a restart too')
  assert.ok((input!.getAttribute('title') ?? '').length > 0, 'the input says what the number is')
})

test('§1 no Hold control on a retired project', async (t) => {
  const v = await mountHold({ status: rows(0, 0) }, [], { state: 'archived' })
  t.after(() => v.unmount())
  assert.ok(!holdControl(v.el).group, 'a retired project takes no hold')
})

test('§2 the user\'s rows wear the @user chip; an agent keeps its own link', async (t) => {
  const v = await mount([])
  t.after(() => v.unmount())
  const holding = v.el.querySelector('.slots-holding')!
  const hold = [...holding.querySelectorAll('tr.slot-row')]
  assert.equal(hold.length, 2)
  const chip = hold[0]!.querySelector('.slot-agent .ref-chip.ref-mail')
  assert.ok(chip, 'the user\'s holder cell is the @user chip')
  assert.equal(chip.textContent, '@user')
  assert.ok(!hold[1]!.querySelector('.ref-chip.ref-mail'), 'an agent holder is not the user chip')
  const line = [...v.el.querySelectorAll('.slots-line tr.slot-row')]
  assert.equal(line.length, 2)
  assert.equal(line[0]!.querySelector('.slot-agent .ref-chip.ref-mail')?.textContent, '@user')
  const done = [...v.el.querySelectorAll('.slots-history tr.slot-row')]
  assert.equal(done[0]!.querySelector('.slot-agent .ref-chip.ref-mail')?.textContent, '@user')
})

test('§2 the user releases their own hold: a plain release, no force, no confirmation', async (t) => {
  const requests: OpRequest[] = []
  const toasts: string[][] = []
  const v = await mount(requests, {}, toasts)
  t.after(() => v.unmount())
  const rows = [...v.el.querySelectorAll('.slots-holding tr.slot-row')]
  const mine = rows[0]!.querySelector<HTMLButtonElement>('.slot-action button')!
  assert.equal(mine.dataset.action, 'release')
  assert.match(mine.textContent ?? '', /^release$/)
  assert.ok(!rows[0]!.querySelector('[data-action="force-release"]'), 'the user\'s hold is not force-released')
  await inAct(async () => { mine.click(); await flush(4) })
  assert.deepEqual(requests.find((r) => r.op === 'slot_release'), { op: 'slot_release', lease: 'sU' })
  assert.ok(!dialog(), 'no confirmation for releasing one\'s own hold')
  assert.ok(toasts.some((m) => /released/i.test(m.join(' '))))
  // an agent's lease still takes the force release, confirmed
  const theirs = rows[1]!.querySelector<HTMLButtonElement>('[data-action="force-release"]')
  assert.ok(theirs, 'an agent\'s holder keeps force release')
  await inAct(async () => { theirs.click() })
  assert.ok(dialog(), 'force release asks first')
})

test('§2 the user cancels their own waiting request; an agent\'s claim keeps remove from line', async (t) => {
  const requests: OpRequest[] = []
  const v = await mount(requests)
  t.after(() => v.unmount())
  const line = [...v.el.querySelectorAll('.slots-line tr.slot-row')]
  const mine = line[0]!.querySelector<HTMLButtonElement>('.slot-action button')!
  assert.equal(mine.dataset.action, 'cancel-request')
  assert.match(mine.textContent ?? '', /cancel request/)
  await inAct(async () => { mine.click(); await flush(4) })
  assert.deepEqual(requests.find((r) => r.op === 'user_slot_cancel'), { op: 'user_slot_cancel', node: 'build', dog: 'u123' })
  assert.ok(!requests.some((r) => r.op === 'slot_unqueue' && r.agent === 'user'), 'not the agent-removal op')
  const theirs = line[1]!.querySelector<HTMLButtonElement>('.slot-action button')!
  assert.equal(theirs.dataset.action, 'unqueue')
  await inAct(async () => { theirs.click(); await flush(4) })
  assert.deepEqual(requests.find((r) => r.op === 'slot_unqueue'), { op: 'slot_unqueue', node: 'build', agent: 'dev' })
})

test('§3 nothing on the tab says "you"', async (t) => {
  const v = await mount([])
  t.after(() => v.unmount())
  assert.ok(!/\byou\b/i.test(v.el.textContent ?? ''), v.el.textContent?.match(/.{20}\byou\b.{20}/i)?.[0])
  const texts = [...v.el.querySelectorAll<HTMLElement>('.slot-hold, .slot-hold *')].flatMap((el) =>
    [el.textContent ?? '', el.getAttribute('title') ?? '', el.getAttribute('aria-label') ?? ''])
  assert.ok(texts.length > 0, 'the header control is there to read')
  assert.ok(!texts.some((x) => /\byou\b/i.test(x)), 'nor does the header control or its tooltips')
})
