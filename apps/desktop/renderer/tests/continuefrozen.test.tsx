// continuefrozen.test.tsx — CONTINUE A FROZEN AGENT ON ANOTHER ACCOUNT (user
// requirement 2026-09-14, docket `continue-frozen-agents-on-another-account`).
//
// THE PROBLEM. A frozen agent stays unusable even when another signed-in
// account for its provider has room, because with automatic account fallback
// off nothing in the interface moves it. The recovery is a context-menu entry
// per eligible account that switches the binding and then releases the freeze.
//
// ⚠ WHAT THIS FILE DOES NOT TEST, DELIBERATELY. Whether an account is eligible
// is the BACKEND's answer (tests/test_continue_frozen.py): provider, the exact
// model's allowance, capacity marks, sign-in state, and the cache-only/forced
// evidence split all live there, beside the automatic path's copy of the same
// rules. Re-asserting any of it here against a hand-made `continue_accounts`
// array would only assert that a fixture is a fixture. What IS this file's:
// that the entries appear where they should and nowhere else, that the label
// is the immutable account id verbatim, and that the executor tells the truth
// about all three outcomes — including the middle one.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs continuefrozen

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentMenuEntries, continueFrozenOnAccount,
} from '../src/canvas/agentmenu'
import type { AgentMenuHandlers } from '../src/canvas/agentmenu'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode, OpResult } from '../src/canvas/shared'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5 }

function agent(extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'worker', state: 'live', tier: 'opus', model_id: 'opus',
    children: [], parent: 'boss', seat: 5, grant: 0, free: 0,
    scope: { tools: { mcp: [] }, add_dirs: [] }, audiences_held: [],
    ...extra,
  } as unknown as CanvasNode
}

const handlers = (extra: Partial<AgentMenuHandlers> = {}): AgentMenuHandlers => ({
  onInbox: noop, onSettings: noop, ...extra,
})

const labelsOf = (node: CanvasNode, h: AgentMenuHandlers) =>
  agentMenuEntries(node, h).map((e) => (e === 'sep' ? 'sep' : e.label))

/* ─── §1 the entries ─────────────────────────────────────────────────────── */

test('§1a one entry per offered account, labelled with the immutable id',
  () => {
    const node = agent({
      frozen: { error: 'usage limit' } as CanvasNode['frozen'],
      continue_accounts: ['claude-4', 'claude-7'],
    })
    const labels = labelsOf(node, handlers({ onContinueOn: noop }))
    // EXACTLY the ticket's wording, and the id verbatim — never an email, a
    // mutable label, or a provider display name
    assert.ok(labels.includes('Continue on claude-4'))
    assert.ok(labels.includes('Continue on claude-7'))
    // one per account, in the order the backend offered them
    assert.deepEqual(labels.filter((l) => l.startsWith('Continue on ')),
      ['Continue on claude-4', 'Continue on claude-7'])
  })

test('§1b it sits above Settings — recovery before configuration', () => {
  const node = agent({
    frozen: { error: 'usage limit' } as CanvasNode['frozen'],
    continue_accounts: ['claude-4'],
  })
  const labels = labelsOf(node, handlers({ onContinueOn: noop }))
  assert.ok(labels.indexOf('Continue on claude-4') < labels.indexOf('Settings'))
})

test('§1c absent unless the backend offered an account', () => {
  // ⚠ EVERY eligibility gate is the backend's, so the renderer's whole rule is
  // "is the list non-empty" — these are the shapes that produce an empty one:
  // not frozen, automatic fallback on, no eligible alternative, kiosk viewer.
  for (const node of [
    agent({ continue_accounts: [] }),
    agent({ continue_accounts: undefined }),
    agent({ frozen: { error: 'x' } as CanvasNode['frozen'], continue_accounts: [] }),
  ]) {
    const labels = labelsOf(node, handlers({ onContinueOn: noop }))
    assert.equal(labels.filter((l) => l.startsWith('Continue on ')).length, 0)
  }
  // …and a surface that cannot offer the action at all (a public/kiosk card
  // passes no handler) drops the entries even with accounts present
  const offered = agent({
    frozen: { error: 'x' } as CanvasNode['frozen'],
    continue_accounts: ['claude-4'],
  })
  assert.equal(labelsOf(offered, handlers()).filter(
    (l) => l.startsWith('Continue on ')).length, 0)
  // the control: the same node WITH a handler does offer it, so the assertion
  // above proves a gate rather than an always-empty fixture
  assert.equal(labelsOf(offered, handlers({ onContinueOn: noop })).filter(
    (l) => l.startsWith('Continue on ')).length, 1)
})

test('§1d an archived seat is never offered a continuation', () => {
  const node = agent({
    state: 'archived',
    frozen: { error: 'usage limit' } as CanvasNode['frozen'],
    continue_accounts: ['claude-4'],
  })
  assert.equal(labelsOf(node, handlers({ onContinueOn: noop })).filter(
    (l) => l.startsWith('Continue on ')).length, 0)
})

test('§1e selecting the entry hands the exact account to the handler', () => {
  const chosen: string[] = []
  const node = agent({
    frozen: { error: 'x' } as CanvasNode['frozen'],
    continue_accounts: ['claude-4', 'claude-7'],
  })
  const entries = agentMenuEntries(node, handlers({
    onContinueOn: (a) => chosen.push(a),
  }))
  for (const e of entries) {
    if (e !== 'sep' && e.label === 'Continue on claude-7') e.onSelect()
  }
  assert.deepEqual(chosen, ['claude-7'])
})

/* ─── §2 the executor's three outcomes ───────────────────────────────────── */

interface Call { url: string; body: unknown }

function stubFetch(reply: unknown, status = 200): { calls: Call[]; restore: () => void } {
  const g = globalThis as { fetch?: typeof fetch }
  const had = g.fetch
  const calls: Call[] = []
  g.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return Promise.resolve({
      ok: status < 400, status, statusText: 'err',
      headers: { get: () => null },
      json: () => Promise.resolve(reply),
    })
  }) as unknown as typeof fetch
  return { calls, restore: () => { g.fetch = had } }
}

test('§2a a continuation reports the account it continued on',
  async (t: TestContext) => {
    const f = stubFetch({
      switched: true, resumed: true, state: 'continued', account: 'claude-7',
      status: 'worker continues on claude-7', released: ['limit'],
    })
    t.after(f.restore)
    const said: string[][] = []
    await continueFrozenOnAccount('mine', 'worker', 'claude-7',
      (lines) => { if (lines) said.push(lines) })
    assert.match(f.calls[0].url, /\/nodes\/worker\/continue-on$/)
    assert.deepEqual(f.calls[0].body, { account: 'claude-7' })
    assert.match(said[0][0], /continues on claude-7/)
  })

test('§2b A SWITCH WHOSE RELEASE FAILED IS NOT A CONTINUATION',
  async (t: TestContext) => {
    // ⚠ THE CASE THIS TEST EXISTS FOR. The agent IS on the new account and IS
    // still frozen. Calling that "continued" sends the operator away believing
    // work resumed; calling it "failed" sends them to re-run a switch that
    // already happened. It has to say both halves.
    const f = stubFetch({
      switched: true, resumed: false, state: 'switched_not_resumed',
      account: 'claude-7', retry: '/api/orgs/mine/nodes/worker/unstick',
      status: 'worker is now on claude-7 but is STILL FROZEN — releasing it failed.',
    })
    t.after(f.restore)
    const said: string[][] = []
    await continueFrozenOnAccount('mine', 'worker', 'claude-7',
      (lines) => { if (lines) said.push(lines) })
    const text = said[0].join(' ')
    assert.match(text, /still frozen/i, 'it did not say the freeze remains')
    assert.match(text, /claude-7/, 'it did not say where the agent now is')
    assert.match(text, /unstick/i, 'it offered no way to finish the move')
    assert.doesNotMatch(said[0][0], /^worker continues/,
      'a half-finished move was reported as a continuation')
  })

test('§2c a refusal changed nothing and says so', async (t: TestContext) => {
  const f = stubFetch({ detail: 'claude-7 has no capacity for opus right now' }, 409)
  t.after(f.restore)
  const said: string[][] = []
  await continueFrozenOnAccount('mine', 'worker', 'claude-7',
    (lines) => { if (lines) said.push(lines) })
  assert.match(said[0][0], /could not continue worker on claude-7/)
  assert.match(said[0][0], /no capacity/)
})

test('§2d a double activation fires ONE request, not two',
  async (t: TestContext) => {
    // a menu can be re-raised and an entry double-clicked, and what is behind
    // it moves an account binding — so the second firing must not happen
    const f = stubFetch({
      switched: true, resumed: true, state: 'continued', account: 'claude-7',
      status: 'ok',
    })
    t.after(f.restore)
    await Promise.all([
      continueFrozenOnAccount('mine', 'worker', 'claude-7', noop),
      continueFrozenOnAccount('mine', 'worker', 'claude-7', noop),
    ])
    assert.equal(f.calls.length, 1, 'the same move was sent twice')
    // …and the guard clears, so an honest later attempt still works
    await continueFrozenOnAccount('mine', 'worker', 'claude-7', noop)
    assert.equal(f.calls.length, 2)
  })

test('§2e a failed attempt still clears the guard', async (t: TestContext) => {
  const f = stubFetch({ detail: 'nope' }, 422)
  t.after(f.restore)
  await continueFrozenOnAccount('mine', 'worker', 'claude-7', noop)
  await continueFrozenOnAccount('mine', 'worker', 'claude-7', noop)
  assert.equal(f.calls.length, 2, 'a refusal left the node permanently locked')
})

/* ─── §3 it reaches a real card's menu ───────────────────────────────────── */

test('§3 the frozen card carries the entry into its own context menu',
  async (t: TestContext) => {
    const node = agent({
      frozen: { error: 'usage limit' } as CanvasNode['frozen'],
      continue_accounts: ['claude-7'],
    })
    const view = await mountView(
      <NodeSquare node={node} pos={{ x: 0, y: 0 }} lod="norm" focused={false}
        dragging={false} isDrop={false} seats={seats}
        map={new Map([[node.id, node]])} op={op} slug="mine" toast={noop}
        pxc={1} zoom={1} compactAt={0.8} pub={false}
        maxTop={0} kioskRemaining={null} cascadeAlloc mapMode={false}
        onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
        onInbox={noop} onLineage={noop} onOpenDoc={noop}
        onRecenter={noop} onJump={noop} onMailLink={noop} onWorkLink={noop}
        onDragStart={noop} onDragMove={noop} onDragEnd={noop}
        onDragCancel={noop} />,
      (el) => el)
    t.after(() => view.unmount())
    await flush()
    const card = view.el.querySelector('.sq') as HTMLElement
    assert.ok(card, 'no card mounted')
    await inAct(() => {
      card.dispatchEvent(new (window as unknown as Window & typeof globalThis)
        .MouseEvent('contextmenu',
          { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10 }))
    })
    await flush(2)
    const labels = [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
      .map((b) => b.textContent ?? '')
    assert.ok(labels.includes('Continue on claude-7'),
      `the frozen card's menu had: ${labels.join(' | ')}`)
    // it is an ordinary menu item, so it inherits the menu's own keyboard
    // walking and activation (contextmenu.test.tsx §A) rather than needing
    // its own key handling
    const item = [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
      .find((b) => b.textContent === 'Continue on claude-7') as HTMLButtonElement
    assert.equal(item.tagName, 'BUTTON')
    assert.equal(item.getAttribute('role'), 'menuitem')
  })
