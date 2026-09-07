// D-203 — the former Accounts panel is now machine-wide App settings.
//
// These checks drive the rendered controls. Reading a localStorage key or a
// JSON fixture alone would let a beautiful toggle that reaches no behavior
// pass. The browser probe separately covers full reload and canvas effects.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'
import type { AccountsPayload, ProviderInfo, ProvidersPayload } from '../src/types'

const ACCOUNTS: AccountsPayload = {
  version: 2,
  primary: { id: 'primary', signed_in: true, email: 'me@example.test' },
  keys: [], assignments: {},
} as unknown as AccountsPayload

const provider = (id: 'claude' | 'openai' | 'google', on = true,
                  installed = true): ProviderInfo => ({
  id,
  label: id === 'openai' ? 'Codex' : id === 'google' ? 'Antigravity' : 'Claude',
  cli: id === 'openai' ? 'Codex CLI' : id === 'google' ? 'Antigravity CLI'
    : 'Claude Code',
  tiers: [],
  status: { installed, connected: installed, source: 'path' },
  hire_enabled: installed && on,
  user_enabled: on,
  reason: on ? null : 'turned off in App settings → Providers',
})

const ON: ProvidersPayload = { providers: [
  provider('claude'), provider('openai'), provider('google'),
] }
const CLAUDE_OFF: ProvidersPayload = { providers: [
  provider('claude', false), provider('openai'), provider('google'),
] }
const CODEX_OFF_ABSENT: ProvidersPayload = { providers: [
  provider('claude'), provider('openai', false, false), provider('google'),
] }

type Seen = { method: string; path: string; body: unknown }
const g = globalThis as unknown as Record<string, unknown>

function stubFetch(seen: Seen[], initial = ON): void {
  let warmingEnabled = true
  let workingCheckupsEnabled = true
  let waitForMcpToolsEnabled = false
  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    seen.push({ method, path, body })
    if (path === '/api/app-settings/runtime' && method === 'PUT') {
      const runtime = body as {
        enabled?: boolean, working_checkups_enabled?: boolean,
        wait_for_mcp_tools_enabled?: boolean
      }
      if (runtime.enabled !== undefined) warmingEnabled = runtime.enabled
      if (runtime.working_checkups_enabled !== undefined)
        workingCheckupsEnabled = runtime.working_checkups_enabled
      if (runtime.wait_for_mcp_tools_enabled !== undefined)
        waitForMcpToolsEnabled = runtime.wait_for_mcp_tools_enabled
    }
    const payload = path === '/api/accounts' ? ACCOUNTS
      : path === '/api/providers' ? initial
        : path === '/api/app-settings/runtime' && method === 'GET'
          ? { warming_enabled: warmingEnabled,
              working_checkups_enabled: workingCheckupsEnabled,
              wait_for_mcp_tools_enabled: waitForMcpToolsEnabled }
          : path === '/api/app-settings/runtime' && method === 'PUT'
            ? { warming_enabled: warmingEnabled,
                working_checkups_enabled: workingCheckupsEnabled,
                wait_for_mcp_tools_enabled: waitForMcpToolsEnabled }
        : path === '/api/providers/claude/enabled' && method === 'PUT'
          ? CLAUDE_OFF : null
    if (!payload) return Promise.reject(new Error(`unexpected ${method} ${path}`))
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(payload),
    })
  }
}

async function mountSettings() {
  const view = await mountView(
    <AccountsPanel toast={() => {}} close={() => {}} />, (el) => el)
  await inAct(async () => { await flush(10) })
  return view
}

test('§1 stable accessible tabs navigate by key without swapping identity',
  async () => {
    localStorage.clear()
    stubFetch([])
    const view = await mountSettings()
    try {
      const tabs = view.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      assert.deepEqual([...tabs].map((b) => b.textContent?.trim()),
        ['Providers', 'Runtime', 'Displaythis browser'])
      assert.equal(tabs[0]!.getAttribute('aria-selected'), 'true')
      assert.equal(tabs[1]!.getAttribute('aria-selected'), 'false')
      await inAct(async () => {
        tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowRight', bubbles: true,
        }))
      })
      assert.equal(tabs[0]!.getAttribute('aria-selected'), 'false')
      assert.equal(tabs[1]!.getAttribute('aria-selected'), 'true')
      assert.equal(document.activeElement, tabs[1])
      await inAct(async () => {
        tabs[1]!.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'End', bubbles: true,
        }))
      })
      assert.equal(tabs[2]!.getAttribute('aria-selected'), 'true')
      assert.equal(document.activeElement, tabs[2])
      const display = view.el.querySelector('#app-settings-panel-display')!
      assert.equal(display.hasAttribute('hidden'), false)
    } finally { await view.unmount(); delete g.fetch }
  })

test('§2 an installed provider turns off, remains visible, and sends the '
  + 'machine-wide request', async () => {
  localStorage.clear()
  const seen: Seen[] = []
  stubFetch(seen)
  const view = await mountSettings()
  try {
    const sw = view.el.querySelector<HTMLInputElement>(
      'input[aria-label="Claude enabled for new agents"]')
    assert.ok(sw, 'configured Claude has a provider switch')
    assert.equal(sw.checked, true)
    await inAct(async () => { sw.click(); await flush(10) })
    const put = seen.find((r) => r.method === 'PUT')
    assert.deepEqual(put, {
      method: 'PUT', path: '/api/providers/claude/enabled',
      body: { enabled: false },
    })
    const after = view.el.querySelector<HTMLInputElement>(
      'input[aria-label="Claude enabled for new agents"]')
    assert.ok(after, 'off provider must keep the control that turns it on')
    assert.equal(after.checked, false)
    assert.match(view.el.textContent ?? '', /Claude/)
    assert.match(view.el.textContent ?? '', /off/)
  } finally { await view.unmount(); delete g.fetch }
})

test('§3 Display owns both browser-local controls, with durable values and no '
  + 'explanatory blurb', async () => {
  localStorage.clear()
  stubFetch([])
  let view = await mountSettings()
  try {
    const displayTab = [...view.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((b) => b.textContent?.includes('Display'))!
    await inAct(async () => { displayTab.click() })
    const panel = view.el.querySelector<HTMLElement>('#app-settings-panel-display')!
    assert.equal(panel.querySelectorAll('.hint').length, 0)
    assert.match(panel.textContent ?? '', /desk text size/)
    // D-222 renamed the crowd toggle: the LABEL is now the short imperative
    // and the 8-agent threshold moved into the row's hint, where the rest of
    // the settings surface puts its qualifying prose.
    assert.match(panel.textContent ?? '', /collapse crowded teams into one stack/)
    assert.match(panel.textContent ?? '',
      /more than 8 active agents draws as a single stack/)
    const plus = [...panel.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === '+')!
    await inAct(async () => { plus.click() })
    const crowd = panel.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await inAct(async () => { crowd.click() })
    assert.equal(localStorage.getItem('orgtree-desk-dpi'), '1.25')
    assert.equal(document.documentElement.style.getPropertyValue('--desk-dpi'), '1.25')
    assert.equal(localStorage.getItem('orgtree-crowd-piles'), '1')
  } finally { await view.unmount() }

  // A fresh mount is the control's reload boundary: no component state from
  // the first panel survives, only the two established browser-local keys.
  view = await mountSettings()
  try {
    const displayTab = [...view.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((b) => b.textContent?.includes('Display'))!
    await inAct(async () => { displayTab.click() })
    const panel = view.el.querySelector<HTMLElement>('#app-settings-panel-display')!
    assert.match(panel.textContent ?? '', /125%/)
    assert.equal(panel.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
      true)
  } finally {
    await view.unmount(); delete g.fetch; localStorage.clear()
  }
})

test('§4 Runtime reads and writes both machine-wide lifecycle controls', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const view = await mountSettings()
  try {
    const runtime = [...view.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((b) => b.textContent?.includes('Runtime'))!
    await inAct(async () => { runtime.click() })
    const sw = view.el.querySelector<HTMLInputElement>(
      'input[aria-label="keep agent processes warm"]')!
    assert.equal(sw.checked, true, 'missing warm.flag defaults on')
    await inAct(async () => { sw.click(); await flush(10) })
    assert.equal(sw.checked, false)
    assert.deepEqual(seen.find((r) => r.method === 'PUT'), {
      method: 'PUT', path: '/api/app-settings/runtime',
      body: { enabled: false },
    })
    const checkup = view.el.querySelector<HTMLInputElement>(
      'input[aria-label="check on working agents after 30 minutes"]')!
    assert.equal(checkup.checked, true, 'checkups default on')
    await inAct(async () => { checkup.click(); await flush(10) })
    assert.equal(checkup.checked, false)
    assert.deepEqual(seen.find((r) =>
      (r.body as { working_checkups_enabled?: boolean } | null)
        ?.working_checkups_enabled === false), {
      method: 'PUT', path: '/api/app-settings/runtime',
      body: { working_checkups_enabled: false },
    })
    assert.match(view.el.textContent ?? '', /isolated Claude cache reads instead/)
    const readiness = view.el.querySelector<HTMLInputElement>(
      'input[aria-label="wait until the MCP tool surface is ready"]')!
    assert.equal(readiness.checked, false, 'MCP readiness defaults off')
    await inAct(async () => { readiness.click(); await flush(10) })
    assert.equal(readiness.checked, true)
    assert.deepEqual(seen.find((r) =>
      (r.body as { wait_for_mcp_tools_enabled?: boolean } | null)
        ?.wait_for_mcp_tools_enabled === true), {
      method: 'PUT', path: '/api/app-settings/runtime',
      body: { wait_for_mcp_tools_enabled: true },
    })
  } finally { await view.unmount(); delete g.fetch }
})

test('§5 a durable off choice keeps its recovery switch after uninstall, but '
  + 'does not restore absent-provider details', async () => {
  stubFetch([], CODEX_OFF_ABSENT)
  const view = await mountSettings()
  try {
    const sw = view.el.querySelector<HTMLInputElement>(
      'input[aria-label="Codex enabled for new agents"]')
    assert.ok(sw, 'the off choice must retain the control that reverses it')
    assert.equal(sw.checked, false)
    assert.match(view.el.textContent ?? '', /Codex/)
    assert.doesNotMatch(view.el.textContent ?? '', /Codex CLI not installed/)
  } finally { await view.unmount(); delete g.fetch }
})
