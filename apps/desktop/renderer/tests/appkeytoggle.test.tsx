import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import App from '../src/App'
import { APP_FKEYS } from '../src/shell/appshortcuts'
import { forgetAttentionMode } from '../src/attention/mode'
import { forgetModalOpenCache, forgetModalPins, pinModal, raisePinnedModal } from '../src/canvas/modalpin'
import { legacyAppBackend } from './appfeed-fixture'
import { installBridge, removeBridge } from './shellbridge'
import { TREE_MIN_GAP_MS } from '../src/treepace'

const routes = [
  ['F1', '.acct-panel', 'app-settings'],
  ['F2', '.usage-modal', 'usage'],
  ['F3', '.usage-history-modal', 'usage-history'],
  ['F6', '.settings.wide', 'inbox'],
  ['F7', '.docket-modal', 'docket'],
  ['F8', '.gallery-modal', 'gallery'],
  ['F9', '.settings:not(.wide):not(.acct-panel)', 'org-settings'],
] as const
const press = (key: string, target: EventTarget, extra: KeyboardEventInit = {}) => {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
  target.dispatchEvent(event)
  return event
}

async function withApp(run: (el: HTMLElement, editor: HTMLTextAreaElement, reads: string[]) => Promise<void>) {
  useFakeClock()
  const hidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, WebSocket: globals.WebSocket, history: globals.history,
    CustomEvent: globals.CustomEvent, DocumentFragment: globals.DocumentFragment }
  const tree = { slug: 'toggle-org', name: 'Toggle org', roots: [], asks: [], asks_open: 0,
    epoch: 1, rev: 1, dirs: [], tiers: {}, max_top_grant: 1000, default_top_grant: 50,
    compact_at: 0, credit_requests: [], audience_requests: [], audiences: [], watchdogs: [],
    work_items_summary: { attention: 0, active: 0 },
    audit: { live_nodes: 0, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, org_inbox: null, net: null }
  const reads: string[] = []
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } }))
  class Socket { readyState = 1; send() {} close() { this.readyState = 3 } }
  Object.assign(globals, { WebSocket: Socket, history: window.history, CustomEvent: window.CustomEvent,
    DocumentFragment: window.DocumentFragment })
  const identity = { windowId: 'toggle-main', kind: 'org', org: tree.slug, notificationOwner: false }
  installBridge({ windowIdentity: identity, getWindowIdentity: async () => identity,
    requestOrg: async () => ({ action: 'focused', org: tree.slug }), getPreferences: async () => ({}) })
  globals.fetch = legacyAppBackend(async input => {
    const path = new URL(String(input), window.location.origin).pathname
    reads.push(path)
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
  const editor = document.createElement('textarea'); document.body.append(editor)
  let view: Awaited<ReturnType<typeof mountView>> | undefined
  try {
    view = await mountView(<App />, el => el)
    await inAct(() => flush(60))
    await run(view.el, editor, reads)
  } finally {
    await view?.unmount(); editor.remove(); removeBridge(); localStorage.clear()
    forgetAttentionMode(); forgetModalPins(); forgetModalOpenCache()
    Object.assign(globals, saved); window.history.replaceState(null, '', '/')
    if (hidden) Object.defineProperty(document, 'hidden', hidden)
    else delete (document as unknown as { hidden?: boolean }).hidden
    realClock()
  }
}

for (const [key, selector] of routes) test(`${key} opens, ignores held repeat, closes and returns focus, then reopens`, async () => {
  await withApp(async (el, editor, reads) => {
    editor.focus()
    await inAct(async () => { press(key, editor); await flush(20) })
    const panel = el.querySelector<HTMLElement>(selector)!
    assert.ok(panel, `${key} opened its exact panel`)
    await inAct(async () => { press(key, editor, { repeat: true }); await flush(6) })
    assert.equal(el.querySelector(selector), panel, 'holding keeps the mounted panel')
    panel.querySelector<HTMLElement>('input, textarea, button')?.focus()
    // Drain any opening selection read before measuring the close callback.
    // A normal close requests a paced read rather than bypassing its gap.
    if (key === 'F6' || key === 'F9') await advance(TREE_MIN_GAP_MS)
    const before = reads.filter(path => path === '/api/orgs/toggle-org').length
    await inAct(async () => { press(key, document.activeElement!); await flush(20) })
    assert.equal(el.querySelector(selector), null, `${key} second press closes its target`)
    assert.equal(document.activeElement, editor, 'focus returns to the connected shortcut opener')
    if (key === 'F6' || key === 'F9') {
      await advance(TREE_MIN_GAP_MS)
      assert.ok(reads.filter(path => path === '/api/orgs/toggle-org').length > before,
        'normal inbox/settings close refreshes the tree')
    }
    await inAct(async () => { press(key, editor); await flush(20) })
    assert.ok(el.querySelector(selector), 'fresh press reopens')
  })
})

test('different panel shortcuts stack as before and close only the associated target', async () => {
  await withApp(async (el, editor) => {
    editor.focus()
    await inAct(async () => { press('F2', editor); await flush(20) })
    await inAct(async () => { press('F3', editor); await flush(20) })
    assert.ok(el.querySelector('.usage-modal'))
    const history = el.querySelector('.usage-history-modal')
    assert.ok(history, 'different target stacks rather than replacing Usage')
    await inAct(async () => { press('F2', editor); await flush(20) })
    assert.equal(el.querySelector('.usage-modal'), null)
    assert.equal(el.querySelector('.usage-history-modal'), history, 'other target remains mounted')
  })
})

test('keyboard closes a pinned target behind a sibling while mouse still raises it', async () => {
  await withApp(async (el, editor) => {
    await inAct(() => {
      pinModal('usage', { x: 10, y: 10, w: 700, h: 600 }, 'toggle-org')
      pinModal('usage-history', { x: 30, y: 30, w: 700, h: 600 }, 'toggle-org')
    })
    await inAct(async () => { press('F2', editor); await flush(20) })
    await inAct(async () => { press('F3', editor); await flush(20) })
    await inAct(() => raisePinnedModal('usage-history', 'toggle-org'))
    const usage = el.querySelector('.usage-modal')
    assert.ok(usage)
    const menuButton = el.querySelector<HTMLButtonElement>('.shell-menu-button')!
    await inAct(() => menuButton.click())
    const item = [...el.querySelectorAll<HTMLButtonElement>('.shell-menu-item')]
      .find(button => button.querySelector('.shell-menu-label')?.textContent === 'Usage…')!
    await inAct(async () => { item.click(); await flush(6) })
    assert.equal(el.querySelector('.usage-modal'), usage, 'mouse raises rather than dismissing a hidden pin')
    await inAct(() => raisePinnedModal('usage-history', 'toggle-org'))
    await inAct(async () => { press('F2', editor); await flush(20) })
    assert.equal(el.querySelector('.usage-modal'), null, 'keyboard closes even when behind')
    assert.ok(el.querySelector('.usage-history-modal'))
  })
})

test('Settings shared table describes every affected shortcut as a toggle', () => {
  for (const key of [...routes.map(([key]) => key), 'Shift+F2'])
    assert.match(APP_FKEYS.find(row => row.keys.includes(key))!.action, /^Toggle /)
  assert.match(APP_FKEYS.find(row => row.id === 'newWindow')!.action, /^Open /)
  assert.match(APP_FKEYS.find(row => row.id === 'createWindow')!.action, /^Open /)
})
