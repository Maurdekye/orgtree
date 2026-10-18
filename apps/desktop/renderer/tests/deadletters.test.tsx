// deadletters.test.tsx — a project's DEAD LETTERS on the desktop (Orgtree 4.4.0;
// docket `project-dead-letter-queue-failed-ack-queue-jobs-a`, user 2026-10-18
// 19:38Z-19:40Z).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the project desk's Dead letters tab: only while the project holds open
//      dead letters, with their count; one row per letter (sender, job,
//      attempts, last holder, final reason); a row opens to the whole mail and
//      the attempt history read with the letter's id;
//   §2 retry sends one dead_letter_retry for that letter;
//   §3 drop asks for a reason first and sends dead_letter_drop with it;
//   §4 "show dropped" re-reads the list with include_dropped and a dropped
//      letter offers no retry or drop.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs deadletters

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { ProjectDesk } from '../src/canvas/projectdesk'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const refs = { world: { org: 'org' }, onOpen: noop } as never

const agentNode = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, state: 'live', tier: 'haiku', model_id: 'haiku', children: [], seat: 1, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, ...extra,
} as unknown as CanvasNode)

function project(dead: number): CanvasNode {
  return {
    id: 'dl', title: 'dl', tier: 'project', kind: 'project', state: 'live', model_id: '',
    seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [] },
    parent: 'boss', charter: 'Dead letters.',
    children: [{ id: 'dz', title: 'dz', tier: 'haiku', state: 'live', busy: false, children: [] }],
    lineage: [], turns: [], audiences_held: [], mail_pending: 0, dead_letters: dead,
    last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
  } as unknown as CanvasNode
}

const letter = {
  id: 'm111', from: '@user', kind: 'notice', at: '2026-10-18T19:00:00.000Z', preview: 'Doomed task', attempts: 2,
  by: 'dz', why: 'was halted', how: 'released', dead_at: '2026-10-18T19:05:00.000Z',
}
const dropped = { ...letter, id: 'm222', preview: 'Old job', dropped: { by: 'boss', reason: 'obsolete', at: '2026-10-18T19:10:00.000Z' } }
const detail = {
  ...letter, project: 'dl', body: 'Doomed task: please build the thing.', reason: 'was halted',
  history: [
    { n: 1, by: 'dz', at: '2026-10-18T19:01:00.000Z', ended: { how: 'released', why: 'was halted', at: '2026-10-18T19:02:00.000Z' } },
    { n: 2, by: 'dz', at: '2026-10-18T19:03:00.000Z', ended: { how: 'timed_out', why: 'did not ack it after 3 reminders', at: '2026-10-18T19:05:00.000Z' } },
  ],
}

function serve(t: TestContext) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
}

async function desk(t: TestContext, nd: CanvasNode) {
  serve(t)
  const ops: OpRequest[] = []
  const answer = (b: OpRequest) => {
    if (b.op === 'dead_letters' && b.id) return detail
    if (b.op === 'dead_letters') {
      return b.include_dropped
        ? { project: 'dl', total: 1, dropped: 1, letters: [letter, dropped] }
        : { project: 'dl', total: 1, dropped: 1, letters: [letter] }
    }
    return { ok: true }
  }
  const view = await mountView(<ProjectDesk node={nd} slug="org" tree={{ slug: 'org', roots: [] } as unknown as TreePayload}
    map={new Map([[nd.id, nd], ['dz', agentNode('dz')]])} onJump={noop}
    op={(b) => { ops.push(b); return Promise.resolve(answer(b) as unknown as OpResult) }}
    toast={noop} refs={refs} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  return { view, ops }
}
const tabButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.cc-tabs button[data-tab="dead"]')
async function openTab(view: { el: HTMLElement }) {
  await inAct(async () => { tabButton(view.el)!.click(); await flush(3) })
  return view.el.querySelector<HTMLElement>('.project-dead-letters')!
}
const typeInto = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

test('§1 no Dead letters tab without dead letters', async (t) => {
  const { view } = await desk(t, project(0))
  assert.equal(tabButton(view.el) === null, true, 'no tab')
})

test('§1 the tab shows the count; a row names the sender, job, attempts, last holder and reason; details read the mail and the history', async (t) => {
  const { view, ops } = await desk(t, project(1))
  assert.match(tabButton(view.el)?.textContent ?? '', /^dead letters\s*1$/)
  const panel = await openTab(view)
  assert.ok(panel, 'the panel')
  assert.deepEqual(ops.filter((o) => o.op === 'dead_letters'), [{ op: 'dead_letters', node: 'dl', include_dropped: false }])
  const row = panel.querySelector<HTMLElement>('[data-dead="m111"]')!
  assert.ok(row, 'one row for the letter')
  const text = row.textContent ?? ''
  assert.match(text, /@user/); assert.match(text, /Doomed task/); assert.match(text, /2 attempts/)
  assert.match(text, /last held by.*dz/); assert.match(text, /was halted/)
  await inAct(async () => { row.querySelector<HTMLButtonElement>('button[data-action="open"]')!.click(); await flush(3) })
  assert.deepEqual(ops.filter((o) => o.id), [{ op: 'dead_letters', node: 'dl', id: 'm111' }])
  const open = row.querySelector('.dead-detail')?.textContent ?? ''
  assert.match(open, /please build the thing/)
  assert.match(open, /#1.*released: was halted/); assert.match(open, /#2.*timed_out: did not ack it after 3 reminders/)
})

test('§2 retry sends one dead_letter_retry for the letter', async (t) => {
  const { view, ops } = await desk(t, project(1))
  const panel = await openTab(view)
  await inAct(async () => { panel.querySelector<HTMLButtonElement>('[data-dead="m111"] button[data-action="retry"]')!.click(); await flush(3) })
  assert.deepEqual(ops.filter((o) => o.op === 'dead_letter_retry'), [{ op: 'dead_letter_retry', node: 'dl', id: 'm111' }])
})

test('§3 drop asks for a reason first; with one it sends dead_letter_drop', async (t) => {
  const { view, ops } = await desk(t, project(1))
  const panel = await openTab(view)
  await inAct(async () => { panel.querySelector<HTMLButtonElement>('[data-dead="m111"] button[data-action="drop"]')!.click(); await flush(1) })
  const confirm = () => panel.querySelector<HTMLButtonElement>('button[data-action="confirm-drop"]')!
  assert.equal(confirm().disabled, true, 'no drop without a reason')
  await inAct(async () => { confirm().click(); await flush(2) })
  assert.equal(ops.some((o) => o.op === 'dead_letter_drop'), false, 'nothing sent')
  await inAct(async () => { typeInto(panel.querySelector<HTMLInputElement>('input[data-field="drop-reason"]')!, 'obsolete request'); await flush(1) })
  assert.equal(confirm().disabled, false)
  await inAct(async () => { confirm().click(); await flush(3) })
  assert.deepEqual(ops.filter((o) => o.op === 'dead_letter_drop'),
    [{ op: 'dead_letter_drop', node: 'dl', id: 'm111', reason: 'obsolete request' }])
})

test('§4 show dropped re-reads with include_dropped; a dropped letter offers no retry or drop', async (t) => {
  const { view, ops } = await desk(t, project(1))
  const panel = await openTab(view)
  assert.equal(panel.querySelector('[data-dead="m222"]') === null, true, 'hidden by default')
  await inAct(async () => { panel.querySelector<HTMLInputElement>('input[data-action="show-dropped"]')!.click(); await flush(3) })
  assert.ok(ops.some((o) => o.op === 'dead_letters' && !o.id && o.include_dropped === true), 're-read including dropped')
  const row = panel.querySelector<HTMLElement>('[data-dead="m222"]')!
  assert.ok(row, 'the dropped letter is listed')
  assert.match(row.textContent ?? '', /dropped by boss: obsolete/)
  assert.equal(row.querySelector('button[data-action="retry"]') === null && row.querySelector('button[data-action="drop"]') === null, true)
})
