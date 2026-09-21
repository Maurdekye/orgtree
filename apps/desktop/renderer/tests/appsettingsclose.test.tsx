// The App settings modal has no footer `close` button any more (user, 2026-09-18).
//
// ⚠ READ THIS BEFORE YOU "RESTORE" ANYTHING. The ticket that removed the button
// justified it as redundant because "the modal frame already carries its own
// close control". THAT IS NOT TRUE OF THIS SURFACE, and §4 below pins the fact
// down so the next reader does not have to re-derive it:
//
//   modalpin.tsx  const scope = ['defaults','app-settings','advanced-org']
//                   .includes(props.kind) ? null : org
//
// `app-settings` therefore always reaches PinFrameInner with orgScope=null and
// pinnable=false, so `pinned` is permanently false, so the frame's X — which is
// written `{pinned && (…)}` — never renders here, and neither does the pin
// button nor the popout button. The title bar is an empty spacer.
//
// What actually dismisses this modal is Escape, a backdrop click, and the title
// bar's right-click menu. All three are driven below through the real rendered
// controls, because "the setting exists" is not evidence that anything honours
// it — and every one of these assertions is what stops a later refactor of
// PinFrame leaving App settings with no way out at all.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'
import { CurrentOrg } from '../src/popout'

const W = window as unknown as Window & typeof globalThis

const account = (id: string, provider = 'claude') => ({
  id, provider, label: id, credential: { kind: 'managed', path: 'C:/fixture/' + id },
  identity: { email: id + '@example.test' }, auth: 'authenticated', tint_ordinal: 1,
  standing: { auth: 'authenticated', state: 'ready', marks: {} }, bound: [],
})

/** the OpenRouter document with a key already set — the only state that draws
 *  the favorites row, which is the one control that opens the model picker */
const ORDOC = {
  installed: true, connected: true, key_set: true, kind: 'api-key',
  label: 'sk-or-v1-abc…xyz',
  credits: { limit: null, limit_remaining: null, usage: 0, usage_daily: 0,
    usage_weekly: 0, usage_monthly: 0, is_free_tier: false, checked_at: null },
  reason: null, favorites: 0, favorites_max: 0, tiers: [], user_enabled: true,
}

async function setup(t: TestContext, org: string | null = null) {
  const oldFetch = globalThis.fetch
  const state = { closed: 0 }
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    let body: unknown = {}
    if (path === '/api/accounts') body = { accounts: [account('existing-claude')] }
    else if (path === '/api/providers') body = { providers: ['claude', 'openrouter'].map((id) => ({
      id, label: id === 'claude' ? 'Claude' : 'OpenRouter', cli: id,
      status: { installed: true, connected: true }, tiers: [], hire_enabled: true,
      user_enabled: true,
    })) }
    else if (path === '/api/openrouter') body = ORDOC
    else if (path === '/api/openrouter/models') body = { query: '', offset: 0, limit: 8, total: 0, items: [] }
    else if (path.endsWith('/identity')) body = { auth: 'authenticated' }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const desk = window as unknown as { orgtreeDesktop?: unknown }
  desk.orgtreeDesktop = { getProviderLoginStatus: async () => ({ phase: 'idle' }),
    getPreferences: async () => ({}), onEvent: () => () => {} }
  const panel = <AccountsPanel toast={() => {}} close={() => { state.closed++ }} />
  const view = await mountView(
    org === null ? panel : <CurrentOrg.Provider value={org}>{panel}</CurrentOrg.Provider>,
    el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch; delete desk.orgtreeDesktop })
  await inAct(async () => { await flush(10) })
  return { view, state }
}

const overlay = () => document.querySelector<HTMLElement>('.overlay')!
const bar = () => document.querySelector<HTMLElement>('.modalpin-bar')!
const dialog = () => document.querySelector<HTMLElement>('.add-account-dialog')
const byText = (root: ParentNode, label: string) =>
  [...root.querySelectorAll('button')].find(b => b.textContent === label)
const lane = (provider: string) =>
  document.querySelector('.prov-' + provider)!.closest('.acct-provider-group')!

/** every button in the modal whose visible label is exactly `close` — the
 *  button this ticket removed, found the way a user finds it: by its text. */
const footerCloses = () => [...document.querySelectorAll('button')]
  .filter(b => (b.textContent ?? '').trim() === 'close')

async function esc() {
  await inAct(async () => {
    W.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flush(3)
  })
}

const menuItem = (label: string) => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .find(b => b.textContent === label) as HTMLButtonElement | undefined

// --------------------------------------------------------------------------

test('§1 no footer close button renders under ANY App settings tab', async (t) => {
  const { view, state } = await setup(t)
  const tabs = [...view.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  // v3 added General (the startup choice and About) and Default org settings,
  // the latter absorbing the standalone window the removed sidebar opened.
  assert.equal(tabs.length, 7, 'every App settings tab renders')
  for (const tab of tabs) {
    await inAct(async () => { tab.click(); await flush(6) })
    assert.deepEqual(footerCloses().map(b => b.className), [],
      `the "${tab.textContent}" tab draws no close button of its own`)
  }
  // ⚠ THE DEFAULT-ORG-SETTINGS TAB IS THE ONE WITH FOOTER BUTTONS, and they
  // are not the control this ticket removed. Those fields are a BUFFERED form
  // — unlike every other tab, which writes on the switch — so it keeps the
  // save/cancel pair it has always had in its standalone window. What it must
  // not grow is a second way to dismiss the modal that reads as a close.
  const defaults = tabs.find(t => t.textContent?.includes('Default org settings'))!
  await inAct(async () => { defaults.click(); await flush(6) })
  const panel = document.querySelector('#app-settings-panel-defaults')!
  assert.deepEqual([...panel.querySelectorAll('.row button')].map(b => b.textContent),
    ['save', 'cancel'], 'the form’s own two controls, and no third')
  assert.equal(state.closed, 0, 'nothing dismissed the modal while tabbing through it')
})

test('§2 Escape dismisses the modal', async (t) => {
  const { state } = await setup(t)
  await esc()
  assert.equal(state.closed, 1, 'Escape called the panel\u2019s own close')
})

test('§3 a backdrop click dismisses the modal, and a click inside it does not', async (t) => {
  const { view, state } = await setup(t)
  await inAct(async () => { view.el.querySelector('h3')!.dispatchEvent(
    new W.MouseEvent('click', { bubbles: true, cancelable: true })); await flush(2) })
  assert.equal(state.closed, 0, 'a click on the panel is not a backdrop click')
  await inAct(async () => { overlay().dispatchEvent(
    new W.MouseEvent('click', { bubbles: true, cancelable: true })); await flush(2) })
  assert.equal(state.closed, 1, 'a click on the backdrop dismissed it')
})

test('§4 the frame draws NO close control of its own here, and the title bar\u2019s '
  + 'right-click menu is the only pointer route left', async (t) => {
  const { state } = await setup(t)
  // the premise this ticket was written on, nailed down as an assertion
  assert.equal(document.querySelector('[aria-label="close this window"]'), null,
    'app-settings is never pinnable, so PinFrame\u2019s X never renders for it')
  assert.equal(bar().querySelector('button'), null,
    'and its title bar carries no buttons at all')
  await inAct(async () => {
    bar().dispatchEvent(new W.MouseEvent('contextmenu',
      { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 }))
    await flush(3)
  })
  const close = menuItem('Close')
  assert.ok(close, 'the title bar\u2019s menu offers Close')
  await inAct(async () => { close!.click(); await flush(3) })
  assert.equal(state.closed, 1, 'and Close ran the panel\u2019s own dismiss')
})

test('§7 …and still draws none WITH AN ORG OPEN, which is the state the '
  + 'never-pinnable guard actually decides', async (t) => {
  // ⚠ §4 alone does not prove this. With no org in context `useCurrentOrg()`
  // is null, so PinFrame's scope is null whatever the kind-list says, and a
  // mutation that DELETED 'app-settings' from that list still passed §4. Open
  // an org and the list becomes the only thing holding the pin, popout and
  // close controls off this surface — which is what this section pins down.
  const { state } = await setup(t, 'mine')
  assert.equal(document.querySelector('[aria-label="close this window"]'), null,
    'no close control even with an org open')
  assert.equal(bar().querySelector('button'), null,
    'no pin button and no popout button either — the bar stays empty')
  assert.equal(footerCloses().map(b => b.className).length, 0,
    'and no footer close button came back')
  assert.equal(state.closed, 0, 'nothing dismissed the modal')
})

test('§5 the add-account dialog swallows the first Escape; the second closes settings',
  async (t) => {
  const { state } = await setup(t)
  await inAct(async () => { byText(lane('claude'), 'Add secondary account')!.click(); await flush(6) })
  assert.ok(dialog(), 'the add-account dialog is open')
  await esc()
  assert.equal(dialog(), null, 'the first Escape closed the dialog')
  assert.equal(state.closed, 0, 'and did NOT close App settings behind it')
  await esc()
  assert.equal(state.closed, 1, 'the next Escape closes App settings')
})

test('§6 the OpenRouter model picker swallows the first Escape; the second closes settings',
  async (t) => {
  const { view, state } = await setup(t)
  const favs = view.el.querySelector<HTMLButtonElement>('.orr-favs')
  assert.ok(favs, 'the favorites row renders once a key is set')
  await inAct(async () => { favs!.click(); await flush(10) })
  assert.equal(favs!.getAttribute('aria-expanded'), 'true', 'the picker is open')
  await esc()
  assert.equal(favs!.getAttribute('aria-expanded'), 'false', 'the first Escape closed the picker')
  assert.equal(state.closed, 0, 'and did NOT close App settings behind it')
  await esc()
  assert.equal(state.closed, 1, 'the next Escape closes App settings')
})
