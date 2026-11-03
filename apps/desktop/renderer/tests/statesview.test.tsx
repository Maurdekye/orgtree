import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentStatesView } from '../src/canvas/statesview'

const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const zero = { active: 0, idle: 0, blocked: 0, halted: 0, frozen: 0 }
const first = {
  node: 'worker', next_cursor: '41',
  totals: { h24: { ...zero, active: 3600, idle: 5400, frozen: 600 }, d7: { ...zero, active: 36000, idle: 7200, blocked: 90, halted: 20 } },
  states: [
    { state: 'idle', start: '2026-11-02T12:00:00Z', end: null, secs: 1800 },
    { state: 'active', start: '2026-11-02T11:48:00Z', end: '2026-11-02T12:00:00Z', secs: 720 },
  ],
}
const older = {
  node: 'worker', next_cursor: null,
  states: [{ state: 'frozen', start: '2026-11-02T09:00:00Z', end: '2026-11-02T11:48:00Z', secs: 10080 }],
}

test('states tab lists spans newest first with an open span reading now, and a totals line', async t => {
  const urls: string[] = []
  globalThis.fetch = (async (url: string) => { urls.push(String(url)); return response(first) }) as typeof fetch
  const view = await mountView(<AgentStatesView slug="fixture" nid="worker" />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(3) })
  const rows = [...view.el.querySelectorAll('li[data-state]')]
  assert.deepEqual(rows.map(r => r.getAttribute('data-state')), ['idle', 'active'], 'newest first')
  assert.match(rows[0].textContent ?? '', /Idle/)
  assert.match(rows[0].textContent ?? '', /now/, 'the current span has no end yet')
  assert.match(rows[0].textContent ?? '', /30m/)
  assert.match(rows[1].textContent ?? '', /12m/)
  assert.doesNotMatch(rows[1].textContent ?? '', /now/, 'a closed span names its end')
  const totals = view.el.querySelector('.agent-states-totals')
  assert.ok(totals, 'totals line present on the first page')
  const text = totals!.textContent ?? ''
  assert.match(text, /24 hours/)
  assert.match(text, /7 days/)
  assert.match(text, /Active 1h/, '24h active = 3600s')
  assert.match(text, /Idle 90m/, '24h idle = 5400s')
  assert.doesNotMatch(text.split('7 days')[0], /Halted/, 'a state with no time is left out')
  assert.match(text.split('7 days')[1], /Halted 20s/)
  assert.match(urls[0], /\/api\/orgs\/fixture\/nodes\/worker\/states\?limit=50$/)
})

test('load older asks for the next page by cursor and appends below', async t => {
  const urls: string[] = []
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url)); return response(String(url).includes('before=41') ? older : first)
  }) as typeof fetch
  const view = await mountView(<AgentStatesView slug="fixture" nid="worker" />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(3) })
  const more = [...view.el.querySelectorAll('button')].find(b => /older/i.test(b.textContent ?? ''))
  assert.ok(more, 'a Load older button while a cursor stands')
  await inAct(async () => { more!.click(); await flush(3) })
  assert.match(urls[1], /before=41/)
  const rows = [...view.el.querySelectorAll('li[data-state]')]
  assert.deepEqual(rows.map(r => r.getAttribute('data-state')), ['idle', 'active', 'frozen'])
  assert.equal([...view.el.querySelectorAll('button')].some(b => /older/i.test(b.textContent ?? '')), false,
    'no cursor left, no button')
})

test('an agent with no recorded states says so', async t => {
  globalThis.fetch = (async () => response({ node: 'worker', states: [], next_cursor: null, totals: { h24: zero, d7: zero } })) as typeof fetch
  const view = await mountView(<AgentStatesView slug="fixture" nid="worker" />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(3) })
  assert.match(view.el.textContent ?? '', /No state changes recorded yet/)
})
