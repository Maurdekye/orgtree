// draft_account.test.tsx — test provider account selection in DraftScopeModal for uninitialized hires.
//
// Verifies:
// 1. Valid accounts for the selected provider/tier are displayed, while accounts from
//    other providers are filtered out.
// 2. An org default account matching the draft's provider is pre-selected.
// 3. Incompatible org default accounts fall back to unbound.
// 4. Staging an explicit account or explicit unbound choice saves into DraftScope.
// 5. Empty accounts list renders unbound cleanly.
// 6. Live accounts are fetched from /api/accounts?org=${slug} when not passed as props.

import './harness'
import { FakeServer, flush, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DraftScopeModal } from '../src/canvas/modals'
import type { DraftScope, DraftState } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}

function tree(defaultAccount: string | null = null, slug = 'test-org'): TreePayload {
  return {
    slug,
    dirs: [],
    tiers: {
      haiku: 1, sonnet: 2, opus: 5, fable: 10, luna: 0.2, terra: 2, sol: 5, astra: 1,
    },
    max_top_grant: 100,
    default_effort: '',
    effort_default: 'high',
    cascade_hire: true,
    sandboxed: false,
    default_account: defaultAccount,
  } as unknown as TreePayload
}

const sampleAccounts = [
  { id: 'claude-1', provider: 'claude', label: 'Primary Claude', standing: { state: 'ready' } },
  { id: 'claude-2', provider: 'claude', label: 'Limited Claude', standing: { state: 'limited' } },
  { id: 'openai-1', provider: 'openai', label: 'Work OpenAI', standing: { state: 'ready' } },
  { id: 'openai-2', provider: 'openai', label: 'Personal OpenAI', standing: { state: 'ready' } },
]

test('draft modal shows valid accounts for the selected provider and filters out others', async (t: TestContext) => {
  useFakeClock()
  installFetch(new FakeServer())
  const draftClaude: DraftState = { parent: null, tier: 'opus' }
  const viewClaude = await mountView(
    <DraftScopeModal draft={draftClaude} map={new Map()} tree={tree()} scope={null}
      accounts={sampleAccounts} onSave={noop} close={noop} />,
    (el) => el
  )
  t.after(async () => { await viewClaude.unmount(); realClock() })
  await flush()

  const body = document.body as unknown as HTMLElement
  const selClaude = body.querySelector<HTMLSelectElement>('select[aria-label="Account"]')
  assert.ok(selClaude, 'Account selector must be rendered')
  const claudeOptions = [...selClaude!.querySelectorAll('option')].map((o) => ({
    value: o.value,
    text: o.textContent,
  }))

  assert.equal(claudeOptions.length, 3, 'primary and 2 claude accounts')
  assert.equal(claudeOptions[0].value, 'claude/primary')
  assert.equal(claudeOptions[0].text, 'default · email unavailable')
  assert.equal(claudeOptions[1].value, 'claude-1')
  assert.equal(claudeOptions[1].text, 'claude-1 · email unavailable')
  assert.equal(claudeOptions[2].value, 'claude-2')
  assert.ok(claudeOptions[2].text?.includes('(limited — will wait)'))
  assert.equal(claudeOptions.some((o) => o.value.startsWith('openai-')), false)

  // Now test an OpenAI tier (astra)
  const draftOpenAI: DraftState = { parent: null, tier: 'astra' }
  await viewClaude.render(
    <DraftScopeModal draft={draftOpenAI} map={new Map()} tree={tree()} scope={null}
      accounts={sampleAccounts} onSave={noop} close={noop} />
  )
  await flush()

  const selOpenAI = body.querySelector<HTMLSelectElement>('select[aria-label="Account"]')
  assert.ok(selOpenAI)
  const openAIOptions = [...selOpenAI!.querySelectorAll('option')].map((o) => ({
    value: o.value,
    text: o.textContent,
  }))

  assert.equal(openAIOptions.length, 3, 'primary and 2 openai accounts')
  assert.equal(openAIOptions[0].value, 'openai/primary')
  assert.equal(openAIOptions[0].text, 'default · email unavailable')
  assert.equal(openAIOptions[1].value, 'openai-1')
  assert.equal(openAIOptions[2].value, 'openai-2')
  assert.equal(openAIOptions.some((o) => o.value.startsWith('claude-')), false)
})

test('draft modal pre-selects matching org default account', async (t: TestContext) => {
  useFakeClock()
  installFetch(new FakeServer())
  const saved: DraftScope[] = []
  const draft: DraftState = { parent: null, tier: 'astra' }
  const view = await mountView(
    <DraftScopeModal draft={draft} map={new Map()} tree={tree('openai-1')} scope={null}
      accounts={sampleAccounts} onSave={(s) => saved.push(s)} close={noop} />,
    (el) => el
  )
  t.after(async () => { await view.unmount(); realClock() })
  await flush()

  const body = document.body as unknown as HTMLElement
  const sel = body.querySelector<HTMLSelectElement>('select[aria-label="Account"]')
  assert.ok(sel)
  assert.equal(sel!.value, 'openai-1', 'matching org default must be pre-selected')

  const apply = [...body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'apply')!
  const { act } = await import('react')
  await act(async () => { apply.click() })

  assert.equal(saved.at(-1)?.account, 'openai-1', 'pre-selected account is preserved on save')
})

test('draft displays and saves the canonical primary name for a legacy default binding', async (t: TestContext) => {
  useFakeClock()
  installFetch(new FakeServer())
  const saved: DraftScope[] = []
  const view = await mountView(
    <DraftScopeModal draft={{ parent: null, tier: 'astra' }} map={new Map()}
      tree={tree('openai-1')} scope={null}
      accounts={[{ ...sampleAccounts[2], name: 'openai/primary', ambient: true }]}
      onSave={(s) => saved.push(s)} close={noop} />,
    (el) => el
  )
  t.after(async () => { await view.unmount(); realClock() })
  await flush()
  const body = document.body as unknown as HTMLElement
  const select = body.querySelector<HTMLSelectElement>('select[aria-label="Account"]')!
  assert.equal(select.value, 'openai/primary')
  assert.equal(select.selectedOptions[0].textContent, 'default · email unavailable')
  assert.equal(select.disabled, true)
  const apply = [...body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'apply')!
  const { act } = await import('react')
  await act(async () => { apply.click() })
  assert.equal(saved.at(-1)?.account, 'openai/primary')
})

test('draft selects an inherited canonical primary default without a registry row', async (t: TestContext) => {
  useFakeClock()
  installFetch(new FakeServer())
  const saved: DraftScope[] = []
  const view = await mountView(
    <DraftScopeModal draft={{ parent: null, tier: 'astra' }} map={new Map()}
      tree={tree('openai/primary')} scope={null} accounts={[]}
      onSave={(s) => saved.push(s)} close={noop} />,
    (el) => el
  )
  t.after(async () => { await view.unmount(); realClock() })
  await flush()
  const body = document.body as unknown as HTMLElement
  const select = body.querySelector<HTMLSelectElement>('select[aria-label="Account"]')!
  assert.equal(select.value, 'openai/primary')
  const apply = [...body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'apply')!
  const { act } = await import('react')
  await act(async () => { apply.click() })
  assert.equal(saved.at(-1)?.account, 'openai/primary')
})

test('draft modal ignores incompatible org default account and starts unbound', async (t: TestContext) => {
  useFakeClock()
  installFetch(new FakeServer())
  const saved: DraftScope[] = []
  const draft: DraftState = { parent: null, tier: 'astra' }
  // Default account is for Claude, but draft is Astra (OpenAI)
  const view = await mountView(
    <DraftScopeModal draft={draft} map={new Map()} tree={tree('claude-1')} scope={null}
      accounts={sampleAccounts} onSave={(s) => saved.push(s)} close={noop} />,
    (el) => el
  )
  t.after(async () => { await view.unmount(); realClock() })
  await flush()

  const body = document.body as unknown as HTMLElement
  const sel = body.querySelector<HTMLSelectElement>('select[aria-label="Account"]')
  assert.ok(sel)
  assert.equal(sel!.value, 'openai/primary', 'unbound displays the selected provider default')

  const apply = [...body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'apply')!
  const { act } = await import('react')
  await act(async () => { apply.click() })

  assert.equal('account' in (saved.at(-1) ?? {}), false, 'untouched unbound default leaves account omitted')
})

test('explicitly changing account in draft modal saves selection, including unbound', async (t: TestContext) => {
  useFakeClock()
  installFetch(new FakeServer())
  const saved: DraftScope[] = []
  const draft: DraftState = { parent: null, tier: 'astra' }
  const view = await mountView(
    <DraftScopeModal draft={draft} map={new Map()} tree={tree('openai-1')} scope={null}
      accounts={sampleAccounts} onSave={(s) => saved.push(s)} close={noop} />,
    (el) => el
  )
  t.after(async () => { await view.unmount(); realClock() })
  await flush()

  const body = document.body as unknown as HTMLElement
  const sel = body.querySelector<HTMLSelectElement>('select[aria-label="Account"]')!
  const apply = [...body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'apply')!
  const { act } = await import('react')

  // Switch to openai-2
  await act(async () => {
    sel.value = 'openai-2'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => { apply.click() })
  assert.equal(saved.at(-1)?.account, 'openai-2', 'selected account openai-2 saved')

  // Switch to unbound
  await act(async () => {
    const reset = [...body.querySelectorAll<HTMLButtonElement>('button')]
      .find(b => b.textContent === 'Use machine default')!
    reset.click()
  })
  await act(async () => { apply.click() })
  assert.equal(saved.at(-1)?.account, '', 'explicitly selected unbound saved as empty string')
})

test('draft modal fetches live accounts from /api/accounts?org=${slug} when not passed via props', async (t: TestContext) => {
  useFakeClock()
  const requestedUrls: string[] = []
  const origFetch = globalThis.fetch
  globalThis.fetch = ((url: string) => {
    requestedUrls.push(String(url))
    const payload = String(url).includes('/api/accounts')
      ? { accounts: sampleAccounts }
      : { servers: [], sandbox_mcp: false }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve(payload),
    } as unknown as Response)
  }) as typeof fetch
  t.after(() => { globalThis.fetch = origFetch })

  const draft: DraftState = { parent: null, tier: 'opus' }
  const view = await mountView(
    <DraftScopeModal draft={draft} map={new Map()} tree={tree(null, 'custom-slug')} scope={null}
      onSave={noop} close={noop} />,
    (el) => el
  )
  t.after(async () => { await view.unmount(); realClock() })
  await flush()

  assert.ok(requestedUrls.some((u) => u.includes('/api/accounts?org=custom-slug')), 'must fetch accounts for org slug')
  const body = document.body as unknown as HTMLElement
  const sel = body.querySelector<HTMLSelectElement>('select[aria-label="Account"]')!
  const options = [...sel.querySelectorAll('option')].map((o) => o.value)
  assert.deepEqual(options, ['claude/primary', 'claude-1', 'claude-2'])
})

test('empty accounts list renders unbound cleanly', async (t: TestContext) => {
  useFakeClock()
  installFetch(new FakeServer())
  const draft: DraftState = { parent: null, tier: 'opus' }
  const view = await mountView(
    <DraftScopeModal draft={draft} map={new Map()} tree={tree()} scope={null}
      accounts={[]} onSave={noop} close={noop} />,
    (el) => el
  )
  t.after(async () => { await view.unmount(); realClock() })
  await flush()

  const body = document.body as unknown as HTMLElement
  const sel = body.querySelector<HTMLSelectElement>('select[aria-label="Account"]')
  assert.ok(sel)
  const options = [...sel!.querySelectorAll('option')].map((o) => o.value)
  assert.deepEqual(options, ['claude/primary'])
  assert.equal(sel.disabled, true)
})
