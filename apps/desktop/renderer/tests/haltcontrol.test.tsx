import { FakeServer, flush, installFetch, mountView, inAct } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { HaltControl, HaltStatus } from '../src/canvas/haltcontrol'
import { DeskChat, AgentWorkstate, TrayStatus, MapModeIndicator, MapTurnAge, deriveTurnState } from '../src/canvas/desk'
import { interruptNode } from '../src/api'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

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

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const halted = { phase: 'halted' as const, by: 'user', requested_at: '2026-09-12' }
function deskNode(props: Partial<CanvasNode> = {}): CanvasNode {
  return { id: 'worker', state: 'live', tier: 'haiku', model_id: 'haiku',
    children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, ...props }
}

// Inspect the mounted desk DOM, not a source string or an isolated control:
// placement gives Halt the existing header sizing and danger-color rules.
for (const action of ['retire', 'dissolve'] as const) {
  test(`Halt is the first top action beside ${action}, sharing its styling`, async (t) => {
    installFetch(new FakeServer())
    const child = deskNode({ id: 'child' })
    const node = deskNode({ children: action === 'dissolve' ? [child] : [] })
    const calls: unknown[] = []
    const view = await mountView(<DeskChat node={node}
      map={new Map([[node.id, node], [child.id, child]])} slug={`halt-${action}`}
      op={async (o) => { calls.push(o); return {} as OpResult }}
      toast={noop} pub={false} bare />, el => el)
    t.after(() => view.unmount())
    await flush()
    const group = view.el.querySelector('.cc-head-top .cc-actions')!
    assert.ok(group, 'top action group did not render')
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('button')]
    assert.equal(buttons.length, 2)
    assert.equal(buttons[0].textContent, 'Halt')
    assert.match(buttons[1].textContent ?? '', new RegExp(`^${action} ·`))
    for (const button of buttons) {
      assert.equal(button.parentElement, group)
      assert.equal(button.matches('.cc-actions button.danger'), true,
        'both controls must use the existing header action and danger styles')
    }
    assert.equal(view.el.querySelectorAll('.halt-control').length, 1)
    assert.equal(view.el.querySelector('.cc-composer .halt-control'), null)
    await inAct(() => buttons[1].click())
    assert.equal(calls.length, 0, 'the adjacent destructive action still needs confirmation')
    assert.match(view.el.ownerDocument.querySelector('.confirm-box')?.textContent ?? '',
      new RegExp(`${action} worker`))
  })
}

test('Unhalt stays neutral and available in the top group for live and archived agents', async () => {
  installFetch(new FakeServer())
  for (const state of ['live', 'archived'] as const) {
    const node = deskNode({ state, halt: halted })
    const view = await mountView(<DeskChat node={node} map={new Map([[node.id, node]])}
      slug={`unhalt-${state}`} op={op} toast={noop} pub={false} bare />, el => el)
    try {
      await flush()
      const button = view.el.querySelector<HTMLButtonElement>('.cc-actions .halt-control')!
      assert.ok(button)
      assert.equal(button.textContent, 'Unhalt')
      assert.equal(button.classList.contains('danger'), false)
      assert.equal(button.title, 'Allow pending work to resume')
      assert.equal(button.matches(':disabled'), false)
      assert.match(button.nextElementSibling?.textContent ?? '',
        state === 'live' ? /^retire ·/ : /^rehire$/)
    } finally { await view.unmount() }
  }
})

test('moving Halt keeps public visibility and stale-identity disabled gates', async () => {
  installFetch(new FakeServer())
  for (const scenario of [
    { state: 'live', pub: true, halt: undefined, staleIdentity: false, visible: false },
    { state: 'archived', pub: true, halt: halted, staleIdentity: false, visible: false },
    { state: 'archived', pub: false, halt: undefined, staleIdentity: false, visible: false },
    { state: 'live', pub: false, halt: undefined, staleIdentity: true, visible: true },
    { state: 'live', pub: false, halt: halted, staleIdentity: true, visible: true },
  ] as const) {
    const node = deskNode({ state: scenario.state, halt: scenario.halt })
    const view = await mountView(<DeskChat node={node} map={new Map([[node.id, node]])}
      slug={`halt-gates-${scenario.state}`} op={op} toast={noop} pub={scenario.pub}
      staleIdentity={scenario.staleIdentity} bare />, el => el)
    try {
      await flush()
      const button = view.el.querySelector<HTMLButtonElement>('.halt-control')
      assert.equal(Boolean(button), scenario.visible)
      if (button) assert.equal(button.matches(':disabled'), true)
    } finally { await view.unmount() }
  }
})

test('the moved header control retains pending, settlement and unhalt receipts', async () => {
  installFetch(new FakeServer())
  const oldFetch = globalThis.fetch
  const requests: string[] = []
  let finish!: (r: Response) => void
  globalThis.fetch = ((path: string, init?: RequestInit) => {
    if (!/\/(?:halt|unhalt)$/.test(String(path))) return oldFetch(path, init)
    assert.equal(init?.method, 'POST')
    requests.push(path)
    return new Promise<Response>(resolve => { finish = resolve })
  }) as typeof fetch
  const node = deskNode()
  const notices: string[] = []
  const view = await mountView(<DeskChat node={node} map={new Map([[node.id, node]])}
    slug="halt-header" op={op} toast={xs => notices.push(...xs)} pub={false} bare />, el => el)
  const reply = (body: unknown) => inAct(() => finish({
    ok: true, headers: new Headers(), json: async () => body,
  } as Response))
  try {
    await flush()
    const button = view.el.querySelector<HTMLButtonElement>('.cc-actions .halt-control')!
    assert.ok(button)
    await inAct(() => button.click())
    assert.equal(button.disabled, true)
    assert.equal(button.textContent, 'Please wait…')
    assert.equal(view.el.ownerDocument.querySelector('.confirm-box'), null, 'Halt keeps its existing direct action')
    await reply({ halted: false, settled: false, halting: true, status: 'still settling' })
    assert.equal(button.textContent, 'Finish halt')
    assert.equal(button.classList.contains('danger'), true)
    await inAct(() => button.click())
    await reply({ halted: true, settled: true, status: 'halted' })
    assert.equal(button.textContent, 'Unhalt')
    assert.equal(button.classList.contains('danger'), false)
    await inAct(() => button.click())
    assert.equal(button.disabled, true)
    await reply({ unhalted: true })
    assert.equal(button.textContent, 'Halt')
    assert.equal(button.disabled, false)
    assert.equal(button.classList.contains('danger'), true)
    assert.deepEqual(requests, ['/api/orgs/halt-header/nodes/worker/halt',
      '/api/orgs/halt-header/nodes/worker/halt', '/api/orgs/halt-header/nodes/worker/unhalt'])
    assert.deepEqual(notices, ['still settling', 'halted', 'worker unhalted; pending work may resume'])
  } finally {
    await view.unmount()
    globalThis.fetch = oldFetch
  }
})
