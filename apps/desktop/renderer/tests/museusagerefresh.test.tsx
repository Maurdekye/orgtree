import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageModal } from '../src/App'
import { AccountUsagePanel } from '../src/accountusage'
import { legacyAppBackend } from './appfeed-fixture'
import type { AccountUsage } from '../src/types'

const hint = 'Muse usage only arrives at the end of a Muse turn.'
const observed = '2026-10-14T22:00:00Z'
const reading = (account: string, provider: string, available = true): AccountUsage => ({
  account, provider, label: account, available, observed_at: observed,
  limits: available ? [{ kind: 'session', group: 'session', percent: 17,
    severity: 'normal', resets_at: null, is_active: false, model: null }] : [],
  ...(available ? {} : { error: 'No usage reported yet' }),
})
const reply = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
}))

async function withModal(available: boolean, run: (el: HTMLElement, urls: string[]) => Promise<void>) {
  const saved = globalThis.fetch, urls: string[] = []
  globalThis.fetch = legacyAppBackend(async input => {
    const url = new URL(String(input), 'http://localhost'), path = url.pathname
    urls.push(path + url.search)
    if (path === '/api/providers') return reply({ providers: ['muse', 'claude'].map(id => ({
      id, hire_enabled: true, status: { installed: true },
    })) })
    if (path === '/api/accounts') return reply({ accounts: [
      { id: 'custom-login', provider: 'muse', harness: 'muse', label: 'Fixture Muse',
        mode: 'subscription', enabled: true, ambient: false, auth: 'authenticated',
        credential: { kind: 'managed', path: 'D:/synthetic/muse' },
        identity: { email: 'muse@example.test' }, tint_ordinal: 1, bound: [] },
      { id: 'muse-named-claude', provider: 'claude', harness: 'claude-code', label: 'Fixture Claude',
        mode: 'subscription', enabled: true, ambient: false, auth: 'authenticated',
        credential: { kind: 'managed', path: 'D:/synthetic/claude' },
        identity: { email: 'claude@example.test' }, tint_ordinal: 2, bound: [] },
    ] })
    if (path === '/api/muse/usage') return reply(reading('default', 'Muse', available))
    if (path === '/api/accounts/custom-login/usage') return reply(reading('custom-login', 'muse', available))
    if (path === '/api/accounts/muse-named-claude/usage') return reply(reading('muse-named-claude', 'Claude'))
    if (path === '/api/usage') return reply(reading('primary', 'Claude'))
    if (path === '/api/langservers') return reply({ servers: [] })
    if (path.includes('/keys/usage')) return reply({})
    return reply({ available: false, limits: [] })
  })
  let view: Awaited<ReturnType<typeof mountView>> | undefined
  try {
    view = await mountView(<UsageModal close={() => {}} toast={() => {}} />, el => el)
    await inAct(() => flush(16))
    await run(view.el, urls)
  } finally { await view?.unmount(); globalThis.fetch = saved }
}

for (const available of [true, false]) test(`host and registered Muse refresh stay visible but disabled (${available ? 'dated bars' : 'unavailable'})`, async () => {
  await withModal(available, async (el, urls) => {
    const buttons = ['refresh Muse usage', 'refresh custom-login usage'].map(label =>
      el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`))
    assert.ok(buttons.every(Boolean), 'both actual Muse account cards expose their refresh control')
    const before = [...urls]
    for (const button of buttons) {
      assert.equal(button!.disabled, true)
      assert.equal(button!.title, hint)
      assert.equal(button!.parentElement!.title, hint, 'wrapper supplies hover text over a disabled button')
      assert.ok(button!.querySelector('svg'), 'arrow remains visible')
      assert.equal(button!.hidden, false)
      await inAct(async () => {
        button!.click()
        button!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await flush(8)
      })
    }
    assert.deepEqual(urls, before, 'clicks cannot request a refresh for either Muse account')
    if (available) {
      assert.ok(buttons.every(button => !!button!.closest('.usage-acct')!.querySelector('.usage-track')))
      assert.ok(buttons.every(button => !!button!.closest('.usage-acct')!.querySelector('.usage-updated')))
    }
  })
})

test('non-Muse native and registered cards retain their force refresh, even with a Muse-looking account ID', async () => {
  await withModal(true, async (el, urls) => {
    for (const label of ['refresh Claude usage', 'refresh muse-named-claude usage']) {
      const button = el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
      assert.ok(button)
      assert.equal(button.disabled, false)
      assert.equal(button.title, label)
      await inAct(async () => { button.click(); await flush(8) })
    }
    assert.deepEqual(urls.filter(url => url.includes('force=true')), [
      '/api/usage?force=true', '/api/accounts/muse-named-claude/usage?force=true',
    ])
  })
})

for (const provider of ['Muse', 'Claude']) test(`reusable ${provider} account usage panel preserves its refresh policy`, async () => {
  const saved = globalThis.fetch, urls: string[] = []
  globalThis.fetch = async input => { urls.push(String(input)); return reply(reading('fixture', provider)) }
  let view: Awaited<ReturnType<typeof mountView>> | undefined
  try {
    view = await mountView(<AccountUsagePanel accountId="fixture" />, el => el)
    await inAct(() => flush(8))
    const button = view.el.querySelector<HTMLButtonElement>('.account-usage button')!
    assert.ok(button)
    assert.equal(button.disabled, provider === 'Muse')
    assert.equal(button.title, provider === 'Muse' ? hint : '')
    if (provider === 'Muse') assert.equal(button.parentElement!.title, hint)
    const before = urls.length
    await inAct(async () => {
      button.click()
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await flush(8)
    })
    assert.equal(urls.length - before, provider === 'Muse' ? 0 : 2)
  } finally { await view?.unmount(); globalThis.fetch = saved }
})
