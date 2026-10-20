// userslots.test.tsx — the Slots tab lets the user hold slots themselves
// (docket let-the-user-manually-hold-a-number-of-a-project; USER 2026-10-20
// 13:03Z "allow the user to manually hold a number of slots themselves",
// 13:22Z "B, and yes to all three": a focused dialog, a hold that waits in the
// line FIFO and is granted whole, a hold that lasts until released; 13:50Z:
// the user shows as the standard @user mention, never "you").
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the tab offers "Hold slots…" while the project is live; its dialog asks
//      for a count (1 to the project's slots) and an optional reason and
//      sends user_slot_hold
//   §2 the user's rows wear the @user chip (Holding, Line, Recently Held);
//      the user releases their own hold (a plain release, no force, no
//      confirmation) and cancels their own waiting request; an agent's rows
//      keep force release and remove from line
//   §3 nothing on the tab says "you"
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs userslots

import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
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

test('§1 the tab offers Hold slots, and its dialog sends user_slot_hold', async (t) => {
  const requests: OpRequest[] = []
  const toasts: string[][] = []
  const v = await mount(requests, {}, toasts)
  t.after(() => v.unmount())
  const open = v.el.querySelector<HTMLButtonElement>('[data-action="hold-slots"]')
  assert.ok(open, 'a Hold slots control on the tab')
  assert.match(open.textContent ?? '', /Hold slots/)
  assert.ok(!dialog(), 'the form is a dialog, not inline')
  await inAct(async () => { open.click() })
  const box = dialog()
  assert.ok(box, 'a focused dialog opens')
  assert.match(box.textContent ?? '', /Hold slots/)
  const count = box.querySelector<HTMLInputElement>('input[type="number"]')!
  assert.equal(count.min, '1')
  assert.equal(count.max, '3', 'at most the project\'s slots')
  const reason = box.querySelector<HTMLInputElement>('input[type="text"], textarea')!
  await inAct(async () => { setInput(count, '2'); setInput(reason, 'signing run') })
  await inAct(async () => { button(box, /^Hold slots$/)!.click(); await flush(4) })
  const sent = requests.find((r) => r.op === 'user_slot_hold')
  assert.deepEqual(sent, { op: 'user_slot_hold', node: 'build', slots: 2, reason: 'signing run' })
  assert.ok(requests.filter((r) => r.op === 'slot_status').length >= 2, 'the tab re-reads after the hold')
  assert.ok(toasts.some((m) => /hold|slot/i.test(m.join(' '))), 'the user is told')
  assert.ok(!dialog(), 'the dialog closes')
})

test('§1 the dialog refuses a count outside the project\'s slots', async (t) => {
  const requests: OpRequest[] = []
  const v = await mount(requests)
  t.after(() => v.unmount())
  await inAct(async () => { v.el.querySelector<HTMLButtonElement>('[data-action="hold-slots"]')!.click() })
  const box = dialog()!
  const count = box.querySelector<HTMLInputElement>('input[type="number"]')!
  for (const bad of ['0', '4', '', '1.5']) {
    await inAct(async () => { setInput(count, bad) })
    assert.equal(button(box, /^Hold slots$/)!.disabled, true, `"${bad}" cannot be sent`)
  }
  await inAct(async () => { setInput(count, '3') })
  assert.equal(button(box, /^Hold slots$/)!.disabled, false)
  assert.ok(!requests.some((r) => r.op === 'user_slot_hold'), 'nothing was sent')
})

test('§1 no Hold slots on a retired project', async (t) => {
  const v = await mount([], { state: 'archived' })
  t.after(() => v.unmount())
  const open = v.el.querySelector<HTMLButtonElement>('[data-action="hold-slots"]')
  assert.ok(!open || open.disabled, 'a retired project takes no hold')
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
  await inAct(async () => { v.el.querySelector<HTMLButtonElement>('[data-action="hold-slots"]')!.click() })
  assert.ok(!/\byou\b/i.test(dialog()?.textContent ?? ''), 'nor does its dialog')
})
