// Several OpenRouter keys at once (docket use-several-openrouter-keys-at-once,
// ruling 2026-10-11; per-key switch user 2026-10-11 22:50; every key alike,
// user 2026-10-14 18:00Z). Driven through the OpenRouter section's rendered
// controls against a scripted fetch: every key gets the same row (name,
// numbered id, spend line with the shared "account balance") and the same
// three buttons, "Add another OpenRouter key" POSTs a key and an optional
// name, every key has its own active switch, and a key is only ever SENT —
// never rendered.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenRouterSection } from '../src/canvas/openrouter'
import type { OpenRouterDoc, OpenRouterKey, ProviderInfo } from '../src/types'

type Seen = { method: string; path: string; body: unknown }
const g = globalThis as unknown as Record<string, unknown>

const SPEND = '$8.49 of $25.00 spend cap · $18.57 account balance'

function key(id: string, over: Partial<OpenRouterKey> = {}): OpenRouterKey {
  return {
    id, lane: id, label: null,
    name: id === 'openrouter-1' ? 'personal' : 'OpenRouter key 2', key_label: null, enabled: true,
    connected: true, reason: null, observed_at: '2026-10-11T22:00:00Z',
    limits: [{ kind: 'usage', label: SPEND, percent: 34 } as OpenRouterKey['limits'][number]],
    ...over,
  }
}

function stubFetch(seen: Seen[], initial?: OpenRouterKey[]) {
  let keys: OpenRouterKey[] = initial ?? [key('openrouter-1'), key('openrouter-2', { label: 'team', name: 'team' })]
  const doc = (): OpenRouterDoc => ({
    installed: true, connected: true, key_set: keys.length > 0, kind: 'api-key', label: null,
    credits: { limit: null, limit_remaining: null, usage: null, usage_daily: null, usage_weekly: null,
      usage_monthly: null, is_free_tier: null, checked_at: null },
    reason: null, favorites: 0, favorites_max: 0, tiers: [], user_enabled: true,
    keys, any_key: keys.length > 0,
  })
  g.fetch = (url: string, init?: RequestInit) => {
    const u = new URL(String(url), 'http://localhost')
    const path = u.pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    seen.push({ method, path, body })
    let payload: unknown = null
    if (path === '/api/openrouter' && method === 'GET') payload = doc()
    else if (path === '/api/openrouter/keys' && method === 'POST') {
      const b = body as { key: string; label?: string }
      keys = [...keys, key('openrouter-3', { label: b.label ?? null, name: b.label ?? 'OpenRouter key 3', connected: null, limits: [] })]
      payload = { ...doc(), added: 'openrouter-3', added_lane: 'openrouter-3' }
    } else if (path.startsWith('/api/accounts/') && path.endsWith('/enabled') && method === 'PUT') {
      const id = decodeURIComponent(path.split('/')[3]!)
      keys = keys.map((k) => (k.id === id ? { ...k, enabled: (body as { enabled: boolean }).enabled } : k))
      payload = { account: null }
    } else if (path.startsWith('/api/openrouter/keys/') && method === 'DELETE') {
      const id = decodeURIComponent(path.split('/')[4]!)
      keys = keys.filter((k) => k.id !== id)
      payload = doc()
    } else if (path.startsWith('/api/openrouter/keys/') && method === 'PUT') {
      const id = decodeURIComponent(path.split('/')[4]!)
      const b = body as { label?: string }
      keys = keys.map((k) => (k.id === id && b.label != null ? { ...k, label: b.label || null, name: b.label || k.name } : k))
      payload = doc()
    }
    if (!payload) return Promise.reject(new Error(`unexpected ${method} ${path}`))
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(payload) })
  }
}

const PROVIDER: ProviderInfo = {
  id: 'openrouter', label: 'OpenRouter', cli: 'REST API (via Claude Code)',
  tiers: [], status: { installed: true, connected: true, key_set: true },
  hire_enabled: true, user_enabled: true, reason: null,
}

async function mount() {
  const view = await mountView(
    <OpenRouterSection provider={PROVIDER} toast={() => {}} pickerOpen={false} setPickerOpen={() => {}} />, (el) => el)
  await inAct(async () => { await flush(10) })
  return view
}

for (const [state, keys, label] of [
  ['empty', [], 'Add OpenRouter key'],
  ['one-key', [key('openrouter-2')], 'Add another OpenRouter key'],
] as const) test(`one header add action opens the correct form with ${state} keys`, async () => {
  const seen: Seen[] = []
  stubFetch(seen, [...keys])
  const view = await mount()
  try {
    const adds = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .filter(b => /^Add (another )?OpenRouter key$/.test(b.textContent ?? ''))
    assert.equal(adds.length, 1)
    assert.equal(adds[0]!.textContent, label)
    assert.ok(adds[0]!.closest('.set-head-right'))
    assert.equal(adds[0]!.getAttribute('aria-haspopup'), 'dialog')
    await inAct(async () => { adds[0]!.click(); await flush(4) })
    assert.ok(document.querySelector(`[role="dialog"][aria-label="${label}"]`))
    const overlay = document.querySelector('.provider-dialog')!.parentElement!
    await inAct(async () => { overlay.click(); await flush(4) })
    assert.equal(document.querySelector('.provider-dialog') === null, true, 'the dialog closed')
    assert.equal(seen.filter(r => r.method !== 'GET').length, 0)
  } finally { await view.unmount(); delete g.fetch }
})

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

test('§1 every key is its own row, alike: name and numbered id, its own spend, the same buttons', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const view = await mount()
  try {
    const rows = [...view.el.querySelectorAll('.acct-row.orr-keyrow')]
    assert.equal(rows.length, 2, 'one row per key')
    assert.ok(rows[0]!.textContent?.includes('personal (openrouter-1)'), 'the first key: name and id')
    assert.ok(rows[1]!.textContent?.includes('team (openrouter-2)'), 'the second key: name and id')
    for (const row of rows) {
      assert.ok(row.querySelector('.acct-provenance')!.textContent?.includes('account balance'),
        'each balance says it is the account\'s')
    }
    const titles = rows.map((r) => [...r.querySelectorAll<HTMLButtonElement>('.acct-main > .acct-btn')].map((b) => b.title))
    assert.deepEqual(titles[0], titles[1], 'every key has the same three buttons')
    for (const b of view.el.querySelectorAll('.acct-btn')) {
      assert.equal(b.textContent?.trim(), '', `no text in an icon button (${b.getAttribute('title')})`)
    }
    const switches = [...view.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    assert.equal(switches.length, 2, 'one active switch per key')
    assert.ok(switches.every((s) => s.checked), 'both keys active')
    assert.deepEqual(switches.map((s) => s.closest('.set-row')?.querySelector('.set-label')?.textContent),
      ['Active', 'Active'], 'each switch shows "Active" beside its key')
    assert.deepEqual(switches.map((s) => s.getAttribute('aria-label')), ['personal active', 'team active'],
      'and is named for its key')
  } finally {
    await view.unmount(); delete g.fetch
  }
})

test('§2 Add another key POSTs the key and its name, and never renders the key', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const view = await mount()
  try {
    const open = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'Add another OpenRouter key')!
    assert.ok(open, 'the add button is offered once a key is stored')
    assert.ok(open.closest('.set-head-right'), 'add is beside the provider switch in the header')
    assert.equal(view.el.querySelectorAll('.set-head-right .acct-secondary-btn').length, 1, 'one header add action')
    await inAct(async () => { open.click(); await flush(4) })
    const dialog = document.querySelector('[aria-label="Add another OpenRouter key"]')!
    assert.ok(dialog, 'the add form opens in the provider dialog')
    const save = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save')!
    assert.ok(save.disabled, 'no key, no save')
    await inAct(async () => {
      type(dialog.querySelector<HTMLInputElement>('input[aria-label="OpenRouter key name"]')!, 'research')
      type(dialog.querySelector<HTMLInputElement>('input[aria-label="OpenRouter API key"]')!, 'sk-or-v1-second-000000')
      await flush(2)
    })
    await inAct(async () => { save.click(); await flush(10) })
    const post = seen.find((r) => r.method === 'POST' && r.path === '/api/openrouter/keys')
    assert.deepEqual(post?.body, { key: 'sk-or-v1-second-000000', label: 'research' })
    assert.equal(document.body.textContent?.includes('sk-or-v1-second'), false, 'the key never renders')
    assert.ok(view.el.textContent?.includes('research (openrouter-3)'), 'the new key has its row')
  } finally {
    await view.unmount(); delete g.fetch
  }
})

test('a key\'s settings rename and optionally replace in one dialog, with no separate name action', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const view = await mount()
  try {
    assert.equal(view.el.querySelector('button[title="name this key"]') === null, true, 'no separate name button')
    assert.equal(view.el.querySelector('button[title^="replace the key"]') === null, true, 'no first-key-only button')
    const open = view.el.querySelector<HTMLButtonElement>('button[title^="rename this key"]')!
    await inAct(async () => { open.click(); await flush(4) })
    let dialog = document.querySelector('[aria-label="Edit personal"]')!
    let name = dialog.querySelector<HTMLInputElement>('input[aria-label="OpenRouter key name"]')!
    assert.equal(name.value, '', 'provider key label is not a custom name')
    await inAct(async () => { type(name, 'personal budget'); await flush(2) })
    let save = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Save')!
    await inAct(async () => { save.click(); await flush(10) })
    assert.deepEqual(seen.find(r => r.method === 'PUT' && r.path === '/api/openrouter/keys/openrouter-1')?.body,
      { label: 'personal budget' }, 'name-only saves without replacing the secret')
    await inAct(async () => { open.click(); await flush(4) })
    dialog = document.querySelector('[aria-label="Edit personal budget"]')!
    name = dialog.querySelector<HTMLInputElement>('input[aria-label="OpenRouter key name"]')!
    assert.equal(name.value, 'personal budget', 'current custom label is prefilled')
    await inAct(async () => {
      type(name, '')
      type(dialog.querySelector<HTMLInputElement>('input[aria-label="OpenRouter API key"]')!, 'synthetic-replacement')
      await flush(2)
    })
    save = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Save')!
    await inAct(async () => { save.click(); await flush(10) })
    assert.deepEqual(seen.filter(r => r.method === 'PUT' && r.path === '/api/openrouter/keys/openrouter-1').at(-1)?.body,
      { label: '', key: 'synthetic-replacement' }, 'empty custom name and replacement sent together')
    assert.equal(document.body.textContent?.includes('synthetic-replacement'), false)
  } finally { await view.unmount(); delete g.fetch }
})

test('§3 a key is switched off on its own, and removing a key DELETEs only it', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const view = await mount()
  try {
    const teamSwitch = [...view.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][1]!
    assert.ok(teamSwitch)
    await inAct(async () => { teamSwitch.click(); await flush(10) })
    const put = seen.find((r) => r.method === 'PUT' && r.path === '/api/accounts/openrouter-2/enabled')
    assert.deepEqual(put?.body, { enabled: false })
    assert.ok(view.el.textContent?.includes('Inactive: its agents wait'), 'the inactive note shows')
    const del = view.el.querySelectorAll<HTMLButtonElement>('.acct-row.orr-keyrow')[1]!
      .querySelector<HTMLButtonElement>('.acct-del')!
    await inAct(async () => { del.click(); await flush(10) })
    assert.ok(seen.some((r) => r.method === 'DELETE' && r.path === '/api/openrouter/keys/openrouter-2'))
    assert.equal(seen.some((r) => r.method === 'DELETE' && r.path === '/api/openrouter/key'), false,
      'the other key is untouched')
    assert.equal(view.el.querySelectorAll('.acct-row.orr-keyrow').length, 1, 'its row is gone')
    // the first key is removed the same way: no special path
    const first = view.el.querySelector<HTMLButtonElement>('.acct-row.orr-keyrow .acct-del')!
    await inAct(async () => { first.click(); await flush(10) })
    assert.ok(seen.some((r) => r.method === 'DELETE' && r.path === '/api/openrouter/keys/openrouter-1'),
      'removing the first key DELETEs it by its id too')
  } finally {
    await view.unmount(); delete g.fetch
  }
})

test('RED control: a key that once was the "original" gets no row of its own any more', async () => {
  const seen: Seen[] = []
  // an older backend's flag must not single a key out: the list is uniform
  stubFetch(seen, [{ ...key('openrouter-1'), original: true } as OpenRouterKey, key('openrouter-2', { label: 'team', name: 'team' })])
  const view = await mount()
  try {
    const rows = [...view.el.querySelectorAll('.acct-row.orr-keyrow')]
    assert.equal(rows.length, 2, 'both keys in one list')
    assert.equal(view.el.querySelectorAll('.acct-line').length, rows.length, 'no extra key row beside the list')
    assert.ok(rows[0]!.textContent?.includes('(openrouter-1)'), 'the first key shows its id like every key')
  } finally { await view.unmount(); delete g.fetch }
})
