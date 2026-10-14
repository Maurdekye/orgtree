import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import App from '../src/App'
import { OrgtreeMenu } from '../src/shell/menu'
import type { OrgtreeMenuActions } from '../src/shell/menu'
import { APP_FKEYS, installAppShortcuts, matchAppShortcut } from '../src/shell/appshortcuts'
import { installBridge, removeBridge } from './shellbridge'
import { legacyAppBackend } from './appfeed-fixture'

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
    assert.equal(view.el.querySelector('.shell-menu-panel'), null, 'same combo closes the menu and submenu')
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
    assert.equal(view.el.querySelector('[aria-label="Organizations"][role="menu"]'), null)
    assert.ok(view.el.querySelector('.shell-menu-panel'), 'first Escape closes only the submenu')
    await inAct(() => press('Escape', document.activeElement!))
    assert.equal(view.el.querySelector('.shell-menu-panel'), null)
    assert.equal(document.activeElement, view.el.querySelector('.shell-menu-button'))
    await inAct(() => view.el.querySelector<HTMLButtonElement>('.shell-menu-button')!.click())
    await inAct(async () => { press('F2', editor, true); await flush(6) })
    assert.ok(view.el.querySelector('[role="menu"][aria-label="Organizations"]'),
      'an open parent menu without the target submenu expands it')
    await inAct(() => view.el.querySelector<HTMLButtonElement>('.shell-menu-org')!.click())
    assert.deepEqual(opened, ['org-0'], 'selection uses the existing org-opening callback')
    assert.equal(view.el.querySelector('.shell-menu-panel'), null)
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
