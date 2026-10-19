// Quick chat (docket quick-prompt-hire-kick-off-and-focus-an-agent-fr): the
// header box hires, kicks off and focuses a new agent on Enter, with model,
// effort and superior following the user's last manual choices. Since
// quick-chat-the-superior-selector-looks-and-works it is one row: the
// superior picker is the Agents List, the model picker the hire-token chips.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { legacyAppBackend } from './appfeed-fixture'
import { QuickChat, type AgentListSource } from '../src/QuickChatBox'
import {
  quickChatName, quickChatTier, rememberEffort, rememberHire, readQuickChat, rememberSuperior,
  rememberTier,
  quickChatPosition, setQuickChatPosition, QUICK_CHAT_POSITION_KEY,
} from '../src/quickchat'
import type { OpRequest, TreePayload } from '../src/types'
import { trayRows } from '../src/canvas/agenttray'
import type { CanvasNode } from '../src/canvas/shared'
import { resetStaffingOptionsForTests, type StaffingTier } from '../src/canvas/staffingoptions'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'

const noop = () => {}
const node = (id: string, state = 'live', children: unknown[] = [], tier = 'sonnet') =>
  ({ id, state, children, parent: null, tier })
const tree = {
  slug: 'org', name: 'Org', default_top_grant: 50,
  default_effort: '', effort_default: 'high',
  roots: [node('boss', 'live', [node('old-hand', 'archived')])],
} as unknown as TreePayload

function providers(enabled: string[], choices?: StaffingTier[]) {
  resetStaffingOptionsForTests()
  const models = choices ?? [
    ...(['claude'].some(p => enabled.includes(p)) ? ['opus', 'sonnet', 'haiku'] : []),
    ...(enabled.includes('openai') ? ['astra', 'sol', 'luna'] : []),
    ...(enabled.includes('google') ? ['flash', 'argon'] : []),
    ...(enabled.includes('muse') ? ['wonder'] : []),
  ].map(tier => ({ tier, seat: tier === 'opus' ? 4 : 2, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], accounts: [], default_ok: true }))
  globalThis.fetch = legacyAppBackend((async (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const payload = path === '/api/providers'
      ? { providers: ['claude', 'openai', 'google', 'openrouter'].map(id => ({
          id, hire_enabled: enabled.includes(id), status: { installed: enabled.includes(id) } })) }
      : path.endsWith('/staffing-options') ? { tiers: models, loading: false, errors: [], stale: false, at: 0, generation: 0 } : {}
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

function QuickChatAgentNavFixture() {
  useProvideAgentNav(
    id => [{ label: `Open ${id}`, onSelect: noop }],
    id => ({ title: `Friendly tooltip for ${id}` }),
  )
  return null
}

async function mount(ops: OpRequest[], hired: string[], reply: Record<string, unknown> = {}, currentTree = tree) {
  const op = async (b: OpRequest) => { ops.push(b); return { node: b.name, ...reply } }
  const view = await mountView(<QuickChat slug="org" tree={currentTree} op={op as never}
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

test('the Quick chat position is Top by default, kept, and only top/bottom/none', () => {
  localStorage.clear()
  assert.equal(quickChatPosition(), 'top', 'never set: the header')
  setQuickChatPosition('bottom')
  assert.equal(quickChatPosition(), 'bottom')
  assert.equal(localStorage.getItem(QUICK_CHAT_POSITION_KEY), 'bottom', 'kept across restarts')
  setQuickChatPosition('none')
  assert.equal(quickChatPosition(), 'none')
  localStorage.setItem(QUICK_CHAT_POSITION_KEY, 'sideways')
  assert.equal(quickChatPosition(), 'top', 'anything else reads as the default')
  localStorage.clear()
})

test('the model with no history prefers Opus, then Sol, then Argon, then Wonder, then anything hireable', () => {
  assert.equal(quickChatTier(undefined, ['haiku', 'sonnet', 'opus', 'sol']), 'opus')
  assert.equal(quickChatTier(undefined, ['luna', 'sol', 'flash']), 'sol')
  assert.equal(quickChatTier(undefined, ['flash', 'wonder', 'argon', 'sol', 'opus']), 'opus')
  assert.equal(quickChatTier(undefined, ['flash', 'wonder', 'argon', 'sol']), 'sol')
  assert.equal(quickChatTier(undefined, ['flash', 'wonder', 'argon']), 'argon')
  assert.equal(quickChatTier(undefined, ['flash', 'wonder']), 'wonder')
  assert.equal(quickChatTier(undefined, ['terra', 'flash']), 'terra', 'first available when no preferred tier can be hired')
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
    assert.ok(view.el.querySelector('.quickchat-superior .quickchat-user-mark .eye'),
      'top level shows the switchboard eye beside its label')
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

test('the top-level superior shares the option-list eye and agent selections retain their model card', async () => {
  localStorage.clear(); providers(['claude'])
  const view = await mount([], [])
  try {
    const selected = () => view.el.querySelector('.quickchat-superior')!
    await click(selected())
    const option = document.querySelector('.quickchat-top .tray-main')!
    const optionMark = option.querySelector('.quickchat-user-mark')!
    assert.ok(optionMark.querySelector('.eye'), 'the top-level option keeps its switchboard eye')
    assert.equal(option.firstElementChild === optionMark, true, 'option eye is left of the label')
    assert.equal(selected().firstElementChild?.outerHTML, optionMark.outerHTML,
      'the selected top level uses the same icon markup as its Agents-list option')
    await click(document.querySelector('.quickchat-sup [data-copy-agent-name="boss"] .tray-main'))
    assert.equal(shown(view.el).superior, 'boss')
    assert.ok(selected().querySelector('.tier.t-sonnet'), 'an agent superior retains its model card')
    assert.equal(selected().querySelector('.eye') === null, true, 'agent superior has no switchboard eye')
    await click(selected())
    await click(document.querySelector('.quickchat-top .tray-main'))
    assert.equal(shown(view.el).superior, 'top level')
    assert.ok(selected().querySelector('.quickchat-user-mark .eye'), 'choosing top level restores its eye')
  } finally { await view.unmount(); localStorage.clear() }
})

test('Quick chat selected recipient and picker rows use the shared agent link while left-click keeps selecting', async () => {
  localStorage.clear(); providers(['claude'])
  rememberSuperior('org', 'boss')
  const view = await mountView(
    <AgentNavProvider>
      <QuickChatAgentNavFixture />
      <ObjectMenuBoundary className="quickchat-nav-test">
        <QuickChat slug="org" tree={tree} op={(async () => ({})) as never}
          toast={noop} onHired={noop} />
      </ObjectMenuBoundary>
    </AgentNavProvider>, el => el)
  try {
    await inAct(async () => { await flush(8) })
    const chip = view.el.querySelector<HTMLElement>('.quickchat-superior')!
    assert.equal(chip.getAttribute('data-agent-nav'), 'boss',
      'the selected recipient borrows the shared agent menu')
    assert.equal(chip.getAttribute('data-agent-tooltip'), 'boss',
      'the selected recipient resolves its shared tooltip')
    await inAct(() => { chip.dispatchEvent(new window.Event('pointerover', { bubbles: true })) })
    assert.equal(chip.title, 'Friendly tooltip for boss', 'hover shows the shared tooltip')

    await inAct(() => {
      const event = new window.MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 })
      chip.dispatchEvent(event)
    })
    await flush(3)
    assert.ok([...view.el.querySelectorAll('.ctxmenu [role="menuitem"]')]
      .some(item => item.textContent === 'Open boss'), 'right-click opens the registered agent menu')

    await click(chip)
    const row = view.el.querySelector<HTMLElement>('.quickchat-pop .tray-row[data-copy-agent-name="boss"]')!
    assert.equal(row.getAttribute('data-agent-nav'), 'boss',
      'the picker row borrows the shared agent menu')
    assert.equal(row.getAttribute('data-agent-tooltip'), 'boss',
      'the picker row resolves its shared tooltip')
    await inAct(() => { row.dispatchEvent(new window.Event('pointerover', { bubbles: true })) })
    assert.equal(row.title, 'Friendly tooltip for boss', 'hovering a picker row shows the shared tooltip')

    await inAct(() => {
      const event = new window.MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 })
      row.dispatchEvent(event)
    })
    await flush(3)
    assert.ok([...view.el.querySelectorAll('.ctxmenu [role="menuitem"]')]
      .some(item => item.textContent === 'Open boss'), 'right-clicking a picker row opens the registered agent menu')

    await click(row.querySelector('.tray-main'))
    assert.equal(shown(view.el).superior, 'boss', 'left-click still selects the recipient')
    assert.equal(view.el.querySelector('.quickchat-pop'), null, 'selecting closes the picker')
  } finally { await view.unmount(); localStorage.clear() }
})

test('availability excludes exhausted defaults and keeps a compatible alternative account for the hire', async () => {
  localStorage.clear()
  const row = (tier: string, extra = {}): StaffingTier => ({ tier, seat: 2,
    efforts: ['low', 'high'], accounts: [], default_ok: false, ...extra })
  providers(['claude', 'openai'], [row('opus', { default_ok: true, native_ok: false }), row('sol', { accounts: [
    { value: 'openai-other', id: 'openai-other', provider: 'openai', ambient: false, kind: 'subscription' },
  ] })])
  const ops: OpRequest[] = []
  const view = await mount(ops, [])
  try {
    assert.equal(shown(view.el).model, 'sol', 'a signed-in provider alone does not prove a model is hireable')
    await type(view.el.querySelector<HTMLInputElement>('.quickchat-input')!, 'check model eligibility')
    await enter(view.el.querySelector<HTMLInputElement>('.quickchat-input')!)
    assert.equal(ops[0]?.tier, 'sol')
    assert.equal(ops[0]?.account, 'openai-other', 'the hire uses the eligible account that made the model available')
    assert.equal('effort' in ops[0]!, false, 'an automatic model follows its default effort')
  } finally { await view.unmount(); localStorage.clear() }
})

test('availability respects no-cascade credits and a remembered model returns when its superior can afford it', async () => {
  localStorage.clear(); rememberHire('org', { tier: 'opus', superior: 'boss', effort: 'low' })
  providers(['claude', 'openai'])
  const limited = { ...tree, cascade_hire: false,
    roots: [{ ...node('boss'), free: 2, grant: 2 }],
  } as unknown as TreePayload
  const view = await mount([], [], {}, limited)
  try {
    assert.equal(shown(view.el).model, 'sol', 'an unaffordable remembered model yields to a hireable fallback')
    assert.equal(shown(view.el).effort, 'low', 'a manual effort choice still overrides the fallback default')
    await click(view.el.querySelector('.quickchat-superior'))
    await click(document.querySelector('.quickchat-top .tray-main'))
    assert.equal(shown(view.el).model, 'opus', 'remembered model is retained, not overwritten by the fallback')
  } finally { await view.unmount(); localStorage.clear() }
})

test('availability offers no fallback when every account is exhausted', async () => {
  localStorage.clear(); providers(['claude', 'openai'], [])
  const ops: OpRequest[] = []
  const view = await mount(ops, [])
  try {
    assert.equal(shown(view.el).model, undefined)
    assert.equal(view.el.querySelector('.quickchat-model')?.textContent, 'no model')
    await type(view.el.querySelector<HTMLInputElement>('.quickchat-input')!, 'cannot hire')
    await enter(view.el.querySelector<HTMLInputElement>('.quickchat-input')!)
    assert.equal(ops.length, 0)
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
  rememberEffort('org', 'max')
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

// docket quick-chat-a-project-target-shows-the-wrong-icon (user 2026-10-18
// 14:34Z): a project superior wears the project folder mark every other
// surface draws (identity.tsx TierChip), never its sentinel tier's letter.
test('a project superior wears the project folder mark, not a tier letter', async () => {
  localStorage.clear(); providers(['claude'])
  const t = { ...tree, roots: [{ ...node('site', 'live', [], 'project'), kind: 'project' }, node('boss')] } as unknown as TreePayload
  rememberHire('org', { tier: 'opus', superior: 'site' })
  const view = await mountView(<QuickChat slug="org" tree={t} op={(async () => ({})) as never}
    toast={noop} onHired={noop} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    assert.equal(shown(view.el).superior, 'site')
    const chip = view.el.querySelector('.quickchat-superior')!
    assert.ok(chip.querySelector('.project-mark svg'), 'the chip shows the project folder icon')
    assert.ok(!chip.querySelector('.tier'), 'no tier letter badge for a project')
    await click(chip)
    const row = [...document.querySelectorAll('.quickchat-pop .tray-row')]
      .find(r => r.querySelector('.tray-name')?.textContent?.trim() === 'site')
    assert.ok(row?.querySelector('.project-mark svg'), 'the picker row shows the folder icon too')
  } finally { await view.unmount(); localStorage.clear() }
})

// option B (user 2026-10-10 19:40Z): an org's template defaults win until
// the user picks by hand in that org; picks are per org, and app-wide as the
// fallback for orgs without defaults
test("per-org memory: this org's pick, then the org defaults, then the last pick anywhere", () => {
  localStorage.clear()
  const defaults = { superior: 'boss', tier: 'opus', effort: 'high' }
  assert.deepEqual(readQuickChat('a', defaults), defaults, 'no history: the org defaults')
  rememberHire('b', { tier: 'sol', superior: 'lead', effort: 'max' })
  assert.deepEqual(readQuickChat('a', defaults), defaults, 'a pick in another org does not beat these defaults')
  assert.deepEqual(readQuickChat('a'), { tier: 'sol', effort: 'max' },
    'an org without defaults follows the last pick anywhere (no superior)')
  assert.deepEqual(readQuickChat('b', defaults), { tier: 'sol', effort: 'max', superior: 'lead' },
    "an org's own picks beat its defaults")
  rememberTier('a', 'haiku')
  assert.deepEqual(readQuickChat('a', defaults), { tier: 'haiku', effort: 'high', superior: 'boss' },
    'field by field: only the model was picked here')
  rememberEffort('a', ''); rememberSuperior('a', null)
  assert.deepEqual(readQuickChat('a', defaults), { tier: 'haiku', effort: '', superior: null },
    "effort '' and top level are real picks, not 'no pick'")
  localStorage.clear()
  assert.deepEqual(readQuickChat('c', { effort: '', superior: null }), { effort: '', superior: null },
    "a default of '' effort or top level is a real default")
  localStorage.setItem('orgtree-quickchat-last-superior:old', JSON.stringify({ superior: 'boss' }))
  localStorage.setItem('orgtree-quickchat-last', JSON.stringify({ tier: 'sonnet', effort: 'low' }))
  assert.deepEqual(readQuickChat('old', { superior: 'x', tier: 'opus' }), { superior: 'boss', tier: 'opus', effort: 'low' },
    'an older superior-only entry still reads; the defaults fill the model')
  localStorage.clear()
})

test("the box starts from the org's template defaults, re-reads them when the tree brings them, and a stale default superior is top level", async () => {
  localStorage.clear(); providers(['claude', 'openai'])
  rememberHire('elsewhere', { tier: 'sonnet', superior: 'x', effort: 'low' })
  const op = async (b: OpRequest) => ({ node: b.name })
  const el = (t: TreePayload) => <QuickChat slug="org" tree={t} op={op as never} toast={noop} onHired={noop} />
  const view = await mountView(el(tree), e => e)
  try {
    await inAct(async () => { await flush(8) })
    assert.deepEqual(shown(view.el), { superior: 'top level', model: 'sonnet', effort: 'low' }, 'before: the last pick anywhere')
    await view.render(el({ ...tree, quick_chat: { superior: 'boss', tier: 'sol', effort: 'high' } } as TreePayload))
    await inAct(async () => { await flush(8) })
    assert.deepEqual(shown(view.el), { superior: 'boss', model: 'sol', effort: 'high' }, 'the template defaults, once the tree has them')
    await view.render(el({ ...tree, quick_chat: { superior: 'old-hand', tier: 'sol' } } as TreePayload))
    await inAct(async () => { await flush(8) })
    assert.equal(shown(view.el).superior, 'top level', 'an archived default superior is not offered')
  } finally { await view.unmount(); localStorage.clear() }
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

test('Quick chat has an independent active-only filter for its superior list', async () => {
  localStorage.clear(); providers(['claude'])
  const agents = new Map<string, CanvasNode>([
    ['idle', { id: 'idle', parent: null, state: 'live', tier: 'opus', children: [], busy: false } as CanvasNode],
    ['busy', { id: 'busy', parent: null, state: 'live', tier: 'opus', children: [], busy: true } as CanvasNode],
  ])
  const agentList: { current: AgentListSource } = { current: (query, activeOnly) => ({
    map: agents, rows: trayRows(agents, { query, activeOnly }),
  }) }
  let quickChatOnly = false
  const ControlledQuickChat = () => {
    const [only, setOnly] = useState(false)
    return <QuickChat slug="org" tree={tree} op={(async () => ({})) as never}
      toast={noop} onHired={noop} agentList={agentList}
      quickChatActiveAgentsOnly={only}
      onQuickChatActiveAgentsOnly={value => { quickChatOnly = value; setOnly(value) }} />
  }
  const view = await mountView(<ControlledQuickChat />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    await click(view.el.querySelector('.quickchat-superior'))
    const filter = document.querySelector<HTMLInputElement>(
      '.quickchat-pop input[aria-label="Only active agents"]')
    assert.ok(filter, 'Quick chat exposes its own active-only checkbox')
    assert.deepEqual(pickerItems(), ['top level', 'idle', 'busy'], 'off shows both agents')
    await click(filter)
    assert.equal(quickChatOnly, true, 'the Quick chat toggle writes its own preference')
    assert.deepEqual(pickerItems(), ['top level', 'busy'], 'the Quick chat list alone is filtered')
  } finally { await view.unmount(); localStorage.clear() }
})

test('Quick chat keeps the selected filtered superior as context instead of selecting top level', async () => {
  localStorage.clear(); providers(['claude'])
  rememberSuperior('org', 'coordinator-opus')
  const agents = new Map<string, CanvasNode>([
    ['coordinator-opus', {
      id: 'coordinator-opus', parent: null, state: 'live', tier: 'opus', busy: false,
    } as CanvasNode],
    ['busy-child', {
      id: 'busy-child', parent: 'coordinator-opus', state: 'live', tier: 'sonnet', busy: true,
    } as CanvasNode],
  ])
  const agentList: { current: AgentListSource } = { current: (query, activeOnly) => ({
    map: agents, rows: trayRows(agents, { query, activeOnly }),
  }) }
  const selectionTree = { ...tree, roots: [node('coordinator-opus', 'live', [node('busy-child')])] } as unknown as TreePayload
  const view = await mountView(<QuickChat slug="org" tree={selectionTree} op={(async () => ({})) as never}
    toast={noop} onHired={noop} agentList={agentList}
    quickChatActiveAgentsOnly onQuickChatActiveAgentsOnly={noop} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    await click(view.el.querySelector('.quickchat-superior'))
    const filterRow = document.querySelector('.quickchat-pop-superior .tray-filter-row')
    assert.ok(filterRow, 'the Active filter shares the superior list filter row')
    assert.ok(filterRow!.querySelector('.modalpin-active-filter'),
      'the Active checkbox is aligned in the filter row')
    assert.ok(filterRow!.querySelector('.tray-filter'),
      'the search input remains in the shared filter row')
    assert.deepEqual(pickerItems(), ['top level', 'coordinator-opus', 'busy-child'],
      'the selected superior remains visible as a ghost context row')
    const root = document.querySelector<HTMLElement>('.quickchat-top')!
    const selected = document.querySelectorAll('.quickchat-pop .sel')
    assert.equal(root.classList.contains('sel'), false,
      'top level is not selected while the actual superior is selected')
    assert.equal(selected.length, 1, 'only the actual selected superior appears selected')
    assert.equal(document.querySelector('[data-copy-agent-name="coordinator-opus"]')?.classList.contains('sel'), true,
      'the selected superior remains highlighted as a filtered context row')
    assert.equal(document.activeElement, document.querySelector('.quickchat-pop .tray-filter'),
      'keyboard focus remains on the filter, not top level')
  } finally { await view.unmount(); localStorage.clear() }
})

async function openSuperiorPicker(selected: string | null = null) {
  localStorage.clear(); providers(['claude'])
  rememberSuperior('org', selected)
  const t = { ...tree, roots: [node('zed', 'live', [node('amy')]), node('boss')] } as unknown as TreePayload
  const view = await mountView(<QuickChat slug="org" tree={t} op={(async () => ({})) as never}
    toast={noop} onHired={noop} />, el => el)
  await inAct(async () => { await flush(8) })
  await click(view.el.querySelector('.quickchat-superior'))
  return view
}
const pickerKey = (key: string) => inAct(async () => {
  document.querySelector('.quickchat-pop .tray-filter')!
    .dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }))
  await flush(4)
})

test('superior root is the first list row under the filter; all agent depths shift one level', async () => {
  const view = await openSuperiorPicker('zed')
  try {
    const list = document.querySelector('.quickchat-pop .tray')!
    const root = document.querySelector<HTMLElement>('.quickchat-top')!
    const filter = list.querySelector('.tray-filter')!
    // A failed DOM-object equality can serialize the entire jsdom graph.
    // Keep red-control diagnostics scalar so the remaining cases still run.
    assert.ok(root.parentElement === list, 'root belongs to the same list as the agents')
    assert.ok(filter.nextElementSibling === root, 'filter is above the root row')
    assert.ok(root.querySelector('.eye'), 'root keeps the eye icon')
    assert.equal(root.style.paddingLeft, '8px')
    assert.deepEqual([...list.querySelectorAll<HTMLElement>('.tray-row[data-copy-agent-name]')]
      .map(r => [r.dataset.copyAgentName, r.style.paddingLeft]),
      [['zed', '22px'], ['amy', '36px'], ['boss', '22px']])
    assert.ok(list.querySelector('[data-copy-agent-name="zed"].sel'), 'current agent stays highlighted')
  } finally { await view.unmount(); localStorage.clear() }
})

test('superior root matches a case-insensitive filter and is selectable without agent results', async () => {
  const view = await openSuperiorPicker('zed')
  try {
    await type(document.querySelector<HTMLInputElement>('.quickchat-pop .tray-filter')!, ' TOP LEVEL ')
    assert.deepEqual(pickerItems(), ['top level'])
    assert.ok(document.querySelector('.quickchat-empty') === null, 'the matching root is a result')
    await pickerKey('Enter')
    assert.equal(shown(view.el).superior, 'top level')
    assert.ok(document.querySelector('.quickchat-pop') === null)
  } finally { await view.unmount(); localStorage.clear() }
})

test('superior filtered agents keep the root and ancestor chain as ghosts; keys skip those ghosts', async () => {
  const view = await openSuperiorPicker()
  try {
    await type(document.querySelector<HTMLInputElement>('.quickchat-pop .tray-filter')!, 'amy')
    assert.deepEqual(pickerItems(), ['top level', 'zed', 'amy'])
    assert.ok(document.querySelector('.quickchat-top.ghost'), 'root remains as the matching agent\'s context')
    assert.ok(document.querySelector('[data-copy-agent-name="zed"].ghost'))
    assert.equal(document.querySelector<HTMLElement>('[data-copy-agent-name="amy"]')!.style.paddingLeft, '36px')
    await pickerKey('ArrowUp')
    await pickerKey('Enter')
    assert.equal(shown(view.el).superior, 'amy', 'only the matching live agent is in the key cycle')
  } finally { await view.unmount(); localStorage.clear() }
})

test('superior filter with no matches has no root choice and Enter cannot select a hidden root', async () => {
  const view = await openSuperiorPicker('zed')
  try {
    await type(document.querySelector<HTMLInputElement>('.quickchat-pop .tray-filter')!, 'no-such-superior')
    assert.deepEqual(pickerItems(), [])
    assert.ok(document.querySelector('.quickchat-empty'))
    await pickerKey('ArrowDown')
    await pickerKey('Enter')
    assert.ok(document.querySelector('.quickchat-pop'), 'empty keyboard selection cannot close the picker')
    assert.equal(shown(view.el).superior, 'zed', 'the saved selection remains unchanged')
  } finally { await view.unmount(); localStorage.clear() }
})

test('superior keyboard cycle includes the root and mouse can still select it', async () => {
  const view = await openSuperiorPicker()
  try {
    assert.equal(document.querySelector('.quickchat-top')!.getAttribute('aria-current'), 'true')
    await pickerKey('ArrowDown')
    assert.ok(document.querySelector('[data-copy-agent-name="zed"].sel'))
    await pickerKey('ArrowUp')
    assert.ok(document.querySelector('.quickchat-top.sel'))
    await pickerKey('Enter')
    assert.equal(shown(view.el).superior, 'top level')
    await click(view.el.querySelector('.quickchat-superior'))
    await click(document.querySelector('[data-copy-agent-name="boss"]'))
    await click(view.el.querySelector('.quickchat-superior'))
    await click(document.querySelector('.quickchat-top'))
    assert.equal(shown(view.el).superior, 'top level')
  } finally { await view.unmount(); localStorage.clear() }
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
