import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView } from './harness'
import { MailListenersView, mailListenerRows } from '../src/canvas/maillisteners'
import { mailListenerState } from '../src/canvas/listeners'
import { watchdogDescription } from '../src/canvas/watchdogdescription'
import type { Watchdog } from '../src/types'
import type { CanvasNode, MailRow } from '../src/canvas/shared'

const dog = (batch?: number) => ({ id: 'worker/q', owner: 'worker', name: 'q', kind: 'fair_queue', target: 'jobs',
  state: 'armed', fired: 4, once: false, spent: false, interval_s: 5, at: '2026-10-19T07:00:00Z', batch } as Watchdog)
const worker = { id: 'worker', tier: 'sol', state: 'live', children: [] } as unknown as CanvasNode
const project = { id: 'jobs', kind: 'project', tier: 'project', state: 'live', children: [worker] } as unknown as CanvasNode
const map = new Map([['jobs', project], ['worker', worker]])
const jobs = [1, 2].map(n => ({ id: `m${n}`, from: 'boss', body: `Task ${n}`, queue: {
  held_by: 'worker', held_at: '2026-10-19T08:00:00Z', ack: true,
} } as unknown as MailRow))

test('queue description exposes batch size, immediate partial batches and single wake', () => {
  const d = watchdogDescription(dog(3))
  assert.match(d.summary, /up to 3 messages/)
  assert.match(d.summary, /one wake|once per batch/)
  assert.match(d.summary, /never waits|does not wait/)
  assert.match(watchdogDescription(dog()).summary, /one message at a time/)
})
test('ACK listener remains eligible until its batch capacity is full', () => {
  const rows = mailListenerRows(mailListenerState('jobs', [dog(3)]), map, jobs, true)
  assert.equal(rows[0].position, 1)
  assert.equal(rows[0].out, null)
  const full = mailListenerRows(mailListenerState('jobs', [dog(2)]), map, jobs, true)
  assert.equal(full[0].out, 'holding')
  assert.equal(full[0].position, null)
})
test('inbox listener table shows batch limit and every held mail link', async t => {
  const view = await mountView(<MailListenersView node={project} state={mailListenerState('jobs', [dog(3)])}
    map={map} rows={jobs} ack={true} />, host => host)
  t.after(() => view.unmount())
  assert.ok(Array.from(view.el.querySelectorAll('thead th')).some(el => el.textContent === 'Batch'))
  assert.equal(view.el.querySelector('.listener-batch')?.textContent, '3')
  assert.deepEqual(Array.from(view.el.querySelectorAll('[data-mail]')).map(el => el.getAttribute('data-mail')), ['m1', 'm2'])
})
