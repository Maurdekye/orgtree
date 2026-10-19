import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UserNode } from '../src/canvas/cards'
import type { NativeDesktop } from '../src/desktop'

const noop = () => {}
const bare = (button: Element) => button.textContent?.trim().replace(/\s*▸$/, '')
const top = () => [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu:not(.ctxmenu-submenu) > .ctxmenu-branch > [role="menuitem"]')]
const named = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => bare(b) === label)
async function key(button: Element, value: string) {
  await inAct(async () => { button.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })); await flush(2) })
}

async function setup(t: import('node:test').TestContext, focused: boolean, routes = true) {
  const nativeWindow = window as Window & { orgtreeDesktop?: NativeDesktop }, previous = nativeWindow.orgtreeDesktop
  const oldFetch = globalThis.fetch, calls: unknown[][] = []
  nativeWindow.orgtreeDesktop = routes ? {
    scratchFolderScopes: ['shared'],
    openAgentScratchFolder: async (...args: unknown[]) => { calls.push(['folder', ...args]); return { ok: true } },
    agentScratchAgentsFileExists: async () => ({ ok: true, exists: true }),
    openAgentScratchAgentsFile: async (...args: unknown[]) => { calls.push(['edit', ...args]); return { ok: true } },
  } as unknown as NativeDesktop : undefined
  globalThis.fetch = async input => new Response(JSON.stringify(String(input).includes('/orgmd') ? { content: '# Fixture' } : {}), { headers: { 'content-type': 'application/json' } })
  const view = await mountView(<UserNode pos={{ x: 0, y: 0 }} isDrop={false}
    stats={{ circ: 0, seats: 0, free: 0 }} pip={null} seats={{ haiku: 1 }}
    pxc={1} zoom={1} onSpawn={noop} onMailLink={noop} onWorkLink={noop}
    focused={focused} eyeW={focused ? 900 : 124} posX={() => 0}
    map={new Map()} op={async () => ({} as never)} slug="fixture" toast={noop}
    onFocus={noop} onNewProject={noop} onAgents={noop} onGear={noop}
    onInbox={routes ? reveal => calls.push(['inbox', reveal]) : undefined}
    onDocket={routes ? reveal => calls.push(['docket', reveal]) : undefined}
    onPresentations={routes ? reveal => calls.push(['presentations', reveal]) : undefined} />, el => el)
  t.after(async () => { await view.unmount(); nativeWindow.orgtreeDesktop = previous; globalThis.fetch = oldFetch })
  const open = async () => {
    const surface = view.el.querySelector(focused ? '.eye-head' : '.sq.user')
    assert.ok(surface, 'the real switchboard surface mounted')
    await inAct(async () => { surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })); await flush(4) })
  }
  await open()
  return { calls, open }
}

for (const focused of [false, true]) {
  const surface = focused ? 'focused header' : 'overview'
  test(`switchboard ${surface} groups Open routes while retaining top-level actions`, async t => {
    const { calls, open } = await setup(t, focused)
    assert.ok(named('Open'), 'the Open submenu exists')
    assert.deepEqual(top().map(bare), ['Focus', 'Hire an agent', 'New project…', 'Open', 'Agents list', 'Org settings', 'Compact all agents…', 'Halt all agents…', 'Retire all agents…'])
    assert.equal(named('Open')!.getAttribute('aria-haspopup'), 'menu')
    await inAct(async () => { named('Open')!.click(); await flush(2) })
    const submenu = document.querySelector('.ctxmenu-submenu[aria-label="Open"]')
    assert.ok(submenu)
    assert.deepEqual([...submenu.querySelectorAll(':scope > .ctxmenu-branch > [role="menuitem"]')].map(bare), ['Inbox', 'Global docket', 'Presentations', 'Shared scratch folder'])
    assert.deepEqual(calls, [], 'opening a branch performs no action')
    for (const [label, action] of [['Inbox', 'inbox'], ['Global docket', 'docket'], ['Presentations', 'presentations']]) {
      await open()
      await inAct(async () => { named('Open')!.click(); await flush(2) })
      await inAct(async () => { named(label)!.click(); await flush(2) })
      assert.deepEqual(calls.at(-1), [action, true], 'the existing reveal callback is preserved')
      assert.equal(document.querySelector('.ctxmenu') === null, true, 'selection closes the whole menu')
    }
  })

  test(`switchboard ${surface} keeps shared scratch as a nested keyboard-accessible submenu`, async t => {
    const { calls, open } = await setup(t, focused)
    const parent = named('Open'); assert.ok(parent, 'the Open submenu exists')
    await key(parent, 'ArrowRight')
    assert.equal(bare(document.activeElement!), 'Inbox')
    const folder = named('Shared scratch folder'); assert.ok(folder)
    assert.equal(folder.getAttribute('aria-haspopup'), 'menu')
    await key(folder, 'ArrowRight')
    assert.equal(bare(document.activeElement!), 'Open folder')
    assert.deepEqual(calls, [])
    await inAct(async () => { named('Edit AGENTS.md')!.click(); await flush(2) })
    assert.deepEqual(calls, [['edit', 'fixture', '', 'shared']])
    await open(); await key(named('Open')!, 'ArrowRight'); await key(named('Shared scratch folder')!, 'ArrowRight')
    await inAct(async () => { named('Open folder')!.click(); await flush(2) })
    assert.deepEqual(calls.at(-1), ['folder', 'fixture', '', 'shared'])
  })
}

test('switchboard Open branch is omitted when no open routes are available', async t => {
  await setup(t, false, false)
  assert.ok(named('Agents list'), 'unrelated menu actions remain available')
  assert.equal(named('Open') === undefined, true)
})

test('hover opens the shared Open submenu without activating any route', async t => {
  const { calls } = await setup(t, false)
  const parent = named('Open'); assert.ok(parent, 'the Open submenu exists')
  await inAct(async () => { parent.parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await flush(2) })
  assert.equal(parent.getAttribute('aria-expanded'), 'true')
  assert.ok(named('Inbox'))
  assert.deepEqual(calls, [])
})
