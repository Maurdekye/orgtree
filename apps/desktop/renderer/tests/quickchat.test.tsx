// Quick chat (docket quick-prompt-hire-kick-off-and-focus-an-agent-fr): the
// header box hires, kicks off and focuses a new agent on Enter, with model,
// effort and superior following the user's last manual choices. Since
// quick-chat-the-superior-selector-looks-and-works it is one row: the
// superior picker is the Agents List, the model picker the hire-token chips.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { legacyAppBackend } from './appfeed-fixture'
import { QuickChat, type AgentListSource } from '../src/QuickChatBox'
import {
  quickChatName, quickChatTier, rememberEffort, rememberHire,
} from '../src/quickchat'
import type { OpRequest, TreePayload } from '../src/types'
import { trayRows } from '../src/canvas/agenttray'
import type { CanvasNode } from '../src/canvas/shared'

const noop = () => {}
const node = (id: string, state = 'live', children: unknown[] = [], tier = 'sonnet') =>
  ({ id, state, children, parent: null, tier })
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
  await flush(2)
})
const enter = async (box: HTMLInputElement) => inAct(async () => {
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await flush(8)
})
const wait = (ms: number) => inAct(async () => { await new Promise(r => setTimeout(r, ms)); await flush(4) })
/** what the closed controls show: the superior's label, the model's tier,
 *  the effort pinned on the bar ('' = the org default) */
const shown = (el: Element) => ({
  superior: el.querySelector('.quickchat-superior .quickchat-label')?.textContent,
  model: [...(el.querySelector('.quickchat-model .tier')?.classList ?? [])]
    .find(c => c.startsWith('t-'))?.slice(2),
  effort: el.querySelector<HTMLElement>('.effort-bar-track')?.dataset.effortPinned,
})
const click = async (el: Element | null) => inAct(async () => {
  el!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }))
  await flush(4)
})
const pickerItems = () => [...document.querySelectorAll('.quickchat-pop .tray-name')]
  .map(b => (b.textContent || '').trim())

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

test('a colon ends the name: the words before the first one, else the whole message', () => {
  const none = () => false
  assert.equal(quickChatName('Release notes: summarise the attached files for the team', none), 'release-notes')
  assert.equal(quickChatName('Bug triage: login fails: see logs', none), 'bug-triage', 'the FIRST colon')
  assert.equal(quickChatName('Please fix the parser: it drops commas', none), 'fix-parser', 'filler words still drop')
  assert.equal(quickChatName(': fix the login bug', none), 'fix-login-bug', 'nothing before it: the old rule')
  assert.equal(quickChatName('please: fix the login bug', none), 'fix-login-bug', 'only filler before it: the old rule')
  assert.equal(quickChatName('?? : fix the login bug', none), 'fix-login-bug')
  assert.equal(quickChatName('Fix the login bug\nnotes: later', none), 'fix-login-bug', 'a colon on a later line leaves the first line')
  assert.equal(quickChatName('Deploy: now', n => n === 'deploy'), 'deploy-2', 'still unique')
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
    assert.deepEqual(shown(view.el), { superior: 'top level', model: 'opus', effort: '' })
    assert.equal(view.el.querySelector('.quickchat-superior .tier'), null, 'top level has no id icon')
    const send = view.el.querySelector<HTMLButtonElement>('.quickchat-send')!
    assert.ok(send.disabled, 'send is disabled while the box is empty')
    const box = view.el.querySelector<HTMLInputElement>('.quickchat-input')!
    await type(box, 'Write the release notes for 4.2')
    assert.ok(!send.disabled)
    await enter(box)
    assert.deepEqual(ops, [{ op: 'hire', name: 'write-release-notes', tier: 'opus', parent: null,
      grant: 50, kickoff: 'Write the release notes for 4.2', kickoff_kind: 'message' }])
    assert.ok(!('charter' in ops[0]!) && !('effort' in ops[0]!), 'no charter, effort follows the org')
    assert.ok(!('audiences' in ops[0]!), 'a top-level agent already writes to the user')
    assert.deepEqual(hired, ['write-release-notes'])
    assert.equal(box.value, '', 'the box clears after a hire')
  } finally { await view.unmount(); localStorage.clear() }
})

test('the model control shows the id icon, then the icon plus the name the agent will get', async () => {
  localStorage.clear(); providers(['claude'])
  const ops: OpRequest[] = []
  const view = await mount(ops, [])
  try {
    const name = () => view.el.querySelector('.quickchat-model .quickchat-name')?.textContent ?? null
    assert.equal(name(), null, 'empty prompt: the icon alone')
    const box = view.el.querySelector<HTMLInputElement>('.quickchat-input')!
    await type(box, 'boss please triage')
    await wait(200)
    assert.equal(name(), 'boss-triage')
    await type(box, 'boss')
    await wait(200)
    assert.equal(name(), 'boss-2', 'the preview avoids existing names, like the hire does')
    await click(view.el.querySelector('.quickchat-send'))
    assert.equal(ops[0]!.name, 'boss-2', 'the preview is the name given')
  } finally { await view.unmount(); localStorage.clear() }
})

test('with a colon the preview and the hire use the words before it; the agent gets the whole prompt', async () => {
  localStorage.clear(); providers(['claude'])
  const ops: OpRequest[] = [], hired: string[] = []
  const view = await mount(ops, hired)
  try {
    const box = view.el.querySelector<HTMLInputElement>('.quickchat-input')!
    const prompt = 'Release notes: summarise the attached files for the team'
    await type(box, prompt)
    await wait(200)
    assert.equal(view.el.querySelector('.quickchat-model .quickchat-name')?.textContent, 'release-notes')
    await enter(box)
    assert.equal(ops[0]!.name, 'release-notes')
    assert.equal((ops[0] as { kickoff?: string }).kickoff, prompt, 'the prompt is sent whole')
    assert.deepEqual(hired, ['release-notes'])
  } finally { await view.unmount(); localStorage.clear() }
})

test('a manual hire and a manual effort pick become the defaults; a stale superior falls back', async () => {
  localStorage.clear(); providers(['claude', 'openai'])
  rememberHire('org', { tier: 'sol', superior: 'boss' })
  rememberEffort('max')
  const ops: OpRequest[] = [], hired: string[] = []
  const view = await mount(ops, hired)
  try {
    assert.deepEqual(shown(view.el), { superior: 'boss', model: 'sol', effort: 'max' })
    assert.ok(view.el.querySelector('.quickchat-superior .tier.t-sonnet'), 'the superior wears its id icon')
    const box = view.el.querySelector<HTMLInputElement>('.quickchat-input')!
    await type(box, 'boss')
    await enter(box)
    assert.equal(ops[0]!.parent, 'boss')
    assert.deepEqual((ops[0] as { audiences?: string[] }).audiences, ['user'], 'a report can answer the user who started it')
    assert.equal(ops[0]!.grant, 0, 'a report draws on its superior, like the hire sheet')
    assert.equal(ops[0]!.effort, 'max')
    assert.equal(ops[0]!.name, 'boss-2', 'never the name of an existing agent')
  } finally { await view.unmount() }
  rememberHire('org', { tier: 'sol', superior: 'old-hand' })
  const again = await mount([], [])
  try {
    assert.equal(shown(again.el).superior, 'top level', 'an archived superior is not offered')
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

test('the superior picker is the Agents List: its rows, its order, filter, arrows and Enter', async () => {
  localStorage.clear(); providers(['claude'])
  const t = { ...tree, roots: [node('zed', 'live', [node('amy')]), node('boss')] } as unknown as TreePayload
  const n = (id: string, parent: string | null) => [id, { id, parent, state: 'live', tier: 'opus' }] as [string, CanvasNode]
  const map = new Map([n('boss', null), n('zed', null), n('amy', 'zed')])
  // what the Agents List on screen says (OrgCanvas fills this ref)
  const order = ['boss', 'zed', 'amy']
  const agentList: { current: AgentListSource } = { current: (query) => ({
    map, rows: trayRows(map, { query, compare: (a, b) => order.indexOf(a.id) - order.indexOf(b.id) }) }) }
  const view = await mountView(<QuickChat slug="org" tree={t} op={(async () => ({})) as never}
    toast={noop} onHired={noop} agentList={agentList} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    await click(view.el.querySelector('.quickchat-superior'))
    assert.deepEqual(pickerItems(), ['top level', 'boss', 'zed', 'amy'])
    assert.ok(document.querySelector('.quickchat-pop .tray-row .tier.t-opus'), 'rows carry their id icons')
    const filter = document.querySelector<HTMLInputElement>('.quickchat-pop .tray-filter')!
    assert.equal(document.activeElement, filter, 'the filter box takes the keys')
    await type(filter, 'am')
    assert.deepEqual(pickerItems(), ['top level', 'zed', 'amy'], 'zed stays as amy\'s ghost parent')
    const key = (k: string) => inAct(async () => {
      filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }))
      await flush(4)
    })
    await key('ArrowDown')
    await key('Enter')
    assert.equal(shown(view.el).superior, 'amy', 'a ghost ancestor is skipped; Enter picks')
    assert.equal(document.querySelector('.quickchat-pop'), null, 'a pick closes the picker')
  } finally { await view.unmount() }
  // no list on screen to ask: the tree's own order, still not alphabetical
  localStorage.clear()
  const bare = await mountView(<QuickChat slug="org" tree={t} op={(async () => ({})) as never}
    toast={noop} onHired={noop} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    await click(bare.el.querySelector('.quickchat-superior'))
    assert.deepEqual(pickerItems(), ['top level', 'zed', 'amy', 'boss'])
    await click(document.querySelector('.quickchat-pop .tray-row[data-copy-agent-name="boss"]'))
    assert.equal(shown(bare.el).superior, 'boss')
  } finally { await bare.unmount(); localStorage.clear() }
})

test('the model chips close once the pointer strays ~70px away, not before it has come near', async () => {
  localStorage.clear(); providers(['claude'])
  const view = await mount([], [])
  const move = (x: number, y: number) => inAct(async () => {
    document.dispatchEvent(new window.MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
    await flush(2)
  })
  try {
    await click(view.el.querySelector('.quickchat-model'))
    // jsdom lays everything out at 0,0: the zone is -70..70 around it
    await move(400, 400)
    assert.ok(document.querySelector('.quickchat-pop.quickchat-pop-model'), 'not armed until the pointer has been near')
    await move(60, 60)
    assert.ok(document.querySelector('.quickchat-pop.quickchat-pop-model'), 'within the margin it stays')
    await move(90, 10)
    assert.ok(!document.querySelector('.quickchat-pop.quickchat-pop-model'), 'past the margin it closes')
    assert.ok(document.querySelector('.quickchat-leaving'), '...with the fade-out')
  } finally { await view.unmount(); localStorage.clear() }
})

test('the model picker is the hire chips; the effort bar sets the effort', async () => {
  localStorage.clear(); providers(['claude'])
  const view = await mount([], [])
  try {
    const order = [...view.el.querySelectorAll('.quickchat-btn')].map(b => b.className.match(/quickchat-(model|superior)/)?.[1]).filter(Boolean)
    assert.deepEqual(order, ['model', 'superior'], 'the model and the new name come before the superior')
    await click(view.el.querySelector('.quickchat-model'))
    const chips = [...document.querySelectorAll<HTMLButtonElement>('.quickchat-pop .hsof button')]
    assert.ok(chips.length >= 3, 'every offered tier is a chip')
    assert.ok(document.querySelector('.quickchat-pop .hsof button.t-opus.sel'), 'the chosen tier is marked')
    await click(chips.find(b => b.classList.contains('t-sonnet'))!)
    assert.equal(shown(view.el).model, 'sonnet')
    assert.equal(document.querySelector('.quickchat-pop'), null)
    assert.ok(document.querySelector('.quickchat-leaving[aria-hidden] .hsof'), 'the chips fade out as a leaving copy')
    await wait(220)
    assert.equal(document.querySelector('.quickchat-leaving'), null, 'the leaving copy goes after the fade')
    const track = view.el.querySelector<HTMLElement>('.effort-bar-track')!
    await inAct(async () => {
      track.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      await flush(4)
    })
    assert.equal(shown(view.el).effort, 'max')
  } finally { await view.unmount(); localStorage.clear() }
})

test('attached files ride the first mail: hire without kickoff, upload, then send', async () => {
  localStorage.clear(); providers(['claude'])
  const calls: string[] = []
  const base = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (path.endsWith('/upload')) {
      calls.push('upload ' + new URL(String(url), 'http://localhost').searchParams.get('name'))
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ path: 'uploads/a.txt', bytes: 3 }) }
    }
    if (path.endsWith('/message')) {
      calls.push('message ' + JSON.parse(String(init?.body)).attachments?.join(','))
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ id: 'm1' }) }
    }
    return base(url, init)
  }) as typeof fetch
  const ops: OpRequest[] = [], hired: string[] = []
  const view = await mount(ops, hired)
  try {
    const input = view.el.querySelector<HTMLInputElement>('[data-testid="quickchat-files"]')!
    const file = new window.File(['abc'], 'a.txt')
    await inAct(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      input.dispatchEvent(new window.Event('change', { bubbles: true }))
      await flush(4)
    })
    assert.equal(view.el.querySelector('.quickchat-count')?.textContent, '1', 'a count badge, not chips')
    const box = view.el.querySelector<HTMLInputElement>('.quickchat-input')!
    await type(box, 'read this file')
    await enter(box)
    assert.equal(ops.length, 1)
    assert.ok(!('kickoff' in ops[0]!), 'the hire carries no kickoff')
    assert.deepEqual(calls, ['upload a.txt', 'message uploads/a.txt'])
    assert.deepEqual(hired, ['read-file'])
    assert.equal(view.el.querySelector('.quickchat-count'), null, 'the files clear after sending')
  } finally { await view.unmount(); localStorage.clear(); globalThis.fetch = base }
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
