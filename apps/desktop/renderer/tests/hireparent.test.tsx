import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { NodeSquare, UserNode } from '../src/canvas/cards'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import { useContextMenu, type MenuEntry } from '../src/canvas/contextmenu'
import type { CanvasNode } from '../src/canvas/shared'
import { rememberTier } from '../src/quickchat'

const noop = () => {}
const available = { enabled: true, installed: true, reason: null }
const slug = 'hire-parent-fixture'
const project = { id: 'project-target', title: 'project-target', kind: 'project', tier: 'project',
  state: 'live', generation: 1, children: [], turns: [], seat: 0, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] } } as unknown as CanvasNode
const labels = { project: 'Hire under this project', switchboard: 'Hire an agent' }
const named = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  .find(b => b.textContent?.replace(/\s*▸$/, '') === label)!
async function activate(el: HTMLElement, action = 'click') {
  await inAct(() => action === 'click' ? el.click()
    : el.dispatchEvent(new KeyboardEvent('keydown', { key: action, bubbles: true, cancelable: true })))
}
function MenuHost({ entries }: { entries: MenuEntry[] }) {
  const menu = useContextMenu()
  return <><div className="row-target" onContextMenu={e => menu.open(e, entries)}>project row</div>{menu.node}</>
}

async function setup(t: TestContext, kind: keyof typeof labels, template = false, blocked = false) {
  const before = globalThis.fetch
  installFetch(new FakeServer()); localStorage.clear()
  const calls: string[] = []
  const props = { pos: { x: 0, y: 0 }, isDrop: false, seats: { sol: 2 },
    codexHire: blocked ? { ...available, enabled: false, reason: 'not offered here' } : available,
    claudeHire: available, focused: false, pxc: 1, zoom: 0.24, slug, toast: noop,
    map: new Map([[project.id, project]]), op: async () => ({}),
    onSpawn: (tier: string) => calls.push(tier), onMailLink: noop, onWorkLink: noop,
    ...(template ? { quickChatDefaults: { tier: 'sol' } } : {}) }
  const view = await mountView(kind === 'switchboard'
    ? <UserNode {...props} stats={{ circ: 0, seats: 0, free: 0 }} pip={null} eyeW={600} posX={() => 0} />
    : <NodeSquare {...props} node={project} lod="mini" dragging={false} maxTop={0} cascadeAlloc compactAt={0.8}
        onConfig={noop} onInbox={noop} onLineage={noop} onRecenter={noop} onJump={noop}
        onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = before; localStorage.clear() })
  const open = async () => {
    await inAct(() => view.el.querySelector('.sq')!.dispatchEvent(new MouseEvent('contextmenu',
      { bubbles: true, cancelable: true, button: 2 })))
    await flush(2)
  }
  return { calls, open }
}

for (const kind of ['project', 'switchboard'] as const) {
  for (const template of [false, true]) for (const action of ['click', 'Enter']) {
    test(`${kind} hire ${action} uses ${template ? 'template' : 'latest remembered'} Quick chat tier`, async t => {
      const { calls, open } = await setup(t, kind, template)
      if (!template) rememberTier(slug, 'sol') // after mount: no stale render snapshot
      await open(); await activate(named(labels[kind]), action)
      assert.deepEqual(calls, ['sol'])
      assert.equal(document.querySelector('.ctxmenu') === null, true, 'action closes the menu')
    })
  }
  for (const blocked of [false, true]) {
    test(`${kind} missing/unavailable remembered tier only expands (${blocked})`, async t => {
      const { calls, open } = await setup(t, kind, false, blocked)
      if (blocked) rememberTier(slug, 'sol')
      await open(); await activate(named(labels[kind]))
      assert.deepEqual(calls, [])
      assert.equal(named(labels[kind]).getAttribute('aria-expanded'), 'true')
    })
  }
  for (const action of ['hover', 'ArrowRight']) {
    test(`${kind} ${action} expands without hiring and tier children still choose explicitly`, async t => {
      const { calls, open } = await setup(t, kind)
      rememberTier(slug, 'sol'); await open()
      const parent = named(labels[kind])
      if (action === 'hover') await inAct(() => parent.parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
      else await activate(parent, action)
      assert.deepEqual(calls, [])
      assert.equal(parent.getAttribute('aria-expanded'), 'true')
      const child = document.querySelector<HTMLButtonElement>('.ctxmenu-submenu [role="menuitem"]:not(:disabled)')!
      assert.ok(child)
      await activate(child)
      assert.equal(calls.length, 1)
      assert.equal(document.querySelector('.ctxmenu') === null, true)
    })
  }
  test(`${kind} hire tooltip explains the Quick chat shortcut and alternate tier selection`, async t => {
    const { open } = await setup(t, kind, true); await open()
    assert.match(named(labels[kind]).title, /Quick chat/i)
    assert.match(named(labels[kind]).title, /hover|choose|submenu/i)
  })
}

for (const action of ['click', 'Enter']) {
  test(`shared project row/header menu ${action} hires under the exact project`, async t => {
    const before = globalThis.fetch; installFetch(new FakeServer())
    const calls: { parent: string; tier: string }[] = []
    const entries = agentMenuEntries(project, { onInbox: noop, onSettings: noop,
      onHire: tier => calls.push({ parent: project.id, tier }) },
    { codexHire: available, quickChatTier: 'sol' })
    const view = await mountView(<MenuHost entries={entries} />, el => el)
    t.after(async () => { await view.unmount(); globalThis.fetch = before })
    await inAct(() => view.el.querySelector('.row-target')!.dispatchEvent(new MouseEvent('contextmenu',
      { bubbles: true, cancelable: true, button: 2 })))
    await activate(named(labels.project), action)
    assert.deepEqual(calls, [{ parent: 'project-target', tier: 'sol' }])
  })
}

test('retired and piled projects still omit hiring', () => {
  for (const [node, piled] of [[{ ...project, state: 'archived' }, false], [project, true]] as const) {
    const entries = agentMenuEntries(node as CanvasNode, { onInbox: noop, onSettings: noop, onHire: noop },
      { codexHire: available, quickChatTier: 'sol', piled })
    assert.equal(entries.some(e => e !== 'sep' && e.label === labels.project), false)
  }
})
