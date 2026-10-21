import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { closeSavedWindow, restoredWindows, savedWindows, saveWindow, WINDOW_LAYOUT_KEY,
  windowLayoutKey } from '../src/windowlayout'
import type { SavedWindow } from '../src/windowlayout'

const row = (kind: string, target: string, org: string | null, open: boolean): SavedWindow => {
  const instance = `${kind}:${target}`
  return { key: windowLayoutKey(instance, org), kind: instance, org, open,
    restore: { agent: target, generation: 4 }, rect: { x: 10, y: 20, width: 700, height: 600 } }
}
function setup(t: import('node:test').TestContext) {
  localStorage.clear()
  const previous = Object.getOwnPropertyDescriptor(window, 'orgtreeDesktop')
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {} })
  t.after(() => {
    localStorage.clear()
    if (previous) Object.defineProperty(window, 'orgtreeDesktop', previous)
    else delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop
  })
}

test('closed history in other kinds and orgs cannot evict a still-open window', t => {
  setup(t)
  const open = row('node-inbox', 'still-open', 'first', true)
  saveWindow(open)
  for (const org of ['first', 'second', 'third']) for (const kind of ['agent-team', 'node-config'])
    for (let i = 0; i < 21; i++) saveWindow(row(kind, `closed-${i}`, org, false))
  assert.deepEqual(savedWindows().find(r => r.key === open.key), open)
  assert.deepEqual(restoredWindows('first').map(r => r.key), [open.key])
})

test('the read path retains more than 100 open windows without changing restore identity', t => {
  setup(t)
  const rows = Array.from({ length: 125 }, (_, i) => row('node-inbox', `open-${i}`, 'org', true))
  localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify(rows))
  assert.deepEqual(savedWindows(), rows)
  assert.equal(restoredWindows('org').length, 125)
})

test('closed rows retain the newest 20 independently for each kind and organization', t => {
  setup(t)
  const rows = ['a', 'b'].flatMap(org => ['agent-team', 'node-inbox'].flatMap(kind =>
    Array.from({ length: 25 }, (_, i) => row(kind, `closed-${i}`, org, false))))
  localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify(rows))
  const expected = rows.filter(r => Number(r.restore!.agent!.split('-')[1]) >= 5)
  assert.deepEqual(savedWindows(), expected)
  assert.deepEqual(savedWindows(), expected, 'a second read keeps the same records')
})

test('legacy migration preserves an open row over a closed alias before pruning history', t => {
  setup(t)
  const open = { ...row('agent-team', 'worker', 'org', true),
    key: windowLayoutKey('agent-team', 'org'), kind: 'agent-team' }
  const closedAlias = row('agent-team', 'worker', 'org', false)
  const history = Array.from({ length: 125 }, (_, i) => row('node-config', `closed-${i}`, 'elsewhere', false))
  localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify([open, closedAlias, ...history]))
  const kept = savedWindows()
  assert.deepEqual(kept.find(r => r.kind === 'agent-team:worker'), {
    ...open, key: windowLayoutKey('agent-team:worker', 'org'), kind: 'agent-team:worker',
  })
  assert.equal(kept.length, 21)
  assert.equal(restoredWindows('org').length, 1)
})

test('closing an old open window makes its placement newest in the closed group', t => {
  setup(t)
  const open = row('node-inbox', 'old-open', 'org', true)
  saveWindow(open)
  for (let i = 0; i < 20; i++) saveWindow(row('node-inbox', `closed-${i}`, 'org', false))
  closeSavedWindow(open.key)
  const kept = savedWindows()
  assert.equal(kept.length, 20)
  assert.equal(kept.some(r => r.restore?.agent === 'closed-0'), false)
  assert.deepEqual(kept.at(-1), { ...open, open: false })
})
