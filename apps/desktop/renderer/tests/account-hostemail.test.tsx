/** `default` names the host login the rest of the app already names.
 *
 * THE REPORTED DEFECT (user, 2026-09-12): the agent account-swap selector read
 * `default · email unavailable` while the Usage modal, one modal away, showed
 * that same signed-in account's address. The selector took the address off the
 * AMBIENT REGISTRY ROW, and on the reporting machine the registry held two
 * secondary accounts and no ambient row at all — so there was nothing to read.
 *
 * `/api/accounts` now answers `host_identity` beside the rows, and every
 * selection surface reads it. These tests cover all four: the agent selector,
 * New Hire, Agent Default and the Usage modal — the known-primary case that
 * was reported, the genuinely-unknown control that must still say
 * `email unavailable`, and the secondary-account control that must be
 * untouched. The saved value stays `claude/primary` throughout: the address is
 * display metadata and never becomes the binding.
 */
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { DraftScopeModal, HireDefaultsTab, NodeConfig } from '../src/canvas/modals'
import { UsageModal } from '../src/App'
import type { CanvasNode, DraftScope } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const HOST = 'host.login@example.test'
const SECOND = 'second.account@example.test'
/** the machine that produced the report: registered secondaries, no ambient row */
const secondaries = [
  { id: 'claude-4', provider: 'claude', label: 'claude-0',
    identity: { email: SECOND }, standing: { state: 'ready', auth: 'authenticated' } },
]
const tools = { bash: true, edit: true, web: false, subagents: false, mcp: [] }
const tree = { slug: 'org', dirs: [], tiers: { haiku: 1, opus: 5, luna: 0.2, astra: 10 },
  max_top_grant: 100, default_effort: '', effort_default: 'high', cascade_hire: true,
  default_tools: tools, sandboxed: false } as unknown as TreePayload
const noop = () => {}
const node = { id: 'agent', title: 'agent', state: 'live', tier: 'opus', model_id: 'opus',
  parent: 'USER', children: [], seat: 5, grant: 10, free: 10, account: 'claude/primary',
  scope: { permission_mode: 'acceptEdits', add_dirs: [], tools, org_visibility: 'team' },
  charter: '', team_charter: '', turns: [], audiences_held: [] } as CanvasNode

const select = (el: HTMLElement, label = 'Account') =>
  (el.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
    ?? document.body.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`))!
const options = (el: HTMLSelectElement) => [...el.options].map(o => [o.value, o.textContent])

/** `accounts` is the WHOLE /api/accounts payload here — the point of these
 *  tests is the field beside the rows, so no surface may be handed rows by
 *  prop and skip the fetch. */
function mockFetch(accounts: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const posted: { path: string; body: Record<string, unknown> }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (init?.method && init.method !== 'GET') {
      posted.push({ path, body: init.body ? JSON.parse(String(init.body)) : {} })
    }
    const payload = extra[path]
      ?? (path === '/api/accounts' ? accounts
        : path.endsWith('/account') ? { account: 'claude/primary', billing_mode: 'ambient',
          standing: { state: 'unobserved' }, session_boundary: false, cache_namespace_changed: false }
        : { servers: [], turns: [], warnings: [] })
    return { ok: true, status: 200, headers: new Headers(), json: async () => payload }
  }) as typeof fetch
  return posted
}

test('the agent account-swap selector shows the known host address and still submits provider/primary', async () => {
  const posted = mockFetch({ accounts: secondaries,
    host_identity: { claude: { email: HOST }, openai: { email: null }, google: { email: null } } })
  const view = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])}
    tree={tree} slug="org" op={async () => ({})} toast={noop} close={noop} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    const account = select(view.el)
    assert.deepEqual(options(account), [
      ['claude/primary', `default · ${HOST}`],
      ['claude-4', `claude-4 · ${SECOND}`],
    ])
    // the visible detail line and the tooltip agree with the option
    assert.equal(account.title, `default · ${HOST}`)
    assert.equal(document.body.querySelector('.account-choice-identity')?.textContent,
      `default · ${HOST}`)
    // …and the address is DISPLAY ONLY: what is saved is the selector
    const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(b => b.textContent?.trim() === 'save')!
    await inAct(async () => { save.click(); await flush(8) })
    for (const p of posted) assert.doesNotMatch(JSON.stringify(p.body), /example\.test/)
  } finally { await view.unmount() }
})

test('a genuinely unknown host address still reads email unavailable', async () => {
  mockFetch({ accounts: secondaries,
    host_identity: { claude: { email: null }, openai: { email: null }, google: { email: null } } })
  const view = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])}
    tree={tree} slug="org" op={async () => ({})} toast={noop} close={noop} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    assert.deepEqual(options(select(view.el)), [
      ['claude/primary', 'default · email unavailable'],
      ['claude-4', `claude-4 · ${SECOND}`],
    ])
  } finally { await view.unmount() }
})

test('an older backend without host_identity degrades to the honest fallback', async () => {
  mockFetch({ accounts: secondaries })
  const view = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])}
    tree={tree} slug="org" op={async () => ({})} toast={noop} close={noop} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    assert.deepEqual(options(select(view.el)), [
      ['claude/primary', 'default · email unavailable'],
      ['claude-4', `claude-4 · ${SECOND}`],
    ])
  } finally { await view.unmount() }
})

test('an ambient registry row that carries its own address is still preferred', async () => {
  // the registry row is the closer observation of that login; host_identity is
  // the fallback for when no row exists, not an override of one that does.
  mockFetch({ accounts: [{ id: 'claude-1', provider: 'claude', ambient: true,
    label: 'legacy', identity: { email: 'from.the.row@example.test' },
    standing: { state: 'ready', auth: 'authenticated' } }],
    host_identity: { claude: { email: HOST } } })
  const view = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])}
    tree={tree} slug="org" op={async () => ({})} toast={noop} close={noop} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    assert.deepEqual(options(select(view.el)),
      [['claude/primary', 'default · from.the.row@example.test']])
  } finally { await view.unmount() }
})

test('switching to a secondary account and back is unaffected', async () => {
  mockFetch({ accounts: secondaries, host_identity: { claude: { email: HOST } } })
  const view = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])}
    tree={tree} slug="org" op={async () => ({})} toast={noop} close={noop} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    const account = select(view.el)
    assert.equal(account.disabled, false)
    await inAct(async () => {
      account.value = 'claude-4'
      account.dispatchEvent(new Event('change', { bubbles: true }))
    })
    assert.equal(select(view.el).value, 'claude-4')
    assert.equal(select(view.el).selectedOptions[0].textContent, `claude-4 · ${SECOND}`)
    await inAct(async () => {
      const back = select(view.el)
      back.value = 'claude/primary'
      back.dispatchEvent(new Event('change', { bubbles: true }))
    })
    assert.equal(select(view.el).value, 'claude/primary')
    assert.equal(select(view.el).selectedOptions[0].textContent, `default · ${HOST}`)
  } finally { await view.unmount() }
})

test('New Hire names the host login of whichever provider the tier belongs to', async () => {
  mockFetch({ accounts: [], host_identity: {
    claude: { email: HOST }, openai: { email: 'codex.host@example.test' } } })
  const saved: DraftScope[] = []
  const render = (tier: string) => <DraftScopeModal draft={{ parent: null, tier }} map={new Map()}
    tree={tree} scope={null} onSave={s => saved.push(s)} close={noop} />
  const view = await mountView(render('opus'), el => el)
  try {
    await inAct(async () => { await flush(8) })
    assert.deepEqual(options(select(view.el)), [['claude/primary', `default · ${HOST}`]])
    await view.render(render('astra'))
    await inAct(async () => { await flush(8) })
    assert.deepEqual(options(select(view.el)),
      [['openai/primary', 'default · codex.host@example.test']])
  } finally { await view.unmount() }
})

test('the org-wide hire default names the host login too', async () => {
  mockFetch({ accounts: [], host_identity: { claude: { email: HOST } } })
  function Defaults() {
    const [account, setAccount] = useState('')
    return <HireDefaultsTab tree={tree} slug="org" toast={noop} close={noop}
      tools={tools} setTools={noop} vis="full" setVis={noop} pm="acceptEdits" setPm={noop}
      dirs={[]} setDirs={noop} account={account} setAccount={setAccount} />
  }
  const view = await mountView(<Defaults />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    assert.deepEqual(options(select(view.el, 'default provider account for new hires')),
      [['claude/primary', `default · ${HOST}`]])
  } finally { await view.unmount() }
})

test('Usage and the selector agree on the host address from the same payload', async () => {
  // the same registry the selector sees, and a usage readout that has NOT
  // supplied an address of its own — before this fix the modal's only other
  // source was the ambient row the selector was already missing.
  mockFetch({ accounts: [], host_identity: { claude: { email: HOST } } }, {
    '/api/providers': { providers: ['claude', 'openai', 'google', 'openrouter'].map(id => ({
      id, hire_enabled: id === 'claude', status: { installed: id === 'claude' } })) },
    '/api/usage': { available: true, limits: [] },
  })
  const view = await mountView(<UsageModal close={noop} toast={noop} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    assert.deepEqual([...view.el.querySelectorAll('.usage-acct-who')].map(el => el.textContent),
      [`Claude Code · ${HOST}`])
  } finally { await view.unmount() }
})
