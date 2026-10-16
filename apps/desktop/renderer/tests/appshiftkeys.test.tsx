import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import App from '../src/App'
import { OrgtreeMenu } from '../src/shell/menu'
import type { OrgtreeMenuActions } from '../src/shell/menu'
import { APP_FKEYS, installAppShortcuts, matchAppShortcut } from '../src/shell/appshortcuts'
import { installBridge, removeBridge } from './shellbridge'
import { legacyAppBackend } from './appfeed-fixture'
import { forgetAttentionMode } from '../src/attention/mode'
import { addPin, forgetPins } from '../src/canvas/pins'
import { forgetModalPins, forgetModalOpenCache } from '../src/canvas/modalpin'
import { pinSurfaceKey, removePinSurface, updatePinSurface } from '../src/canvas/pinspace'
import { resetCanvasSessionForTests } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import { startEpicSync } from '../src/epic/sync'

const press = (key: string, target: EventTarget = document.body, shiftKey = false) => {
  const event = new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}
const orgs = (count: number) => Array.from({ length: count }, (_, i) => ({
  slug: 'org-' + i, name: 'Organization ' + i, nodes: 0, live: 0, created: null,
}))

test('Shift+F1/F2/F3 rows are shared by matcher and Settings, with exact app-menu actions', () => {
  for (const [key, id] of [['F1', 'newWindow'], ['F2', 'openOrganizations'], ['F3', 'createWindow']]) {
    const row = APP_FKEYS.find(row => row.keys.includes('Shift+' + key))
    assert.equal(row?.id, id)
    assert.ok(row?.action)
    assert.equal(matchAppShortcut(new window.KeyboardEvent('keydown', { key, shiftKey: true })), id)
    assert.equal(matchAppShortcut(new window.KeyboardEvent('keydown', { key, shiftKey: true, ctrlKey: true })), undefined)
  }
  assert.equal(matchAppShortcut(new window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true })), 'halt')
})

test('Shift+F6/F7/F8 rows share their canvas actions with the matcher and Settings', () => {
  for (const [key, id] of [['F6', 'fitOrg'], ['F7', 'lastDesk'], ['F8', 'switchboard']]) {
    const row = APP_FKEYS.find(row => row.keys.includes('Shift+' + key))
    assert.equal(row?.id, id)
    assert.ok(row?.action)
    assert.equal(matchAppShortcut(new window.KeyboardEvent('keydown', { key, shiftKey: true })), id)
    assert.equal(matchAppShortcut(new window.KeyboardEvent('keydown', { key, shiftKey: true, ctrlKey: true })), undefined)
  }
})

for (const count of [2, 7]) test(`Shift+F2 toggles the organization submenu (${count} organizations)`, async () => {
  const ref = React.createRef<OrgtreeMenuActions>()
  const opened: string[] = []
  const view = await mountView(<OrgtreeMenu orgs={orgs(count)} freshness="current" ageMs={0}
    error={null} currentOrg={null} shortcutRef={ref} onOpenOrg={slug => opened.push(slug)}
    onNewWindow={() => {}} onCreateOrg={() => {}} onUsage={() => {}} onAppSettings={() => {}} />, el => el)
  const stop = installAppShortcuts(window, () => ({ openOrganizations: () => ref.current?.openOrganizations() }))
  const editor = document.createElement('textarea'); document.body.append(editor)
  try {
    await inAct(async () => { press('F2', editor, true); await flush(6) })
    assert.ok(view.el.querySelector('.shell-menu-panel'))
    const submenu = view.el.querySelector<HTMLElement>('[role="menu"][aria-label="Organizations"]')!
    assert.ok(submenu, 'already expanded on the first shortcut')
    const first = submenu.querySelector<HTMLButtonElement>('.shell-menu-org')!
    const focus = count > 6 ? submenu.querySelector<HTMLInputElement>('.shell-menu-filter')! : first
    assert.equal(document.activeElement, focus)
    await inAct(() => editor.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'F2', shiftKey: true, repeat: true, bubbles: true, cancelable: true,
    })))
    assert.equal(view.el.querySelector('[role="menu"][aria-label="Organizations"]'), submenu,
      'holding Shift+F2 does not close or remount the submenu')
    editor.focus()
    await inAct(async () => { press('F2', editor, true); await flush(6) })
    assert.equal(view.el.querySelector('.shell-menu-panel') === null, true, 'same combo closes the menu and submenu')
    assert.equal(document.activeElement, view.el.querySelector('.shell-menu-button'), 'normal close returns focus')
    await inAct(async () => { press('F2', editor, true); await flush(6) })
    const reopened = view.el.querySelector<HTMLElement>('[role="menu"][aria-label="Organizations"]')!
    const reopenedFirst = reopened.querySelector<HTMLButtonElement>('.shell-menu-org')!
    const reopenedFocus = count > 6 ? reopened.querySelector<HTMLInputElement>('.shell-menu-filter')! : reopenedFirst
    assert.equal(document.activeElement, reopenedFocus)
    if (count > 6) {
      await inAct(() => press('ArrowDown', reopenedFocus))
      assert.equal(document.activeElement, reopenedFirst, 'arrows leave the filter for the organizations')
    }
    await inAct(() => press('Escape', reopenedFirst))
    assert.equal(view.el.querySelector('[aria-label="Organizations"][role="menu"]') === null, true)
    assert.ok(view.el.querySelector('.shell-menu-panel'), 'first Escape closes only the submenu')
    await inAct(() => press('Escape', document.activeElement!))
    assert.equal(view.el.querySelector('.shell-menu-panel') === null, true)
    assert.equal(document.activeElement, view.el.querySelector('.shell-menu-button'))
    await inAct(() => view.el.querySelector<HTMLButtonElement>('.shell-menu-button')!.click())
    await inAct(async () => { press('F2', editor, true); await flush(6) })
    assert.ok(view.el.querySelector('[role="menu"][aria-label="Organizations"]'),
      'an open parent menu without the target submenu expands it')
    await inAct(() => view.el.querySelector<HTMLButtonElement>('.shell-menu-org')!.click())
    assert.deepEqual(opened, ['org-0'], 'selection uses the existing org-opening callback')
    assert.equal(view.el.querySelector('.shell-menu-panel') === null, true)
  } finally { stop(); editor.remove(); await view.unmount(); assert.equal(ref.current, null) }
})

test('real main App Shift+F1/F3 reuse native window actions; Shift+F2 opens its live org submenu', async () => {
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, WebSocket: globals.WebSocket, history: globals.history,
    CustomEvent: globals.CustomEvent, DocumentFragment: globals.DocumentFragment }
  const calls: string[] = []
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body),
    { status: 200, headers: { 'Content-Type': 'application/json' } }))
  class Socket { readyState = 1; send() {} close() { this.readyState = 3 } }
  Object.assign(globals, { WebSocket: Socket, history: window.history, CustomEvent: window.CustomEvent,
    DocumentFragment: window.DocumentFragment })
  const identity = { windowId: 'shift-home', kind: 'homepage', notificationOwner: false }
  installBridge({ windowIdentity: identity, getWindowIdentity: async () => identity,
    openHomepageWindow: async () => { calls.push('new-window') },
    openCreateOrgWindow: async () => { calls.push('create-window') },
    requestOrg: async (org: string) => { calls.push('org:' + org); return { action: 'focused', org } },
    getPreferences: async () => ({}) })
  globals.fetch = legacyAppBackend(async input => {
    const path = new URL(String(input), window.location.origin).pathname
    if (path === '/api/orgs') return json(orgs(2))
    if (path === '/api/providers') return json({ providers: [] })
    return json({})
  })
  localStorage.clear(); window.history.replaceState(null, '', '/')
  let view: Awaited<ReturnType<typeof mountView>> | undefined
  const editor = document.createElement('textarea'); document.body.append(editor)
  try {
    view = await mountView(<App />, el => el)
    await inAct(() => flush(50))
    await inAct(async () => { press('F1', editor, true); press('F3', editor, true); await flush(6) })
    assert.deepEqual(calls, ['new-window', 'create-window'])
    await inAct(async () => { press('F2', editor, true); await flush(6) })
    const first = view.el.querySelector<HTMLButtonElement>('[role="menu"][aria-label="Organizations"] .shell-menu-org')!
    assert.ok(first)
    assert.equal(document.activeElement, first)
    await inAct(async () => { first.click(); await flush(6) })
    assert.deepEqual(calls, ['new-window', 'create-window', 'org:org-0'])
  } finally {
    await view?.unmount(); editor.remove(); removeBridge(); localStorage.clear()
    Object.assign(globals, saved); window.history.replaceState(null, '', '/')
  }
})

test('real main App Shift+F6/F8 work with pinned panels, a focused desk and EPIC Mode', async () => {
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, WebSocket: globals.WebSocket, history: globals.history,
    CustomEvent: globals.CustomEvent, DocumentFragment: globals.DocumentFragment }
  const slug = 'shift-shortcut-org'
  const root = { id: 'ceo', title: 'ceo', tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' } }
  const tree = { slug, name: slug, workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null, default_visibility: 'team', default_effort: '',
    credit_requests: [], tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [], roots: [root],
    cost_usd_total: 0, audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true,
    audience_requests: [], org_inbox: null, net: null,
    asks: [], asks_open: 0, epoch: 1, rev: 1, watchdogs: [], work_items_summary: { attention: 0, active: 0 } }
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } }))
  class Socket { readyState = 1; send() {} close() { this.readyState = 3 } }
  Object.assign(globals, { WebSocket: Socket, history: window.history, CustomEvent: window.CustomEvent,
    DocumentFragment: window.DocumentFragment })
  const identity = { windowId: 'shift-org-main', kind: 'org', org: slug, notificationOwner: false }
  installBridge({ windowIdentity: identity, getWindowIdentity: async () => identity,
    getPreferences: async () => ({ epicMode: true }) })
  globals.fetch = legacyAppBackend(async input => {
    const path = new URL(String(input), window.location.origin).pathname
    if (path.endsWith('/foreground-tree')) return json({ kind: 'compatibility' }, 409)
    if (path === '/api/orgs') return json([{ slug, name: slug, live: 1, seats: 1 }])
    if (path === '/api/orgs/' + slug) return json(tree)
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
  localStorage.clear(); forgetAttentionMode(); forgetModalPins(); forgetModalOpenCache(); resetCanvasSessionForTests()
  window.history.replaceState(null, '', '/o/' + slug)
  const proto = window.HTMLElement.prototype
  const originalRect = proto.getBoundingClientRect
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList?.contains('viewport'))
      return { x: 0, y: 0, left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800, toJSON() {} } as DOMRect
    return originalRect.call(this)
  }
  let view: Awaited<ReturnType<typeof mountView>> | undefined
  const stopEpic = startEpicSync()
  const usageSurface = pinSurfaceKey(slug, 'usage', true)
  const modelessPinnedUsage = document.createElement('div')
  modelessPinnedUsage.className = 'settings modalpin-win'
  modelessPinnedUsage.setAttribute('role', 'dialog')
  modelessPinnedUsage.setAttribute('aria-label', 'Usage')
  assert.equal(modelessPinnedUsage.getAttribute('aria-modal'), null)
  try {
    useFakeClock()
    view = await mountView(<App />, el => el)
    await inAct(async () => { await flush(60); await advance(2500) })
    let pinResult: ReturnType<typeof addPin> | undefined
    await inAct(() => { pinResult = addPin(slug, 'ceo', { x: 820, y: 30, w: 420, h: 420 }) })
    assert.equal(pinResult?.ok, true,
      'the real org canvas accepts a pinned agent desk')
    await inAct(() => updatePinSurface(usageSurface, slug, { x: 0, y: 0, w: 400, h: 300 }, true))
    document.body.append(modelessPinnedUsage)
    await inAct(async () => { await flush(20); await advance(700) })
    const composer = view.el.querySelector<HTMLTextAreaElement>('.pinwin textarea')
    assert.ok(composer, 'the pinned agent desk is open')
    await inAct(() => composer!.focus())
    assert.equal(document.activeElement, composer, 'focus is inside the pinned agent desk composer')
    assert.ok(document.querySelector('.epic-stage'), 'EPIC Mode is on in the real renderer')
    const space = () => view!.el.querySelector<HTMLElement>('.space')!
    const camera = () => space().style.transform
    const zoomIn = view.el.querySelector<HTMLButtonElement>('.zoomhud button[title="zoom in"]')!
    assert.ok(zoomIn, 'the full App mounted the real canvas zoom control')
    await inAct(async () => { zoomIn.click(); await flush(10); await advance(500); zoomIn.click(); await flush(10); await advance(500) })
    const zoomedAway = camera()
    const beforeFit = zoomedAway
    await inAct(async () => { press('F6', composer!, true); await flush(20); await advance(800) })
    assert.notEqual(camera(), beforeFit, 'Shift+F6 fits the camera while pinned panels are open and the composer has focus')
    const beforeSwitchboard = camera()
    await inAct(async () => { press('F8', composer!, true); await flush(20); await advance(1600) })
    assert.ok(view.el.querySelector('.eye-desk'), 'the real App callback focused the switchboard')
    assert.notEqual(camera(), beforeSwitchboard, 'Shift+F8 returns the real org canvas to the switchboard under EPIC Mode')
  } finally {
    await view?.unmount(); stopEpic(); removeBridge(); modelessPinnedUsage.remove()
    await inAct(() => removePinSurface(usageSurface))
    localStorage.clear(); forgetAttentionMode(); forgetModalPins(); forgetModalOpenCache()
    forgetPins(slug); resetConvos(); resetCanvasSessionForTests(); realClock()
    proto.getBoundingClientRect = originalRect
    Object.assign(globals, saved); window.history.replaceState(null, '', '/')
  }
})
