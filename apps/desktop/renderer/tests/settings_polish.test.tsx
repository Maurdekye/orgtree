import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CharterDocumentsSetting } from '../src/canvas/chartersettings'
import { AccountsPanel } from '../src/canvas/accounts'
import type { ProviderInfo } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>

test('Charter documents setting: layout, open folder action, and error states', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  const openResult = { ok: true, path: '/mock/home/.orgtree/charters' }
  let openFail = false

  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    seen.push({ method, path, body: init?.body })
    if (path === '/api/charters/populate' && method === 'POST') {
      return Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve({ dir: '/mock/home/.orgtree/charters', created: [], existing: ['default.md'] }),
      })
    }
    if (path === '/api/charters/open' && method === 'POST') {
      if (openFail) {
        return Promise.resolve({
          ok: false, status: 500, statusText: 'Internal Server Error', headers: new Headers(),
          json: () => Promise.resolve({ detail: 'Failed to launch desktop opener' }),
        })
      }
      return Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve(openResult),
      })
    }
    return Promise.reject(new Error(`unexpected ${method} ${path}`))
  }

  const view = await mountView(<CharterDocumentsSetting />, (el) => el)
  try {
    const buttons = view.el.querySelectorAll<HTMLButtonElement>('button')
    assert.equal(buttons.length, 2, 'two buttons rendered in charter settings row')
    assert.match(buttons[0]!.textContent ?? '', /populate/, 'first button is populate for compatibility')
    assert.match(buttons[1]!.textContent ?? '', /open folder/, 'second button is open folder')
    assert.equal(buttons[1]!.getAttribute('aria-label'), 'open charter folder')

    // Test successful open
    await inAct(async () => {
      buttons[1]!.click()
      await flush(10)
    })
    assert.ok(seen.some(s => s.path === '/api/charters/open' && s.method === 'POST'), 'open folder endpoint called')
    assert.equal(view.el.querySelector('[role="alert"]'), null, 'no alert on success')

    // Test failure case
    openFail = true
    await inAct(async () => {
      buttons[1]!.click()
      await flush(10)
    })
    const alert = view.el.querySelector<HTMLElement>('[role="alert"]')
    assert.ok(alert, 'alert shown on open failure')
    assert.match(alert.textContent ?? '', /Could not open charter folder: Failed to launch desktop opener/)

    // Test desktop bridge integration
    openFail = false
    let bridgeCalled = false
    const origDesktop = (window as unknown as Record<string, unknown>).orgtreeDesktop
    ;(window as unknown as Record<string, unknown>).orgtreeDesktop = {
      openCharterFolder: async () => {
        bridgeCalled = true
        return { ok: false, error: 'Desktop bridge denied opener' }
      },
    }

    await inAct(async () => {
      buttons[1]!.click()
      await flush(10)
    })
    assert.ok(bridgeCalled, 'desktop bridge openCharterFolder was preferred when available')
    const bridgeAlert = view.el.querySelector<HTMLElement>('[role="alert"]')
    assert.ok(bridgeAlert)
    assert.match(bridgeAlert.textContent ?? '', /Could not open charter folder: Desktop bridge denied opener/)

    // Test non-directory canonical path error
    ;(window as unknown as Record<string, unknown>).orgtreeDesktop = {
      openCharterFolder: async () => {
        return { ok: false, error: 'Charter path exists but is not a directory: /mock/home/.orgtree/charters' }
      },
    }

    await inAct(async () => {
      buttons[1]!.click()
      await flush(10)
    })
    const nonDirAlert = view.el.querySelector<HTMLElement>('[role="alert"]')
    assert.ok(nonDirAlert)
    assert.match(nonDirAlert.textContent ?? '', /Charter path exists but is not a directory/)

    // Restore
    if (origDesktop) {
      ;(window as unknown as Record<string, unknown>).orgtreeDesktop = origDesktop
    } else {
      delete (window as unknown as Record<string, unknown>).orgtreeDesktop
    }
  } finally {
    await view.unmount()
    delete g.fetch
  }
})

test('Providers tab: compact refresh bar, secondary button styling, and discovery state', async () => {
  const provider = (id: 'claude' | 'openai' | 'google', on = true): ProviderInfo => ({
    id,
    label: id === 'openai' ? 'Codex' : id === 'google' ? 'Antigravity' : 'Claude',
    cli: id === 'openai' ? 'Codex CLI' : id === 'google' ? 'Antigravity CLI' : 'Claude Code',
    tiers: [],
    status: { installed: true, connected: true, source: 'path' },
    hire_enabled: on,
    user_enabled: on,
    reason: null,
  })

  let loadProvidersCalls = 0
  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    if (path === '/api/accounts') {
      return Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve({ version: 2, primary: { id: 'primary', signed_in: true }, keys: [], assignments: {} }),
      })
    }
    if (path === '/api/providers' && method === 'GET') {
      loadProvidersCalls++
      return Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve({ providers: [provider('claude'), provider('openai'), provider('google')] }),
      })
    }
    if (path === '/api/desktop/import-v1/jobs/current') {
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve({ job: null }) })
    }
    if (path === '/api/app-settings/runtime') {
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve({}) })
    }
    return Promise.reject(new Error(`unexpected ${method} ${path}`))
  }

  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} />, (el) => el)
  try {
    await inAct(async () => { await flush(20) })
    const panel = view.el.querySelector('#app-settings-panel-providers')!
    assert.ok(panel, 'providers panel mounted')

    // Check compact providers bar
    const bar = panel.querySelector('.acct-providers-bar')
    assert.ok(bar, 'acct-providers-bar element exists')
    assert.equal(bar.getAttribute('role'), 'status')

    // Check refresh button
    const refreshBtn = bar.querySelector<HTMLButtonElement>('.acct-refresh-btn')
    assert.ok(refreshBtn, 'refresh button exists in providers bar')
    assert.ok(refreshBtn.classList.contains('acct-secondary-btn'), 'refresh button uses acct-secondary-btn styling')
    assert.equal(refreshBtn.getAttribute('aria-label'), 'refresh provider status')
    assert.equal(refreshBtn.getAttribute('title'), 'refresh provider status')
    assert.match(refreshBtn.textContent ?? '', /refresh/)

    // Click refresh
    const prevCalls = loadProvidersCalls
    await inAct(async () => {
      refreshBtn.click()
      await flush(10)
    })
    assert.ok(loadProvidersCalls > prevCalls, 'loadProviders triggered on refresh click')
  } finally {
    await view.unmount()
    delete g.fetch
  }
})

test('Display tab: section headers Appearance, Desk, Startup omit "saved on this computer" annotation while keeping headings and controls', async () => {
  g.fetch = (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (path === '/api/accounts') {
      return Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve({ version: 2, primary: { id: 'primary', signed_in: true }, keys: [], assignments: {} }),
      })
    }
    if (path === '/api/desktop/import-v1/jobs/current') {
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve({ job: null }) })
    }
    if (path === '/api/app-settings/runtime') {
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve({}) })
    }
    return Promise.reject(new Error(`unexpected ${path}`))
  }

  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} />, (el) => el)
  try {
    await inAct(async () => { await flush(20) })
    const displayTab = [...view.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find(b => b.textContent?.includes('Display'))!
    assert.ok(displayTab, 'Display tab button found')
    await inAct(async () => { displayTab.click(); await flush(10) })

    const panel = view.el.querySelector<HTMLElement>('#app-settings-panel-display')!
    assert.ok(panel, 'display panel mounted')

    // Find all section heads
    const heads = [...panel.querySelectorAll<HTMLElement>('.set-group-head')]
    const headTitles = heads.map(h => h.textContent?.trim() ?? '')

    // Assert headings remain
    assert.ok(headTitles.some(t => t.includes('Appearance')), 'Appearance section heading exists')
    assert.ok(headTitles.some(t => t.includes('Desk')), 'Desk section heading exists')
    assert.ok(headTitles.some(t => t.includes('Startup')), 'Startup section heading exists')

    // Assert "saved on this computer" annotations are absent
    assert.equal(panel.textContent?.includes('saved on this computer'), false,
      '"saved on this computer" annotation is absent from Display panel')

    // Assert key controls remain functional
    assert.ok(panel.querySelector('select[aria-label="Visual theme"]'), 'Visual theme control remains')
    assert.ok(panel.querySelector('input[aria-label="collapse crowded teams into one stack"]'), 'Desk crowd control remains')
    assert.ok(panel.querySelector('select[aria-label="open an org at"]'), 'Startup view control remains')
  } finally {
    await view.unmount()
    delete g.fetch
  }
})

