// mailwait.test.tsx - the project Mail > listeners folder's TWO WAITS (docket
// mail-queues-store-and-show-the-mail-s-own-wait-s; USER 2026-11-27 16:26:13Z m74c2267e6f07 "make sure the amount of time the
// mail waited is stored and shown separately from the amount of time the agent processing it waited", "and aligned columnwise
// respectively"). Every section draws the same two columns side by side: "Mail waited" (how long the mail sat in the queue;
// the engine's per-hand-out `mail_waited_from`) and "Agent waited" (how long the listener sat in Line; `waited_from`).
// A value a row does not have leaves its cell empty.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs mailwait

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { MailListenersView } from '../src/canvas/maillisteners'
import type { DeliveredJob, FinishedJob, WorkingJob } from '../src/canvas/maillisteners'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { mailListenerState } from '../src/canvas/listeners'
import type { CanvasNode, MailRow, OpResult } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'

const noop = () => {}
const T = '.mail-listeners-table'
const node = (id: string): CanvasNode => ({ id, title: id, parent: id === 'sync' ? 'boss' : id === 'boss' ? null : 'sync', state: 'live',
  tier: id === 'sync' ? 'project' : 'haiku', kind: id === 'sync' ? 'project' : 'agent', model_id: '', children: [], seat: 0, grant: 0,
  free: 0, scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [] } } as unknown as CanvasNode)
const map = new Map<string, CanvasNode>(['boss', 'sync', 'sa', 'sb', 'sc'].map((id) => [id, node(id)]))
const dog = (owner: string, name: string): Watchdog => ({ id: owner + '/' + name, owner, name, kind: 'fair_queue', target: 'sync',
  interval_s: 5, state: 'armed', at: '2026-10-19T07:00:00.000Z', fired: 0, once: false, spent: false } as Watchdog)
const fq = (owner: string, name: string) => ({ id: `${owner}/${name}`, owner, name, kind: 'fair_queue' as const, once: false, state: 'armed', gone: false })
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString()
const cells = (row: Element) => [...row.children].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim())
const heads = (el: Element) => [...el.querySelectorAll(`${T} thead th`)].map((h) => h.textContent)
const rowsOf = (el: Element, section: string) => [...el.querySelectorAll<HTMLTableRowElement>(`${T} .${section} tr.listener-row`)]
/** a row's two waits, read from the two aligned columns: [Mail waited, Agent waited] */
const waits = (el: Element, row: HTMLTableRowElement) => {
  const at = (label: string) => heads(el).indexOf(label)
  return [cells(row)[at('Mail waited')], cells(row)[at('Agent waited')]]
}

// sc holds a job (Working); sa and sb wait in Line
const working: WorkingJob[] = [{ mail: 'h1', gist: 'held job', copy: 'c1', agent: 'sc', dog: fq('sc', 'mail-c'), attempts: 1,
  mail_waited_from: '2026-10-19T07:40:00.000Z', waited_from: '2026-10-19T07:55:00.000Z', held_at: '2026-10-19T08:00:00.000Z' }]
const finished: FinishedJob[] = [
  { id: 2, mail: 'f2', gist: 'done', agent: 'sa', dog: fq('sa', 'mail-a'), how: 'acked', attempt: 1, ack: 'a2', ack_gist: 'ok',
    mail_waited_from: '2026-10-19T06:00:00.000Z', waited_from: '2026-10-19T06:25:00.000Z', held_at: '2026-10-19T06:30:00.000Z',
    ended_at: '2026-10-19T06:40:00.000Z' },
  // recorded before the engine stored the mail's wait: Mail waited stays blank, never guessed
  { id: 1, mail: 'f1', gist: 'older', agent: 'sb', dog: fq('sb', 'mail-b'), how: 'acked', attempt: 1, ack: 'a1', ack_gist: 'ok',
    waited_from: '2026-10-19T05:58:00.000Z', held_at: '2026-10-19T06:00:00.000Z', ended_at: '2026-10-19T06:10:00.000Z' },
]
const delivered: DeliveredJob[] = [{ id: 9, copy: 'c9', agent: 'sb', mail: 'd9', gist: 'sent on', dog: fq('sb', 'mail-b'),
  mail_waited_from: '2026-10-19T07:00:00.000Z', waited_from: '2026-10-19T07:59:00.000Z', held_at: '2026-10-19T08:00:00.000Z' }]
const waiting = [{ id: 'w1', from: 'boss', kind: 'message', body: 'queued', at: ago(120), _wait: true }] as MailRow[]

async function folder(t: TestContext, ack: boolean) {
  const listeners = [dog('sa', 'mail-a'), dog('sb', 'mail-b'), dog('sc', 'mail-c')]
  const op = async () => (ack ? { project: 'sync', ack, history: finished, history_next: null, working }
    : { project: 'sync', ack, history: delivered, history_next: null }) as unknown as OpResult
  const view = await mountView(<DeskDogsProvider value={{ org: 'org', dogs: listeners, open: noop }}>
    <MailListenersView node={map.get('sync')!} state={mailListenerState('sync', listeners)} map={map} rows={waiting} waiting={1}
      ack={ack} dogs={listeners} onOpenMail={noop} op={op} toast={noop} />
  </DeskDogsProvider>, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  return view.el
}

test('two wait columns side by side, Mail waited then Agent waited, in both modes, each saying which wait it is', async (t) => {
  const a = await folder(t, true)
  assert.deepEqual(heads(a), ['Position', 'Agent', 'Mail waited', 'Agent waited', 'Held', 'Acked', 'Mail', 'Ack', 'Batch', 'Handed', 'Watchdog', 'Action'])
  const tip = (el: Element, label: string) => [...el.querySelectorAll<HTMLElement>(`${T} thead th`)].find((h) => h.textContent === label)?.title ?? ''
  assert.match(tip(a, 'Mail waited'), /mail sat in the queue/)
  assert.match(tip(a, 'Agent waited'), /listener sat in line/)
  const r = await folder(t, false)
  assert.deepEqual(heads(r), ['Position', 'Agent', 'Mail waited', 'Agent waited', 'Delivered', 'Mail', 'Batch', 'Handed', 'Watchdog'])
})

test('every section fills the column it has a value for, aligned, and leaves the other empty (ack mode)', async (t) => {
  const el = await folder(t, true)
  const [held] = rowsOf(el, 'mail-working')
  assert.deepEqual(waits(el, held!), ['20m', '5m'], 'Working: the mail sat 20m in the queue; sc waited 5m in line')
  const line = rowsOf(el, 'mail-line')
  assert.ok(line.length >= 2)
  for (const r of line) {
    const [mail, agent] = waits(el, r)
    assert.equal(mail, '', 'a Line row has no mail')
    assert.match(agent!, /^\d+(s|m|h \d+m|d \d+h)$/, 'its listener waits, live')
  }
  const [queued] = rowsOf(el, 'mail-waiting')
  assert.deepEqual(waits(el, queued!), ['2m', ''], 'Waiting mail: the mail waits, live; no listener has it yet')
  assert.ok(queued!.querySelector('.listener-mail-wait .slot-time.live'), 'counting up in the slot time colours')
  const [acked, older] = rowsOf(el, 'mail-history')
  assert.deepEqual(waits(el, acked!), ['30m', '5m'], 'Recently Finished: both waits up to the hand-out')
  assert.deepEqual(waits(el, older!), ['', '2m'], 'an ending recorded before the mail wait was stored: blank, never guessed')
})

test('a mail back in the queue (taken back) waits from its return, not its arrival (bounce me43c972cb1c6)', async (t) => {
  const listeners = [dog('sa', 'mail-a')]
  const back = [{ id: 'w9', from: 'boss', kind: 'message', body: 'again', at: ago(660), queued_at: ago(60), _wait: true }] as MailRow[]
  const op = async () => ({ project: 'sync', ack: true, history: [], history_next: null, working: [] }) as unknown as OpResult
  const view = await mountView(<DeskDogsProvider value={{ org: 'org', dogs: listeners, open: noop }}>
    <MailListenersView node={map.get('sync')!} state={mailListenerState('sync', listeners)} map={map} rows={back} waiting={1}
      ack dogs={listeners} onOpenMail={noop} op={op} toast={noop} />
  </DeskDogsProvider>, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  const [queued] = rowsOf(view.el, 'mail-waiting')
  const [mail, agent] = waits(view.el, queued!)
  assert.match(mail!, /^6[01]s$/, `one minute since it went back, not eleven since it arrived: ${mail}`)
  assert.equal(agent, '')
})

test('round-robin: Recently Delivered fills both waits', async (t) => {
  const el = await folder(t, false)
  const [d] = rowsOf(el, 'mail-history')
  assert.deepEqual(waits(el, d!), ['1h 0m', '60s'])
  const [queued] = rowsOf(el, 'mail-waiting')
  assert.deepEqual(waits(el, queued!), ['2m', ''])
})
