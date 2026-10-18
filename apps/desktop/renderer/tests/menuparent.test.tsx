import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import type { AgentMenuHandlers, AgentMenuState } from '../src/canvas/agentmenu'
import { useContextMenu } from '../src/canvas/contextmenu'
import type { MenuEntry } from '../src/canvas/contextmenu'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import { rememberTier } from '../src/quickchat'

const noop = () => {}
const available = { enabled: true, installed: true, reason: null }
const node = (project = false) => ({ id: 'menu-target', title: 'menu-target', state: 'live', generation: 1,
  tier: project ? 'project' : 'sol', kind: project ? 'project' : undefined,
  children: [], turns: [], seat: 2, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] } } as unknown as CanvasNode)
const named = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  .find(b => b.textContent?.replace(/\s*▸$/, '') === label)!
async function key(target: Element, value: string) {
  await inAct(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
}
function Fixture({ entries }: { entries: MenuEntry[] }) {
  const menu = useContextMenu()
  return <><div data-fixture onContextMenu={e => menu.open(e, entries)}>target</div>{menu.node}</>
}
async function setup(t: TestContext, project = false, choice?: string, temporary = true, blocked = false) {
  const oldFetch = globalThis.fetch
  installFetch(new FakeServer()); localStorage.clear()
  const calls: string[] = []
  const handlers: AgentMenuHandlers = { onInbox: noop, onSettings: noop,
    onOpenTemporary: temporary ? () => calls.push('temporary') : undefined,
    onHire: tier => calls.push('hire:'+tier) }
  const state = { codexHire: available, claudeHire: available, quickChatTier: choice,
    ...(blocked ? { codexHire: { ...available, enabled: false, reason: 'not offered here' } } : {}) } as AgentMenuState
  const view = await mountView(<Fixture entries={agentMenuEntries(node(project), handlers, state)} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch; localStorage.clear() })
  await inAct(() => view.el.querySelector('[data-fixture]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
  return calls
}

for (const project of [false, true]) {
  for (const action of ['click','Enter']) test(`${project ? 'project' : 'agent'} Open parent ${action} opens the temporary desk once and closes`, async t => {
    const calls = await setup(t, project)
    if (action === 'click') await inAct(() => named('Open').click())
    else await key(named('Open'), 'Enter')
    assert.deepEqual(calls, ['temporary'])
    assert.equal(document.querySelector('.ctxmenu') === null, true)
  })
  for (const action of ['hover','ArrowRight']) test(`${project ? 'project' : 'agent'} Open ${action} expands without activating; Desk child still works`, async t => {
    const calls = await setup(t, project)
    const parent = named('Open')
    if (action === 'hover') await inAct(() => parent.parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    else await key(parent,'ArrowRight')
    assert.deepEqual(calls, [])
    assert.equal(parent.getAttribute('aria-expanded'), 'true')
    if (action === 'ArrowRight') assert.equal(document.activeElement, named('Desk'))
    await inAct(() => named('Desk').click())
    assert.deepEqual(calls, ['temporary'])
    assert.equal(document.querySelector('.ctxmenu') === null, true)
  })
  test(`${project ? 'project' : 'agent'} Open with no temporary handler only expands`, async t => {
    const calls = await setup(t, project, undefined, false)
    await inAct(() => named('Open').click())
    assert.deepEqual(calls, [])
    assert.equal(named('Open').getAttribute('aria-expanded'), 'true')
  })
}

for (const action of ['click','Enter']) test(`Hire parent ${action} opens the chosen Quick chat tier form once`, async t => {
  const calls = await setup(t, false, 'sol')
  if (action === 'click') await inAct(() => named('Hire a subordinate').click())
  else await key(named('Hire a subordinate'), 'Enter')
  assert.deepEqual(calls, ['hire:sol'])
  assert.equal(document.querySelector('.ctxmenu') === null, true)
})
for (const blocked of [false,true]) test(`Hire parent ${blocked ? 'unavailable' : 'missing'} Quick chat choice expands without substituting`, async t => {
  const calls = await setup(t, false, blocked ? 'sol' : undefined, true, blocked)
  await inAct(() => named('Hire a subordinate').click())
  assert.deepEqual(calls, [])
  assert.equal(named('Hire a subordinate').getAttribute('aria-expanded'), 'true')
})
test('Hire parent tooltip explains Quick chat default and choice submenu', async t => {
  await setup(t, false, 'sol')
  assert.match(named('Hire a subordinate').title, /Quick chat/i)
  assert.match(named('Hire a subordinate').title, /choose|submenu|hover/i)
})

for (const template of [false,true]) test(`real card Hire reads ${template ? 'organization template default' : 'latest organization memory'} at menu-open time`, async t => {
  const oldFetch=globalThis.fetch;installFetch(new FakeServer());localStorage.clear()
  const n=node(),calls:string[]=[]
  const props = template ? { quickChatDefaults: { tier:'sol' } } : {}
  const view=await mountView(<NodeSquare {...props} node={n} pos={{x:0,y:0}} lod="mini" focused={false}
    dragging={false} isDrop={false} seats={{sol:2}} codexHire={available} claudeHire={available}
    map={new Map([[n.id,n]])} op={async()=>({})} slug="parent-org" toast={noop} pxc={1} zoom={0.24}
    maxTop={0} cascadeAlloc compactAt={0.8} onSpawn={tier=>calls.push(tier)}
    onConfig={noop} onInbox={noop} onLineage={noop} onRecenter={noop} onJump={noop} onMailLink={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop}/>,el=>el)
  t.after(async()=>{await view.unmount();globalThis.fetch=oldFetch;localStorage.clear()})
  if(!template) rememberTier('parent-org','sol') // after mount, so no stale render snapshot can pass
  await inAct(()=>view.el.querySelector('.sq')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2})))
  await flush(2)
  await inAct(()=>named('Hire a subordinate').click())
  assert.deepEqual(calls,['sol'])
  assert.equal(document.querySelector('.ctxmenu')===null,true)
})
