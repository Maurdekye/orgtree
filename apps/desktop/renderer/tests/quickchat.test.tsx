// Quick chat (docket quick-prompt-hire-kick-off-and-focus-an-agent-fr): the
// header box hires, kicks off and focuses a new agent on Enter, with model,
// effort and superior following the user's last manual choices.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { legacyAppBackend } from './appfeed-fixture'
import { QuickChat } from '../src/QuickChatBox'
import {
  quickChatName, quickChatTier, rememberEffort, rememberHire,
} from '../src/quickchat'
import type { OpRequest, TreePayload } from '../src/types'
import { trayRows } from '../src/canvas/agenttray'
import type { CanvasNode } from '../src/canvas/shared'

const noop = () => {}
const node = (id: string, state = 'live', children: unknown[] = []) =>
  ({ id, state, children, parent: null })
const tree = {
  slug: 'org', name: 'Org', default_top_grant: 50,
  default_effort: '', effort_default: 'high',
  roots: [node('boss', 'live', [node('old-hand', 'archived')])],
} as unknown as TreePayload

function providers(enabled: string[]) {
  globalThis.fetch = legacyAppBackend((async (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const payload = path === '/api/providers'
      ? { providers: ['claude', 'openai', 'google', 'openrouter'].map(id => ({
          id, hire_enabled: enabled.includes(id), status: { installed: enabled.includes(id) } })) }
      : {}
    return { ok: true, status: 200, headers: new Headers(), json: async () => payload }
  }) as typeof fetch)
}
const type = async (box: HTMLInputElement, v: string) => inAct(async () => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  set.call(box, v)
  box.dispatchEvent(new window.Event('input', { bubbles: true }))
})
const enter = async (box: HTMLInputElement) => inAct(async () => {
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await flush(8)
})
const buttons = (el: Element) => [...el.querySelectorAll('.quickchat-btn')].map(b => b.textContent)

async function mount(ops: OpRequest[], hired: string[], reply: Record<string, unknown> = {}) {
  const op = async (b: OpRequest) => { ops.push(b); return { node: b.name, ...reply } }
  const view = await mountView(<QuickChat slug="org" tree={tree} op={op as never}
    toast={noop} onHired={(id) => hired.push(id)} />, el => el)
  await inAct(async () => { await flush(8) })
  return view
}

test('the name comes from the message words only, unique, always valid', () => {
  const none = () => false
  assert.equal(quickChatName('Please fix the login bug in the desktop app', none), 'fix-login-bug')
  assert.equal(quickChatName('fix login bug', n => n === 'fix-login-bug'), 'fix-login-bug-2')
  assert.equal(quickChatName('fix login bug', n => n === 'fix-login-bug' || n === 'fix-login-bug-2'),
    'fix-login-bug-3')
  assert.equal(quickChatName('?? !!', none), 'chat')
  assert.equal(quickChatName('user', none), 'user-chat')
  assert.equal(quickChatName('Résumé parser\nsecond line ignored', none), 'resume-parser')
  const long = quickChatName('internationalization localization containerization', none)
  assert.ok(long.length <= 30 && /^[a-z0-9][a-z0-9-]*$/.test(long), long)
})

test('the model with no history prefers Opus, then Sol, then Flash, then anything offered', () => {
  assert.equal(quickChatTier(undefined, ['haiku', 'sonnet', 'opus', 'sol']), 'opus')
  assert.equal(quickChatTier(undefined, ['luna', 'sol', 'flash']), 'sol')
  assert.equal(quickChatTier(undefined, ['pro', 'flash']), 'flash')
  assert.equal(quickChatTier(undefined, ['terra']), 'terra')
  assert.equal(quickChatTier(undefined, []), '')
  assert.equal(quickChatTier('sonnet', ['sonnet', 'opus']), 'sonnet')
  assert.equal(quickChatTier('fable', ['sonnet', 'opus']), 'opus', 'a model no longer offered falls back')
})

test('with no history: Opus, the org default effort, top level; Enter hires, kicks off and focuses', async () => {
  localStorage.clear(); providers(['claude'])
  const ops: OpRequest[] = [], hired: string[] = []
  const view = await mount(ops, hired)
  try {
    assert.deepEqual(buttons(view.el), ['opus', 'default (high)', 'top level'])
    const box = view.el.querySelector<HTMLInputElement>('.quickchat-input')!
    await type(box, 'Write the release notes for 4.2')
    await enter(box)
    assert.deepEqual(ops, [{ op: 'hire', name: 'write-release-notes', tier: 'opus', parent: null,
      grant: 50, kickoff: 'Write the release notes for 4.2', kickoff_kind: 'message' }])
    assert.ok(!('charter' in ops[0]!) && !('effort' in ops[0]!), 'no charter, effort follows the org')
    assert.deepEqual(hired, ['write-release-notes'])
    assert.equal(box.value, '', 'the box clears after a hire')
  } finally { await view.unmount(); localStorage.clear() }
})

test('a manual hire and a manual effort pick become the defaults; a stale superior falls back', async () => {
  localStorage.clear(); providers(['claude', 'openai'])
  rememberHire('org', { tier: 'sol', superior: 'boss' })
  rememberEffort('max')
  const ops: OpRequest[] = [], hired: string[] = []
  const view = await mount(ops, hired)
  try {
    assert.deepEqual(buttons(view.el), ['sol', 'max', 'boss'])
    const box = view.el.querySelector<HTMLInputElement>('.quickchat-input')!
    await type(box, 'boss')
    await enter(box)
    assert.equal(ops[0]!.parent, 'boss')
    assert.equal(ops[0]!.grant, 0, 'a report draws on its superior, like the hire sheet')
    assert.equal(ops[0]!.effort, 'max')
    assert.equal(ops[0]!.name, 'boss-2', 'never the name of an existing agent')
  } finally { await view.unmount() }
  rememberHire('org', { tier: 'sol', superior: 'old-hand' })
  const again = await mount([], [])
  try {
    assert.equal(buttons(again.el)[2], 'top level', 'an archived superior is not offered')
  } finally { await again.unmount(); localStorage.clear() }
})

test('a name taken behind this window is retried with the next suffix', async () => {
  localStorage.clear(); providers(['claude'])
  const ops: OpRequest[] = [], hired: string[] = []
  let first = true
  const op = async (b: OpRequest) => {
    ops.push(b)
    if (first) { first = false; throw new Error('an agent named triage already exists in this organization') }
    return { node: b.name }
  }
  const view = await mountView(<QuickChat slug="org" tree={tree} op={op as never}
    toast={noop} onHired={(id) => hired.push(id)} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    const box = view.el.querySelector<HTMLInputElement>('.quickchat-input')!
    await type(box, 'triage')
    await enter(box)
    assert.deepEqual(ops.map(o => o.name), ['triage', 'triage-2'])
    assert.deepEqual(hired, ['triage-2'])
  } finally { await view.unmount(); localStorage.clear() }
})

test('each button opens its menu inline, and a pick there becomes the choice', async () => {
  localStorage.clear(); providers(['claude'])
  const view = await mount([], [])
  try {
    const open = async (sel: string) => inAct(async () => {
      view.el.querySelector<HTMLButtonElement>(sel)!.dispatchEvent(
        new window.MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }))
      await flush(4)
    })
    const items = () => [...document.querySelectorAll('.ctxmenu button.ctxmenu-item')]
      .map(b => (b.textContent || '').trim())
    await open('.quickchat-superior')
    assert.deepEqual(items(), ['top level ✓', 'boss'])
    await open('.quickchat-effort')
    assert.deepEqual(items(), ['org default (high) ✓', 'low', 'medium', 'high', 'xhigh', 'max'])
    await inAct(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu button.ctxmenu-item')]
        .find(b => b.textContent?.trim() === 'low')!.click()
      await flush(4)
    })
    assert.equal(buttons(view.el)[1], 'low')
  } finally { await view.unmount(); localStorage.clear() }
})

test('the superior menu lists agents in the Agents List order, never alphabetically', async () => {
  localStorage.clear(); providers(['claude'])
  const t = { ...tree, roots: [node('zed', 'live', [node('amy')]), node('boss')] } as unknown as TreePayload
  const items = () => [...document.querySelectorAll('.ctxmenu button.ctxmenu-item')]
    .map(b => (b.textContent || '').trim())
  const openSuperior = async (el: Element) => inAct(async () => {
    el.querySelector<HTMLButtonElement>('.quickchat-superior')!.dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }))
    await flush(4)
  })
  // what the Agents List on screen says (OrgCanvas fills this ref)
  const listOrder = { current: () => ['boss', 'zed', 'amy'] }
  const view = await mountView(<QuickChat slug="org" tree={t} op={(async () => ({})) as never}
    toast={noop} onHired={noop} listOrder={listOrder} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    await openSuperior(view.el)
    assert.deepEqual(items(), ['top level ✓', 'boss', 'zed', 'amy'])
  } finally { await view.unmount() }
  // no list on screen to ask: the tree's own order, still not alphabetical
  const bare = await mountView(<QuickChat slug="org" tree={t} op={(async () => ({})) as never}
    toast={noop} onHired={noop} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    await openSuperior(bare.el)
    assert.deepEqual(items(), ['top level ✓', 'zed', 'amy', 'boss'])
  } finally { await bare.unmount(); localStorage.clear() }
})

test('trayRows: hierarchy first, siblings by the host order, ghosts keep a hidden parent', () => {
  const n = (id: string, parent: string | null, state = 'live') =>
    [id, { id, parent, state }] as [string, CanvasNode]
  const map = new Map([n('b', null), n('a', null), n('b2', 'b'), n('b1', 'b'), n('gone', 'a', 'archived'), n('kid', 'gone')])
  const ids = (rows: { node: CanvasNode; ghost?: boolean }[]) =>
    rows.map(r => (r.ghost ? '~' : '') + r.node.id)
  assert.deepEqual(ids(trayRows(map)), ['b', 'b2', 'b1', 'a', '~gone', 'kid'])
  const alpha = (x: CanvasNode, y: CanvasNode) => x.id < y.id ? -1 : 1
  assert.deepEqual(ids(trayRows(map, { compare: alpha })), ['a', '~gone', 'kid', 'b', 'b1', 'b2'])
  assert.deepEqual(ids(trayRows(map, { archived: true, compare: alpha })), ['a', 'gone', 'kid', 'b', 'b1', 'b2'])
})
