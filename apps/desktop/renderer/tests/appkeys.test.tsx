import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import App from '../src/App'
import { KillSwitch } from '../src/KillSwitch'
import type { KillSwitchActions } from '../src/KillSwitch'
import { OrgtreeMenu } from '../src/shell/menu'
import { APP_FKEYS, installAppShortcuts, matchAppShortcut, refreshFromHeader } from '../src/shell/appshortcuts'
import { forgetAttentionMode, orgView } from '../src/attention/mode'
import { forgetModalOpenCache, forgetModalPins } from '../src/canvas/modalpin'
import { legacyAppBackend } from './appfeed-fixture'
import { installBridge, removeBridge } from './shellbridge'

const press = (key: string, target: EventTarget = document.body, extra: KeyboardEventInit = {}) => {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
  target.dispatchEvent(event)
  return event
}

test('app menu keeps labels and routes, ordered Settings / Usage / Usage History', async () => {
  const calls: string[] = []
  const view = await mountView(<OrgtreeMenu orgs={[]} freshness="current" ageMs={0} error={null}
    currentOrg={null} onOpenOrg={() => {}} onNewWindow={() => {}} onCreateOrg={() => {}}
    onAppSettings={() => calls.push('settings')} onUsage={() => calls.push('usage')}
    onUsageHistory={() => calls.push('history')} />, el => el)
  try {
    const button = view.el.querySelector<HTMLButtonElement>('.shell-menu-button')!
    const expected = ['App settings…', 'Usage…', 'Usage history…']
    for (let i = 0; i < 3; i++) {
      await inAct(() => button.click())
      const rows = [...view.el.querySelectorAll<HTMLButtonElement>('.shell-menu-item')]
        .filter(row => expected.includes(row.querySelector('.shell-menu-label')?.textContent ?? ''))
      assert.deepEqual(rows.map(row => row.querySelector('.shell-menu-label')!.textContent), expected)
      await inAct(() => rows[i]!.click())
      assert.equal(view.el.querySelector('.shell-menu-panel'), null)
    }
    assert.deepEqual(calls, ['settings', 'usage', 'history'])
  } finally { await view.unmount() }
})

test('matcher accepts only bare F1-F10 and assigned Shift+F10, preserving other chords', () => {
  for (const row of APP_FKEYS) for (const key of row.keys) {
    const shiftKey = key.startsWith('Shift+')
    const value = key.replace('Shift+', '')
    assert.equal(matchAppShortcut(new window.KeyboardEvent('keydown', { key: value, shiftKey })), row.id)
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey'])
      assert.equal(matchAppShortcut(new window.KeyboardEvent('keydown', { key: value, shiftKey, [modifier]: true })), undefined)
  }
  for (let n = 1; n <= 9; n++)
    assert.equal(matchAppShortcut(new window.KeyboardEvent('keydown', { key: 'F' + n, shiftKey: true })), undefined)
  assert.equal(matchAppShortcut(new window.KeyboardEvent('keydown', { key: 'F11' })), undefined)
})

test('capture keys work in inputs, textarea and contenteditable, suppress defaults once and clean up', () => {
  const calls: string[] = []
  const stop = installAppShortcuts(window, () => Object.fromEntries(APP_FKEYS.map(row =>
    [row.id, () => calls.push(row.id)])))
  const host = document.createElement('div')
  host.innerHTML = '<input><textarea></textarea><div contenteditable="true"><span>editor</span></div>'
  document.body.append(host)
  try {
    for (const target of [host.querySelector('input')!, host.querySelector('textarea')!, host.querySelector('span')!]) {
      let local = 0
      target.addEventListener('keydown', () => ++local)
      for (const row of APP_FKEYS) {
        const key = row.keys[0]!, shiftKey = key.startsWith('Shift+')
        assert.equal(press(key.replace('Shift+', ''), target, { shiftKey }).defaultPrevented, true)
      }
      assert.equal(local, 0, 'ordinary widget/menu listeners do not run the assigned key again')
    }
    assert.equal(calls.length, APP_FKEYS.length * 3)
    assert.equal(press('F10', host.querySelector('input')!, { repeat: true }).defaultPrevented, true)
    assert.equal(calls.length, APP_FKEYS.length * 3, 'held key does not issue another action')
    assert.equal(press('F4', document.body, { altKey: true }).defaultPrevented, false)
    stop()
    press('F1')
    assert.equal(calls.length, APP_FKEYS.length * 3)
  } finally { stop(); host.remove() }
})

test('F5 uses the existing header Refresh button callback and ignores other refreshes', () => {
  const host = document.createElement('div')
  host.innerHTML = '<button aria-label="Refresh app view"></button><header><button aria-label="Refresh app view"></button></header>'
  document.body.append(host)
  const calls: string[] = []
  host.querySelector('button')!.onclick = () => calls.push('outside')
  host.querySelector('header button')!.addEventListener('click', () => calls.push('custom header callback'))
  try {
    refreshFromHeader(document)
    assert.deepEqual(calls, ['custom header callback'])
    host.querySelector('header button')!.setAttribute('disabled', '')
    refreshFromHeader(document)
    assert.equal(calls.length, 1, 'disabled button remains disabled')
  } finally { host.remove() }
})

test('mouse unlatch remains open at 4.9s and re-latches exactly at 5s', async () => {
  useFakeClock()
  const view = await mountView(<KillSwitch slug="fixture" toast={() => {}} />, el => el)
  try {
    await inAct(() => view.el.querySelector<HTMLButtonElement>('.kill-latch')!.click())
    await advance(4900)
    assert.equal(view.el.querySelector('.kill-latch')!.classList.contains('open'), true)
    await advance(100)
    assert.equal(view.el.querySelector('.kill-latch')!.classList.contains('open'), false)
    assert.equal(view.el.querySelector<HTMLButtonElement>('.kill-btn')!.disabled, true)
  } finally { await view.unmount(); realClock() }
})

test('mouse Halt all at 4.9s still invokes the existing action once', async () => {
  useFakeClock()
  const calls: string[] = []
  const view = await mountView(<KillSwitch slug="fixture" toast={() => {}}
    killFn={async slug => { calls.push(slug); return { interrupted: [] } }} />, el => el)
  try {
    await inAct(() => view.el.querySelector<HTMLButtonElement>('.kill-latch')!.click())
    // Let React settle the 500ms enable before the boundary press.
    await advance(500); await advance(4400)
    await inAct(() => view.el.querySelector<HTMLButtonElement>('.kill-btn')!.click())
    assert.deepEqual(calls, ['fixture'])
    await advance(100)
    assert.equal(view.el.querySelector('.kill-latch')!.classList.contains('open'), false)
  } finally { await view.unmount(); realClock() }
})

test('F10 only arms, repeated F10 never halts or restarts the five-second deadline', async () => {
  useFakeClock()
  let killed = 0, released = 0
  const ref = React.createRef<KillSwitchActions>()
  const view = await mountView(<KillSwitch slug="fixture" toast={() => {}} shortcutRef={ref}
    killFn={async () => { killed++; return { interrupted: [] } }}
    releaseFn={async () => { released++; return { released: true } }} />, el => el)
  const stop = installAppShortcuts(window, () => ({ unlatch: () => ref.current?.unlatch(), halt: () => ref.current?.haltNow() }))
  try {
    await inAct(() => press('F10'))
    assert.equal(view.el.querySelector('.kill-latch')!.classList.contains('open'), true)
    await advance(4900)
    await inAct(() => press('F10'))
    await advance(100)
    assert.equal(view.el.querySelector('.kill-latch')!.classList.contains('open'), false)
    assert.equal(killed, 0); assert.equal(released, 0)
  } finally { stop(); await view.unmount(); realClock() }
})

for (const latched of [false, true]) test(`Shift+F10 immediately halts (persistent org halt=${latched}), never releases`, async () => {
  let killed = 0, released = 0, settle: (() => void) | undefined
  const ref = React.createRef<KillSwitchActions>()
  const view = await mountView(<KillSwitch slug="fixture" toast={() => {}} latched={latched} shortcutRef={ref}
    killFn={() => { killed++; return new Promise(resolve => { settle = () => resolve({ interrupted: [] }) }) }}
    releaseFn={async () => { released++; return { released: true } }} />, el => el)
  const stop = installAppShortcuts(window, () => ({ unlatch: () => ref.current?.unlatch(), halt: () => ref.current?.haltNow() }))
  try {
    const editor = document.createElement('textarea'); document.body.append(editor)
    await inAct(() => press('F10', editor))
    assert.equal(killed, 0); assert.equal(released, 0)
    if (!latched) assert.equal(view.el.querySelector<HTMLButtonElement>('.kill-btn')!.disabled, true, 'still in the arming safety delay')
    await inAct(() => { press('F10', editor, { shiftKey: true }); press('F10', editor, { shiftKey: true }) })
    assert.equal(killed, 1, 'immediate and deduplicated while request is in flight')
    assert.equal(released, 0)
    await inAct(async () => { settle?.(); await flush() })
    editor.remove()
  } finally { stop(); await view.unmount() }
})

test('real main App header and F1-F9 share current-org routes; F4 returns from panels to canvas', async () => {
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, WebSocket: globals.WebSocket, history: globals.history,
    CustomEvent: globals.CustomEvent, DocumentFragment: globals.DocumentFragment }
  const tree = { slug: 'keys-org', name: 'Keys org', roots: [], asks: [], asks_open: 0,
    epoch: 1, rev: 1, dirs: [], tiers: {}, max_top_grant: 1000, default_top_grant: 50,
    compact_at: 0, credit_requests: [], audience_requests: [], audiences: [], watchdogs: [],
    work_items_summary: { attention: 0, active: 0 },
    audit: { live_nodes: 0, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, org_inbox: null, net: null }
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } }))
  class Socket { readyState = 1; send() {} close() { this.readyState = 3 } }
  Object.assign(globals, { WebSocket: Socket, history: window.history, CustomEvent: window.CustomEvent,
    DocumentFragment: window.DocumentFragment })
  const identity = { windowId: 'keys-main', kind: 'org', org: tree.slug, notificationOwner: false }
  installBridge({ windowIdentity: identity, getWindowIdentity: async () => identity,
    requestOrg: async () => ({ action: 'focused', org: tree.slug }), getPreferences: async () => ({}) })
  globals.fetch = legacyAppBackend(async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (path.endsWith('/foreground-tree')) return json({ kind: 'compatibility' }, 409)
    if (path === '/api/orgs') return json([{ slug: tree.slug, name: tree.name, live: 0, seats: 0 }])
    if (path === '/api/orgs/' + tree.slug) return json(tree)
    if (path === '/api/providers') return json({ providers: [] })
    if (path === '/api/accounts') return json({ accounts: [] })
    if (path.endsWith('/inbox')) return json({ pending: [], delivered: [], sent: [] })
    if (path.endsWith('/documents')) return json({ documents: [], total: 0 })
    if (/\/work-items(?:-view)?$/.test(path)) return json({ items: [], archived: [], backlogged: [],
      counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } })
    if (path.endsWith('/usage/history')) return json({ series: [] })
    if (path.endsWith('/usage')) return json({ available: false, windows: [] })
    return json({})
  })
  localStorage.clear(); forgetAttentionMode(); forgetModalPins(); forgetModalOpenCache()
  window.history.replaceState(null, '', '/o/' + tree.slug)
  let view: Awaited<ReturnType<typeof mountView>> | undefined
  try {
    view = await mountView(<App />, el => el)
    await inAct(() => flush(60))
    const labels = [...view.el.querySelectorAll('.shell-header-actions > button')].map(el => el.getAttribute('aria-label'))
    assert.deepEqual(labels, ['Inbox', 'Work', 'Presentations', 'Org settings'], 'same names and targets, requested order')
    const editor = document.createElement('textarea'); document.body.append(editor)
    const routes = [['F1', '.acct-panel'], ['F2', '.usage-modal'], ['F3', '.usage-history-modal'],
      ['F6', '.settings.wide'], ['F7', '.docket-modal'], ['F8', '.gallery-modal'], ['F9', '.settings']] as const
    for (const [key, selector] of routes) {
      await inAct(async () => { press(key, editor); await flush(20) })
      assert.ok(view.el.querySelector(selector), `${key} opens its panel while a composer is focused`)
      await inAct(async () => { press('F4'); await flush(20) })
      assert.equal(orgView(tree.slug), 'canvas', `${key} panel returns to Canvas`)
      assert.equal(view.el.querySelector('.overlay:not(.overlay-pinned):not(.overlay-detached)'), null)
    }
    await inAct(() => press('F4'))
    assert.equal(orgView(tree.slug), 'attention')
    await inAct(() => press('F4'))
    assert.equal(orgView(tree.slug), 'canvas')
    editor.remove()
  } finally {
    await view?.unmount(); removeBridge(); localStorage.clear(); forgetAttentionMode(); forgetModalPins(); forgetModalOpenCache()
    Object.assign(globals, saved); window.history.replaceState(null, '', '/')
  }
})
