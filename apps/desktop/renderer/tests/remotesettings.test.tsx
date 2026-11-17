// remotesettings.test.tsx: App settings in a window of an organization on a
// remote engine (docs/rust-engine/remote-org.md, "What depends on the
// computer"). The engine's settings shown there are the REMOTE engine's; the
// app's own (theme, startup, streaming, mail hub hosting) stay this
// computer's. The panel says which is which; a local window is unchanged.
//
// Run:  node tests/run.mjs remotesettings
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'
import { remoteFeed, remoteView } from './remotefeed.fixture'

const NOTE = 'These settings belong to Galaxy, the remote engine this organization runs on. '
  + 'Tabs and groups marked “This computer” belong to this app on this computer.'

async function settings(t: TestContext, remote: boolean) {
  const feed = remoteFeed(t, (url, init) => {
    const method = init?.method || 'GET'
    let body: unknown = {}
    if (url.endsWith('/providers')) body = { providers: [] }
    else if (url === '/api/accounts' && method === 'GET') body = { accounts: [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  const desk = window as unknown as { orgtreeDesktop?: unknown }
  desk.orgtreeDesktop = { getProviderLoginStatus: async () => ({ phase: 'idle' }), getPreferences: async () => ({}), onEvent: () => () => {} }
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} />, el => el)
  t.after(async () => { await view.unmount(); delete desk.orgtreeDesktop })
  await feed.remotes([remoteView()], remote ? remoteView() : undefined)
  await inAct(async () => { await flush() })
  const tabs = [...document.querySelectorAll<HTMLElement>('.app-settings-tab')]
  /** tab label -> its scope badge ('' when it has none) */
  const scopes = Object.fromEntries(tabs.map(tab => {
    const badge = tab.querySelector('.app-settings-scope')?.textContent ?? ''
    return [(tab.textContent ?? '').slice(0, (tab.textContent ?? '').length - badge.length), badge]
  }))
  /** the titles of a tab's groups, each with whether it sits under "This computer" */
  const groups = (tab: string) => Object.fromEntries([...document.querySelectorAll<HTMLElement>(`#app-settings-panel-${tab} .set-group-head`)]
    .map(head => [head.firstChild?.textContent ?? '', head.closest('.settings-here') !== null]))
  return { scopes, groups, note: () => document.querySelector<HTMLElement>('.settings-remote-note') }
}

test('a local window’s App settings carries no remote note and no "This computer" marks', async t => {
  const s = await settings(t, false)
  assert.equal(s.note(), null)
  assert.equal(document.querySelector('.settings-here'), null)
  assert.deepEqual(Object.values(s.scopes).filter(Boolean), [])
  assert.ok('Providers' in s.scopes && 'Display' in s.scopes && 'Mail hub' in s.scopes)
})

test('a remote window’s App settings says whose settings these are and marks what is this computer’s', async t => {
  const s = await settings(t, true)
  const note = s.note()
  assert.equal(note?.textContent, NOTE)
  assert.equal(note?.getAttribute('role'), 'note')
  // whole tabs that belong to this app on this computer
  assert.deepEqual(s.scopes, { Providers: '', Harnesses: '', Runtime: '', Display: '', Streaming: 'this computer',
    'Default org settings': '', 'Mail hub': 'this computer', Developer: '', Controls: 'this computer', About: 'this computer' })
  // Display: the look of this app is this computer's; the two typing rules are the engine's
  const display = s.groups('display')
  assert.equal(display.Text, false)
  assert.equal(display.Typing, false)
  assert.equal(display.Desk, true)
  assert.equal(display['Quick chat'], true)
  assert.equal(display.Startup, true)
  // Runtime: the engine's rules are the remote engine's
  const runtime = s.groups('runtime')
  assert.equal(runtime.Turns, false)
  assert.equal(runtime['Agent processes'], false)
  assert.equal(runtime['Orgtree feedback'], false)
  // each marked part is a named group (its group heads carry the badge, drawn by the style sheet)
  const marked = [...document.querySelectorAll<HTMLElement>('.settings-here')]
  assert.ok(marked.length >= 2)
  for (const part of marked) {
    assert.equal(part.getAttribute('role'), 'group')
    assert.equal(part.getAttribute('aria-label'), 'This computer')
    assert.ok(part.querySelector('.set-group-head'), 'a marked part holds at least one group')
  }
  assert.ok(document.querySelector('#app-settings-panel-runtime .settings-here'), 'startup and updates of this app are marked in Runtime')
})
