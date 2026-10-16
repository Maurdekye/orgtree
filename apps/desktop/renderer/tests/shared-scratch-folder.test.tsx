import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SettingsPanel } from '../src/App'
import { UserNode } from '../src/canvas/cards'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import type { AgentMenuHandlers } from '../src/canvas/agentmenu'
import { scratchFolderAction } from '../src/scratch-folder'
import type { CanvasNode } from '../src/canvas/shared'
import type { NativeDesktop } from '../src/desktop'
import type { ToastFn, TreePayload } from '../src/types'

type Scope = 'team' | 'shared'
// Existing builds accept three arguments and ignore this future fourth one;
// the base therefore fails on missing behavior, never a missing import.
const action = scratchFolderAction as (org: string, node: string, toast: ToastFn,
  scope?: Scope) => (() => void) | undefined
const nativeWindow = window as Window & { orgtreeDesktop?: NativeDesktop }
const noop = () => {}

function installNative(t: import('node:test').TestContext, scoped = true) {
  const original = nativeWindow.orgtreeDesktop
  const calls: unknown[][] = [], toasts: string[][] = []
  nativeWindow.orgtreeDesktop = {
    ...(scoped ? { scratchFolderScopes: ['team', 'shared'] } : {}),
    openAgentScratchFolder: async (...args: unknown[]) => { calls.push(args); return { ok: true } },
  } as unknown as NativeDesktop
  t.after(() => { nativeWindow.orgtreeDesktop = original })
  const toast: ToastFn = lines => { if (lines?.length) toasts.push(lines) }
  return { calls, toast, toasts }
}

const tree = { slug: 'fixture', name: 'Fixture', nodes: [], edges: [],
  net: { hubs: [] } } as unknown as TreePayload

function installFetch(t: import('node:test').TestContext) {
  const original = globalThis.fetch
  globalThis.fetch = async input => {
    const url = String(input)
    const body = url.includes('/orgmd') ? { content: '# Fixture' }
      : url.includes('/accounts') ? { accounts: [] } : {}
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = original })
}

test('agent Open menu places Team scratch next to personal scratch and passes scoped identity for live/archived leaves', async t => {
  const { calls, toast } = installNative(t)
  for (const state of ['live', 'archived']) {
    const h: AgentMenuHandlers & { onTeamScratchFolder?: () => void } = {
      onInbox: noop, onSettings: noop, onScratchFolder: scratchFolderAction('fixture', 'leaf', toast),
      onTeamScratchFolder: action('fixture', 'leaf', toast, 'team'),
    }
    const entries = agentMenuEntries({ id: 'leaf', state, children: [] } as unknown as CanvasNode, h)
    const open = entries.find(e => typeof e !== 'string' && e.label === 'Open')
    assert.ok(open && typeof open !== 'string', 'the agent Open branch rendered')
    const children = open.children!.filter(e => typeof e !== 'string')
    const own = children.findIndex(e => e.label === 'Open scratch folder')
    assert.ok(own >= 0, 'the existing personal entry stays available')
    assert.equal(children[own + 1]?.label, 'Open team scratch folder')
    children[own + 1]!.onSelect()
  }
  await flush()
  assert.deepEqual(calls, [['fixture', 'leaf', 'team'], ['fixture', 'leaf', 'team']])
})

for (const focused of [false, true]) test(`switchboard shared-folder entry opens the org folder (${focused ? 'focused header' : 'overview'})`, async t => {
  const { calls, toast } = installNative(t)
  installFetch(t)
  const view = await mountView(<UserNode pos={{ x: 0, y: 0 }} isDrop={false}
    stats={{ circ: 0, seats: 0, free: 0 }} pip={null} seats={{ haiku: 1 }}
    pxc={1} zoom={1} onSpawn={noop} onMailLink={noop} onWorkLink={noop}
    focused={focused} eyeW={focused ? 900 : 124} posX={() => 0}
    map={new Map()} op={async () => ({} as never)} slug="fixture" toast={toast}
    onInbox={noop} onGear={noop} onDocket={noop} onPresentations={noop} />, el => el)
  t.after(() => view.unmount())
  const surface = view.el.querySelector(focused ? '.eye-head' : '.sq.user')
  assert.ok(surface, 'switchboard fixture mounted its actual surface')
  await inAct(async () => {
    surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }))
    await flush()
  })
  const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  assert.ok(items.some(b => b.textContent?.trim() === 'Open inbox'), 'the real menu mounted')
  const item = items.find(b => b.textContent?.trim() === 'Open shared scratch folder')
  assert.ok(item, 'shared scratch is a switchboard context entry')
  assert.equal(item.hasAttribute('aria-haspopup'), false, 'the switchboard keeps flat Open actions')
  await inAct(async () => { item.click(); await flush() })
  assert.deepEqual(calls, [['fixture', '', 'shared']])
})

test('Org settings Basic opens the same shared folder without saving settings', async t => {
  const { calls, toast } = installNative(t)
  installFetch(t)
  const view = await mountView(<SettingsPanel tree={tree} toast={toast} close={noop} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(10) })
  assert.ok(view.el.querySelector('[role="tab"][aria-selected="true"]'), 'settings mounted')
  const button = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent?.trim() === 'Open shared scratch folder')
  assert.ok(button, 'org settings exposes the shared folder button')
  assert.ok(button.closest('#org-settings-panel-basic'), 'folder button belongs to Basic')
  await inAct(async () => { button.click(); await flush() })
  assert.deepEqual(calls, [['fixture', '', 'shared']])
  assert.equal(view.el.querySelectorAll('.overlay').length, 1, 'no second settings surface')
})

test('new scoped actions are absent in browsers and old personal-only shells', t => {
  installNative(t, false)
  const toast = noop
  assert.equal(action('fixture', 'leaf', toast, 'team'), undefined)
  assert.equal(action('fixture', '', toast, 'shared'), undefined)
  assert.equal(typeof scratchFolderAction('fixture', 'leaf', toast), 'function')
  delete nativeWindow.orgtreeDesktop
  assert.equal(action('fixture', 'leaf', toast, 'team'), undefined)
  assert.equal(action('fixture', '', toast, 'shared'), undefined)
})

test('scoped native errors produce a toast instead of falling back to the personal folder', async t => {
  const { toast, toasts } = installNative(t)
  nativeWindow.orgtreeDesktop!.openAgentScratchFolder = async () => ({ ok: false, error: 'folder refused' })
  action('fixture', 'leaf', toast, 'team')!()
  await flush()
  assert.match(toasts[0]![0]!, /team scratch folder.*folder refused/)
  nativeWindow.orgtreeDesktop!.openAgentScratchFolder = async () => { throw new Error('IPC refused') }
  action('fixture', '', toast, 'shared')!()
  await flush()
  assert.match(toasts[1]![0]!, /shared scratch folder.*IPC refused/)
})
