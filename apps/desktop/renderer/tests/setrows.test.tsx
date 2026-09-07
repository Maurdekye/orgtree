// D-222 — the settings row system.
//
// These are STRUCTURAL checks, and they are here rather than only in the
// browser probe because the defect they guard is a source-level one: a row
// that opts out of the shared grid and lays itself out by hand. jsdom cannot
// see that the three Runtime state words used to land at three different x
// positions in one panel; it CAN see the thing that caused it — rows that
// were not the same kind of object. The measured half of the guarantee lives
// in `tests/settings_layout_probe.py`, which drives a real browser.
//
// §8 is the odd one and the most valuable: it catches a whole bug CLASS that
// bit during this very change. A multi-line JSX *attribute* string keeps its
// source indentation verbatim, unlike a JSX child, so `hint="a b\n    c d"`
// puts a newline and eight spaces into the DOM. It looks fine on screen —
// HTML collapses the run visually — and is wrong everywhere text is read
// rather than painted.

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

const provider = (id: 'claude' | 'openai' | 'google'): ProviderInfo => ({
  id,
  label: id === 'openai' ? 'Codex' : id === 'google' ? 'Antigravity' : 'Claude',
  cli: id === 'openai' ? 'Codex CLI' : id === 'google' ? 'Antigravity CLI'
    : 'Claude Code',
  tiers: [],
  status: { installed: true, connected: true, source: 'path' },
  // openai stays hire-disabled so the PREVIEW tag renders and §10 has
  // something to place
  hire_enabled: id !== 'openai',
  user_enabled: true,
  reason: null,
})

const PROVIDERS: ProvidersPayload = { providers: [
  provider('claude'), provider('openai'), provider('google'),
] }

const g = globalThis as unknown as Record<string, unknown>

function stubFetch(): void {
  let warming = true
  let checkups = true
  let mcpWait = false
  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    const body = init?.body
      ? JSON.parse(String(init.body)) as Record<string, boolean> : null
    if (path === '/api/app-settings/runtime' && method === 'PUT' && body) {
      if (body.enabled !== undefined) warming = body.enabled
      if (body.working_checkups_enabled !== undefined)
        checkups = body.working_checkups_enabled
      if (body.wait_for_mcp_tools_enabled !== undefined)
        mcpWait = body.wait_for_mcp_tools_enabled
    }
    const runtime = {
      warming_enabled: warming,
      working_checkups_enabled: checkups,
      wait_for_mcp_tools_enabled: mcpWait,
    }
    const payload = path === '/api/accounts' ? ACCOUNTS
      : path === '/api/providers' ? PROVIDERS
        : path === '/api/app-settings/runtime' ? runtime : null
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

async function openTab(view: { el: HTMLElement }, label: string) {
  const tab = [...view.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((b) => b.textContent?.includes(label))!
  await inAct(async () => { tab.click() })
  return tab
}

const press = async (el: HTMLElement, key: string) => {
  await inAct(async () => {
    el.dispatchEvent(new (globalThis as unknown as {
      KeyboardEvent: typeof KeyboardEvent
    }).KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

const selected = (view: { el: HTMLElement }) =>
  view.el.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? ''

test('§6 every adjustable row in every tab is the SAME object — one grid, '
  + 'never a hand-laid flex row', async () => {
  localStorage.clear()
  stubFetch()
  const view = await mountSettings()
  try {
    for (const label of ['Runtime', 'Display']) {
      await openTab(view, label)
      const panel = view.el.querySelector<HTMLElement>(
        `#app-settings-panel-${label.toLowerCase()}`)!
      const rows = [...panel.querySelectorAll<HTMLElement>('.set-row')]
      assert.ok(rows.length >= 1, `${label}: no .set-row at all`)

      for (const row of rows) {
        // the label rail: a row without one is a row that decided for itself
        // where its text goes
        assert.equal(row.querySelectorAll(':scope > .set-label').length, 1,
          `${label}: a .set-row without exactly one .set-label`)
        // THE GRID OWNS POSITION; callers own content. Checked on the row AND
        // on everything inside it: a `margin-left: auto` on the control span
        // right-aligns it just as the old flex rows did, and at desktop width
        // it looks identical to the correct result — it only diverges when
        // the narrow layout stacks the control onto its own line. (Not
        // hypothetical: exactly this slipped through during D-222 and was
        // caught by settings_layout_probe.py at 380px, not here.)
        assert.equal(row.getAttribute('style'), null,
          `${label}: a .set-row carrying inline style`)
        for (const kid of row.querySelectorAll('[style]')) {
          assert.fail(`${label}: inline style inside a row — the grid places `
            + `things, not the caller: ${kid.outerHTML.slice(0, 110)}`)
        }
      }

      // a control is either in the lead slot (a toggle) or the trailing
      // control column — never loose in the row
      for (const box of panel.querySelectorAll<HTMLElement>(
        '.set-row input, .set-row select, .set-row button')) {
        assert.ok(box.closest('.set-lead') || box.closest('.set-control'),
          `${label}: a control in neither row slot: ${box.outerHTML}`)
      }

      // the retired idioms must not come back
      assert.equal(panel.querySelectorAll(
        '.app-pref-row, .app-pref-check, .app-pref-state, .app-pref-control')
        .length, 0, `${label}: a pre-D-222 row class survived`)
    }
  } finally { await view.unmount(); delete g.fetch; localStorage.clear() }
})

test('§7 a toggle names itself to a screen reader without reading out its own '
  + 'hint, and the visible state word tracks the switch', async () => {
  localStorage.clear()
  stubFetch()
  const view = await mountSettings()
  try {
    await openTab(view, 'Runtime')
    const panel = view.el.querySelector<HTMLElement>(
      '#app-settings-panel-runtime')!
    const rows = [...panel.querySelectorAll<HTMLElement>('.set-row')]
    assert.equal(rows.length, 3)
    for (const row of rows) {
      const box = row.querySelector<HTMLInputElement>('.set-lead input')!
      const name = box.getAttribute('aria-label')
      assert.ok(name && name.length > 0, 'a switch with no accessible name')
      // the row's own text includes the hint prose, so the name must be the
      // SETTING rather than the paragraph
      assert.ok(name!.length < (row.textContent ?? '').length,
        `accessible name swallowed the hint: ${name}`)
      assert.equal(box.getAttribute('role'), 'switch')
      assert.equal(row.querySelector('.set-state')!.textContent,
        box.checked ? 'on' : 'off')
    }
    // …and it still tracks through a real flip that goes to the server
    const first = rows[0]!.querySelector<HTMLInputElement>('.set-lead input')!
    assert.equal(first.checked, true)
    await inAct(async () => { first.click(); await flush(10) })
    assert.equal(first.checked, false)
    assert.equal(rows[0]!.querySelector('.set-state')!.textContent, 'off')
  } finally { await view.unmount(); delete g.fetch; localStorage.clear() }
})

test('§8 no row leaks its source indentation into the DOM — a multi-line JSX '
  + 'ATTRIBUTE string is not whitespace-collapsed the way a child is',
async () => {
  localStorage.clear()
  stubFetch()
  const view = await mountSettings()
  try {
    for (const label of ['Providers', 'Runtime', 'Display']) {
      await openTab(view, label)
      const panel = view.el.querySelector<HTMLElement>(
        `#app-settings-panel-${label.toLowerCase()}`)!
      for (const node of panel.querySelectorAll<HTMLElement>(
        '.set-label, .set-hint, .set-state, .set-group-head')) {
        const text = node.textContent ?? ''
        assert.doesNotMatch(text, /\n/,
          `${label}: a newline reached the DOM. Write the string as a JSX `
          + `expression, not a wrapped attribute literal: `
          + JSON.stringify(text))
        assert.doesNotMatch(text, / {2,}/,
          `${label}: a run of spaces reached the DOM: ` + JSON.stringify(text))
      }
    }
  } finally { await view.unmount(); delete g.fetch; localStorage.clear() }
})

test('§9 the tab strip is ONE keyboard control: roving tabindex, arrows that '
  + 'wrap, and every tab pointing at a panel that exists', async () => {
  localStorage.clear()
  stubFetch()
  const view = await mountSettings()
  try {
    const tabs = [...view.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    assert.equal(tabs.length, 3)
    for (const t of tabs) {
      const panel = view.el.querySelector(`#${t.getAttribute('aria-controls')}`)
      assert.ok(panel, `tab ${t.textContent} controls a panel that is absent`)
      assert.equal(panel!.getAttribute('role'), 'tabpanel')
      assert.equal(panel!.getAttribute('aria-labelledby'), t.id)
    }
    // exactly one tab stop for the whole strip, and it is the selected tab
    const stops = tabs.filter((t) => t.tabIndex === 0)
    assert.equal(stops.length, 1)
    assert.equal(stops[0]!.getAttribute('aria-selected'), 'true')

    await press(tabs[0]!, 'ArrowLeft')      // wraps backwards to the last
    assert.match(selected(view), /Display/)
    await press(tabs[2]!, 'ArrowRight')     // wraps forwards to the first
    assert.match(selected(view), /Providers/)
    await press(tabs[0]!, 'End')
    assert.match(selected(view), /Display/)
    await press(tabs[2]!, 'Home')
    assert.match(selected(view), /Providers/)

    // an inactive panel is `hidden`, not merely off-screen: its controls are
    // out of the tab order and out of the accessibility tree
    assert.equal(view.el.querySelector('#app-settings-panel-runtime')!
      .hasAttribute('hidden'), true)
  } finally { await view.unmount(); delete g.fetch; localStorage.clear() }
})

test('§10 a Providers head puts its preview tag and its switch in ONE '
  + 'right-hand cluster, so neither floats mid-row', async () => {
  localStorage.clear()
  stubFetch()
  const view = await mountSettings()
  try {
    const heads = [...view.el.querySelectorAll<HTMLElement>(
      '.acct-provider-head')]
    assert.ok(heads.length >= 2, 'expected at least Claude and Codex heads')
    let sawTag = false
    for (const head of heads) {
      // a vendor head IS a section head — the same object Runtime uses
      assert.ok(head.classList.contains('set-group-head'),
        'a provider head that is not the shared section head')
      const tag = head.querySelector('.acct-preview-tag')
      const sw = head.querySelector('.provider-switch')
      if (tag) sawTag = true
      for (const item of [tag, sw]) {
        if (item) {
          assert.ok(item.closest('.set-head-right'),
            'a head control outside the single right-hand cluster')
        }
      }
    }
    assert.equal(sawTag, true, 'no preview tag rendered — §10 proved nothing')
  } finally { await view.unmount(); delete g.fetch; localStorage.clear() }
})
