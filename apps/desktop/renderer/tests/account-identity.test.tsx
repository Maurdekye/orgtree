import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { DraftScopeModal, HireDefaultsTab, NodeConfig } from '../src/canvas/modals'
import { UsageModal } from '../src/App'
import { AccountRegistrySection } from '../src/canvas/accountsregistry'
import type { CanvasNode, DraftScope } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const email = 'a.very.long.account.address.shared.by.two.logins@example.test'
const rows = [
  { id: 'claude-1', provider: 'claude', ambient: true, name: 'legacy primary', label: 'legacy primary',
    identity: { email: 'primary@example.test' }, standing: { state: 'ready', auth: 'authenticated' } },
  { id: 'claude-4', provider: 'claude', name: 'misleading name', label: 'another account',
    identity: { email }, standing: { state: 'ready', auth: 'authenticated' } },
  { id: 'claude-5', provider: 'claude', name: 'claude-4', label: 'duplicate name',
    identity: { email }, standing: { state: 'limited', auth: 'authenticated' } },
  { id: 'openai-1', provider: 'openai', ambient: true, label: 'Codex alias',
    identity: { email: 'codex@example.test' }, standing: { state: 'ready', auth: 'authenticated' } },
]
const tools = { bash: true, edit: true, web: false, subagents: false, mcp: [] }
const tree = { slug: 'org', dirs: [], tiers: { haiku: 1, opus: 5, luna: 0.2, astra: 10 },
  max_top_grant: 100, default_effort: '', effort_default: 'high', cascade_hire: true,
  default_tools: tools, sandboxed: false } as unknown as TreePayload
const noop = () => {}
const select = (el: HTMLElement, label = 'Account') =>
  (el.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
    ?? document.body.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`))!
const options = (el: HTMLSelectElement) => [...el.options].map(o => [o.value, o.textContent])
async function choose(el: HTMLSelectElement, value: string) {
  await inAct(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })) })
}
function mockFetch(extra: Record<string, unknown> = {}) {
  globalThis.fetch = (async (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const payload = extra[path] ?? (path === '/api/accounts' ? { accounts: rows }
      : { servers: [], turns: [], warnings: [] })
    return { ok: true, status: 200, headers: new Headers(), json: async () => payload }
  }) as typeof fetch
}

test('New Hire uses immutable IDs and emails, and recomputes single/multiple accounts on provider changes', async () => {
  mockFetch()
  const saved: DraftScope[] = []
  const render = (tier: string) => <DraftScopeModal draft={{ parent: null, tier }} map={new Map()}
    tree={tree} scope={null} accounts={rows} onSave={s => saved.push(s)} close={noop} />
  const view = await mountView(render('opus'), el => el)
  try {
    let account = select(view.el)
    assert.equal(account.disabled, false)
    assert.deepEqual(options(account), [
      ['claude/primary', 'default · primary@example.test'],
      ['claude-4', `claude-4 · ${email}`],
      ['claude-5', `claude-5 · ${email} (limited — will wait)`],
    ])
    await choose(account, 'claude-4')
    assert.equal(account.title, `claude-4 · ${email}`)
    assert.equal(document.body.querySelector('.account-choice-identity')?.textContent, `claude-4 · ${email}`)
    await view.render(render('astra'))
    account = select(view.el)
    assert.equal(account.disabled, true)
    assert.deepEqual(options(account), [['openai/primary', 'default · codex@example.test']])
    assert.equal(account.value, 'openai/primary')
    await view.render(render('opus'))
    account = select(view.el)
    assert.equal(account.disabled, false)
    assert.equal(account.value, 'claude/primary')
    await inAct(async () => {
      const apply = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'apply')!
      apply.click()
    })
    assert.equal(saved.at(-1)?.account, 'claude/primary')
  } finally { await view.unmount() }
})

test('a sole primary with no email is visible and disabled without changing an omitted hire binding', async () => {
  mockFetch()
  const saved: DraftScope[] = []
  const view = await mountView(<DraftScopeModal draft={{ parent: null, tier: 'opus' }} map={new Map()}
    tree={tree} scope={null} accounts={[]} onSave={s => saved.push(s)} close={noop} />, el => el)
  try {
    const account = select(view.el)
    assert.deepEqual(options(account), [['claude/primary', 'default · email unavailable']])
    assert.equal(account.disabled, true)
    await inAct(async () => { [...document.body.querySelectorAll('button')].find(b => b.textContent === 'apply')!.click() })
    assert.equal('account' in saved[0], false)
  } finally { await view.unmount() }
})

test('Agent Default changes provider independently of a disabled sole-account dropdown', async () => {
  mockFetch()
  let saved = ''
  function Defaults() {
    const [account, setAccount] = useState('claude-4')
    saved = account
    return <HireDefaultsTab tree={tree} slug="org" toast={noop} close={noop}
      tools={tools} setTools={noop} vis="full" setVis={noop} pm="acceptEdits" setPm={noop}
      dirs={[]} setDirs={noop} servers={[]} accounts={rows} account={account} setAccount={setAccount} />
  }
  const view = await mountView(<Defaults />, el => el)
  try {
    const label = 'default provider account for new hires'
    assert.equal(select(view.el, label).selectedOptions[0].textContent, `claude-4 · ${email}`)
    await choose(select(view.el, 'Provider for default account'), 'openai')
    assert.equal(select(view.el, label).disabled, true)
    assert.deepEqual(options(select(view.el, label)), [['openai/primary', 'default · codex@example.test']])
    assert.equal(saved, 'openai/primary')
    await choose(select(view.el, 'Provider for default account'), 'claude')
    assert.equal(select(view.el, label).disabled, false)
    assert.equal(saved, 'claude/primary')
  } finally { await view.unmount() }
})

test('Agent Settings resets an incompatible account when its provider changes in either direction', async () => {
  mockFetch()
  const node = { id: 'agent', title: 'agent', state: 'live', tier: 'opus', model_id: 'opus',
    parent: 'USER', children: [], seat: 5, grant: 10, free: 10, account: 'claude-4',
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools, org_visibility: 'team' },
    charter: '', team_charter: '', turns: [], audiences_held: [] } as CanvasNode
  const view = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])}
    tree={tree} slug="org" op={async () => ({})} toast={noop} close={noop} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    assert.equal(select(view.el).selectedOptions[0].textContent, `claude-4 · ${email}`)
    await choose(select(view.el, 'model tier'), 'luna')
    assert.equal(select(view.el).disabled, true)
    assert.equal(select(view.el).value, 'openai/primary')
    await choose(select(view.el, 'model tier'), 'opus')
    assert.equal(select(view.el).disabled, false)
    assert.equal(select(view.el).value, 'claude/primary')
  } finally { await view.unmount() }
})

for (const multi of [false, true]) test(`Usage uses ${multi ? 'ID · email for multiple accounts' : 'email only for one account'}`, async () => {
  mockFetch({
    '/api/providers': { providers: ['claude', 'openai', 'google', 'openrouter'].map(id => ({
      id, hire_enabled: id === 'claude', status: { installed: id === 'claude' } })) },
    '/api/accounts': { accounts: multi ? rows.slice(0, 2) : rows.slice(0, 1) },
    '/api/usage': { available: true, email: 'primary@example.test', limits: [] },
    '/api/accounts/claude-4/usage': { account: 'claude-4', available: true, limits: [] },
  })
  const view = await mountView(<UsageModal close={noop} toast={noop} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    const heads = [...view.el.querySelectorAll('.usage-acct-who')].map(el => el.textContent)
    assert.deepEqual(heads, multi
      ? ['Claude Code · default · primary@example.test', `Claude Code · claude-4 · ${email}`]
      : ['Claude Code · primary@example.test'])
    assert.doesNotMatch(heads.join(''), /legacy primary|misleading name|claude\/primary/)
  } finally { await view.unmount() }
})

test('provider account management ignores both legacy name and label', async () => {
  mockFetch()
  const managed = rows.slice(0, 2).map(row => ({ ...row,
    credential: { kind: 'token' }, tint_ordinal: 1, bound: [] }))
  const view = await mountView(<AccountRegistrySection provider="claude" toast={noop}
    registry={{ rows: managed, error: null, reload: async () => {} }} />, el => el)
  try {
    assert.deepEqual([...view.el.querySelectorAll('.account-identity strong')].map(el => el.textContent),
      ['default · primary@example.test', `claude-4 · ${email}`])
    assert.doesNotMatch(view.el.textContent ?? '', /legacy primary|misleading name|another account/)
  } finally { await view.unmount() }
})

test('missing email and sign-in requirements stay distinct from an available primary choice', async () => {
  mockFetch()
  const accounts = [rows[0], { id: 'claude-7', provider: 'claude', label: 'Do not use',
    identity: { email: '' }, standing: { state: 'ready', auth: 'unauthenticated' } }]
  const view = await mountView(<DraftScopeModal draft={{ parent: null, tier: 'opus' }} map={new Map()}
    tree={tree} scope={null} accounts={accounts} onSave={noop} close={noop} />, el => el)
  try {
    assert.equal(select(view.el).disabled, false)
    assert.deepEqual(options(select(view.el)), [
      ['claude/primary', 'default · primary@example.test'],
      ['claude-7', 'claude-7 · email unavailable (sign-in required)'],
    ])
  } finally { await view.unmount() }
})

test('a sole managed Usage account shows only its own email when its host provider is absent', async () => {
  mockFetch({
    '/api/providers': { providers: ['claude', 'openai', 'google', 'openrouter'].map(id => ({
      id, hire_enabled: false, status: { installed: false } })) },
    '/api/accounts': { accounts: [rows[1]] },
    '/api/usage': { available: false, limits: [] },
    '/api/accounts/claude-4/usage': { account: 'claude-4', available: false, limits: [] },
  })
  const view = await mountView(<UsageModal close={noop} toast={noop} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    assert.deepEqual([...view.el.querySelectorAll('.usage-acct-who')].map(el => el.textContent),
      [`Claude Code · ${email}`])
  } finally { await view.unmount() }
})
