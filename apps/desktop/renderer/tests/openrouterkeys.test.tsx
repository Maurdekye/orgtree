// Several OpenRouter keys at once (docket use-several-openrouter-keys-at-once,
// ruling 2026-10-11; per-key switch user 2026-10-11 22:50). Driven through
// the OpenRouter section's rendered controls against a scripted fetch: each
// added key gets its own row (name, lane, spend line with the shared
// "account balance"), "Add another OpenRouter key" POSTs a key and an
// optional name, every key has its own active switch, and a key is only ever
// SENT — never rendered.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenRouterSection } from '../src/canvas/openrouter'
import type { OpenRouterDoc, OpenRouterKey, ProviderInfo } from '../src/types'

type Seen = { method: string; path: string; body: unknown }
const g = globalThis as unknown as Record<string, unknown>

const SPEND = '$8.49 of $25.00 spend cap · $18.57 account balance'

function key(id: string, over: Partial<OpenRouterKey> = {}): OpenRouterKey {
  const original = id === 'openrouter-key'
  return {
    id, lane: original ? 'openrouter' : id, original, label: null,
    name: original ? 'personal' : 'OpenRouter key 2', key_label: null, enabled: true,
    connected: true, reason: null, observed_at: '2026-10-11T22:00:00Z',
    limits: [{ kind: 'usage', label: SPEND, percent: 34 } as OpenRouterKey['limits'][number]],
    ...over,
  }
}

function stubFetch(seen: Seen[]) {
  let keys: OpenRouterKey[] = [key('openrouter-key'), key('openrouter-2', { label: 'team', name: 'team' })]
  const doc = (): OpenRouterDoc => ({
    installed: true, connected: true, key_set: true, kind: 'api-key', label: 'personal',
    credits: { limit: 25, limit_remaining: 16.51, usage: 8.49, usage_daily: null, usage_weekly: null,
      usage_monthly: null, is_free_tier: false, checked_at: '2026-10-11T22:00:00Z' },
    reason: null, favorites: 0, favorites_max: 0, tiers: [], user_enabled: true,
    keys, any_key: true,
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

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

test('§1 every key is its own row: the original by its name, an added one by name and lane with its spend', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const view = await mount()
  try {
    const rows = [...view.el.querySelectorAll('.acct-row.orr-keyrow')]
    assert.equal(rows.length, 2, 'the original row and one added row')
    assert.ok(rows[0]!.textContent?.includes('personal'), 'the original row is called by its name')
    const added = rows[1]!
    assert.ok(added.textContent?.includes('team (openrouter-2)'), 'name and lane')
    assert.ok(added.querySelector('.acct-provenance')!.textContent?.includes('account balance'),
      'the balance says it is the account\'s')
    for (const b of view.el.querySelectorAll('.acct-btn')) {
      assert.equal(b.textContent?.trim(), '', `no text in an icon button (${b.getAttribute('title')})`)
    }
    const switches = [...view.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    assert.equal(switches.length, 2, 'one active switch per key')
    assert.ok(switches.every((s) => s.checked), 'both keys active')
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

test('§3 a key is switched off on its own, and removing an added key DELETEs only it', async () => {
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
      'the original key is untouched')
    assert.equal(view.el.querySelectorAll('.acct-row.orr-keyrow').length, 1, 'the added row is gone')
  } finally {
    await view.unmount(); delete g.fetch
  }
})
