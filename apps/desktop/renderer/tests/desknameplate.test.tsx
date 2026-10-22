import { FakeServer, installFetch, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { ProjectSquare } from '../src/canvas/projectcard'
import { addPin, forgetPins, removePin } from '../src/canvas/pins'
import { agent, project, bunchTree } from './projectbunch-fixture'
import type { CanvasNode } from '../src/canvas/shared'

const noop = () => {}
const hover = (el: Element) => inAct(() => el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))

for (const kind of ['agent', 'project'] as const) test(`${kind} desk window suppresses own and neighbouring far names, including focus and desk-content hover`, async t => {
  const fetch = globalThis.fetch
  installFetch(new FakeServer())
  localStorage.clear(); forgetPins('bunch-fixture')
  localStorage.setItem('orgtree-start-zoom', '0')
  const owner = kind === 'agent' ? agent('desk-owner') : project('desk-owner')
  const tree = bunchTree([owner, agent('neighbour-agent'), project('neighbour-project')])
  const view = await mountView(<OrgCanvas tree={tree} slug={tree.slug} op={async () => ({ ok: true } as never)} toast={noop} mailEvt={null} />, el => el)
  t.after(async () => { await view.unmount(); forgetPins(tree.slug); localStorage.clear(); globalThis.fetch = fetch })
  const card = (id: string) => [...view.el.querySelectorAll<HTMLElement>('.space .sq')].find(el => el.dataset.firstUseAgent === id || el.dataset.copyAgentName === id)!
  await hover(card('neighbour-agent'))
  assert.equal(view.el.querySelectorAll('.sq-far-ghost.on').length, 1, 'closed-desk positive hover control')
  await inAct(() => { assert.equal(addPin(tree.slug, owner.id, { x: 10, y: 10, w: 600, h: 480 }).ok, true) })
  assert.ok(document.querySelector('.pinwin .cc-head'), 'real desk window mounted')
  assert.equal(view.el.querySelectorAll('.sq-far-ghost').length, 0, 'opening a desk immediately removes a previously revealed neighbouring plate')
  for (const id of [owner.id, 'neighbour-agent', 'neighbour-project']) {
    await hover(card(id))
    await inAct(() => card(id).dispatchEvent(new MouseEvent('focusin', { bubbles: true })))
    assert.equal(view.el.querySelectorAll('.sq-far-ghost').length, 0, `${id}: no own or background plate while desk is open`)
  }
  await hover(document.querySelector('.pinwin .cc-head')!)
  assert.equal(view.el.querySelectorAll('.sq-far-ghost').length, 0, 'hover inside desk stays silent')
  await inAct(() => removePin(tree.slug, owner.id))
  await hover(card('neighbour-project'))
  assert.ok(view.el.querySelector('.sq-far-ghost.on'), 'normal far hover returns after the last desk closes')
})

test('embedded project desk never reveals its clipped underlying normal-card name', async t => {
  const fetch = globalThis.fetch; installFetch(new FakeServer())
  const proto = HTMLElement.prototype
  const saved = ['scrollWidth', 'clientWidth'].map(key => [key, Object.getOwnPropertyDescriptor(proto, key)] as const)
  for (const [key] of saved) Object.defineProperty(proto, key, { configurable: true, get(this: HTMLElement) { return this.classList.contains('name') ? key === 'scrollWidth' ? 900 : 80 : 0 } })
  const node = project('discord-compress-picker-with-a-long-clipped-name') as unknown as CanvasNode
  const tree = bunchTree([node])
  const el = (focused: boolean) => <ProjectSquare node={node} pos={{ x: 100, y: 100 }} lod="norm" focused={focused}
    tree={tree} map={new Map([[node.id, node]])} refs={{} as never} zoom={1} dragging={false} isDrop={false}
    op={async () => ({} as never)} slug={tree.slug} toast={noop} seats={{}} hire={{}} onHire={noop} onNewProject={noop}
    onInbox={noop} onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  const view = await mountView(el(false), el => el)
  t.after(async () => { await view.unmount(); for (const [key, desc] of saved) { if (desc) Object.defineProperty(proto, key, desc); else Reflect.deleteProperty(proto, key) }; globalThis.fetch = fetch })
  await hover(view.el.querySelector('.sq')!)
  assert.ok(view.el.querySelector('.name-full'), 'clipped card without desk reveals its full name')
  await view.render(el(true))
  assert.ok(view.el.querySelector('.cc-head'), 'real embedded project desk mounted')
  await hover(view.el.querySelector('.cc-head')!)
  assert.equal(view.el.querySelector('.name-full'), null, 'desk content cannot reveal the hidden card-name backdrop')
})
