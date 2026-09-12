import { mountView, inAct } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { HaltControl, HaltStatus } from '../src/canvas/haltcontrol'
import { AgentWorkstate, TrayStatus, MapModeIndicator, MapTurnAge, deriveTurnState } from '../src/canvas/desk'
import { interruptNode } from '../src/api'
import type { CanvasNode } from '../src/canvas/shared'

// User invariant, docs/v2-user-decisions.md (12 September 2026):
// "A turn cannot run while its agent is halted."
// The UI must never label a signalled-but-unsettled turn as Halted.
test('halt waits for settlement, then offers explicit unhalt; interrupt keeps its own route', async () => {
  const paths: string[] = []
  const replies = [
    { halted: false, settled: false, halting: true, status: 'still settling' },
    { halted: true, settled: true, status: 'halted' },
    { unhalted: true },
    { interrupted: true },
  ]
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    assert.equal(init?.method, 'POST')
    paths.push(path)
    return { ok: true, headers: new Headers(), json: async () => replies.shift() } as Response
  }) as typeof fetch
  const notices: string[] = []
  const view = await mountView(<HaltControl slug="org" nid="worker" toast={(xs) => notices.push(...xs)} />,
    (el) => el.textContent)
  try {
    assert.equal(view.last(), 'Halt')
    await inAct(() => view.el.querySelector('button')!.click())
    assert.equal(view.last(), 'Finish halt')
    assert.doesNotMatch(view.el.textContent ?? '', /Unhalt/)
    await inAct(() => view.el.querySelector('button')!.click())
    assert.equal(view.last(), 'Unhalt')
    await inAct(() => view.el.querySelector('button')!.click())
    assert.equal(view.last(), 'Halt')
    await interruptNode('org', 'worker')
    assert.deepEqual(paths, ['/api/orgs/org/nodes/worker/halt', '/api/orgs/org/nodes/worker/halt',
      '/api/orgs/org/nodes/worker/unhalt', '/api/orgs/org/nodes/worker/interrupt'])
    assert.match(notices.join(' '), /still settling/)
  } finally {
    await view.unmount()
    globalThis.fetch = oldFetch
  }
})

test('a pending halt request stays disabled without claiming success', async () => {
  const oldFetch = globalThis.fetch
  let finish!: (r: Response) => void
  globalThis.fetch = (() => new Promise<Response>((resolve) => { finish = resolve })) as typeof fetch
  const view = await mountView(<HaltControl slug="org" nid="worker" toast={() => {}} />, (el) => el.textContent)
  try {
    await inAct(() => view.el.querySelector('button')!.click())
    assert.equal(view.el.querySelector('button')!.disabled, true)
    assert.equal(view.last(), 'Please wait…')
    await inAct(() => finish({ ok: true, headers: new Headers(), json: async () => ({ halted: true, settled: true, status: 'halted' }) } as Response))
    assert.equal(view.last(), 'Unhalt')
    assert.equal(view.el.querySelector('button')!.disabled, false)
  } finally {
    await view.unmount()
    globalThis.fetch = oldFetch
  }
})

test('halt status overrides stale working indicators in every view', async () => {
  const halt = { phase: 'halted' as const, requested_at: '2026-09-12T00:00:00Z', by: 'user' }
  const node = { id: 'worker', state: 'live', tier: 'luna', busy: true, responding: true,
    inflight_at: '2026-09-12T00:00:00Z', halt } as unknown as CanvasNode
  assert.equal(deriveTurnState({ ...node, phase: 'compacting' }), 'idle')
  const view = await mountView(<><HaltStatus halt={halt} /><AgentWorkstate node={node} />
    <TrayStatus node={node} /><MapModeIndicator node={node} /><MapTurnAge node={node} /></>,
  (el) => el.textContent)
  try {
    assert.equal(view.el.querySelectorAll('[role="status"]').length, 4)
    assert.equal(view.last(), 'HaltedHaltedHaltedHalted')
    await view.render(<HaltStatus halt={{ ...halt, phase: 'halting' }} />)
    assert.equal(view.last(), 'Halting…')
    assert.match(view.el.querySelector('[role="status"]')!.getAttribute('title')!, /still ending/)
  } finally { await view.unmount() }
})

test('a refused unhalt keeps the agent visibly halted', async () => {
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error('request refused') }) as typeof fetch
  const notices: string[] = []
  const view = await mountView(<HaltControl slug="org" nid="worker"
    halt={{ phase: 'halted', by: 'user', requested_at: '2026-09-12' }}
    toast={(xs) => notices.push(...xs)} />, (el) => el.textContent)
  try {
    await inAct(() => view.el.querySelector('button')!.click())
    assert.equal(view.last(), 'Unhalt')
    assert.match(notices.join(' '), /request refused/)
  } finally {
    await view.unmount()
    globalThis.fetch = oldFetch
  }
})
