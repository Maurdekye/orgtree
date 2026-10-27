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
// React derives onPointerLeave from pointerout
const leave = (el: Element) => inAct(() => el.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })))

// USER 2026-10-27 maf032f443c8c ("nodes render overtop the hover names"), after 2026-10-26 "Never hide on
// hover": a mini node's hover or focus name is the floating plate, drawn in the world layer above every
// card, also while desks are open. This replaces the 4.4.0 desk suppression of the plate (0a47651): with
// the plate gone, the name fell back into the hovered card, which mini hover drops below its neighbours. A
// pinned desk lives in the pin layer above the whole world, so the plate never paints over it.
for (const kind of ['agent', 'project'] as const) test(`${kind} desk window keeps far names above every card on hover and focus, and its content reveals none`, async t => {
  const fetch = globalThis.fetch
  installFetch(new FakeServer())
  localStorage.clear(); forgetPins('bunch-fixture')
  localStorage.setItem('orgtree-start-zoom', '0')
  const owner = kind === 'agent' ? agent('desk-owner') : project('desk-owner')
  const tree = bunchTree([owner, agent('neighbour-agent'), project('neighbour-project')])
  const view = await mountView(<OrgCanvas tree={tree} slug={tree.slug} op={async () => ({ ok: true } as never)} toast={noop} mailEvt={null} />, el => el)
  t.after(async () => { await view.unmount(); forgetPins(tree.slug); localStorage.clear(); globalThis.fetch = fetch })
  const card = (id: string) => [...view.el.querySelectorAll<HTMLElement>('.space .sq')].find(el => el.dataset.firstUseAgent === id || el.dataset.copyAgentName === id)!
  const plates = () => [...view.el.querySelectorAll('.sq-far-ghost.on .sq-far-name')].map(el => el.textContent)
  await hover(card('neighbour-agent'))
  assert.deepEqual(plates(), ['neighbour-agent'], 'closed-desk positive hover control')
  await inAct(() => { assert.equal(addPin(tree.slug, owner.id, { x: 10, y: 10, w: 600, h: 480 }).ok, true) })
  const desk = document.querySelector('.pinwin .cc-head')
  assert.ok(desk, 'real desk window mounted')
  assert.deepEqual(plates(), ['neighbour-agent'], "opening a desk keeps the hovered neighbour's plate")
  assert.ok(view.el.querySelector('.sq-far-ghost.on')!.closest('.space'), 'the plate is in the world layer')
  assert.ok(desk!.closest('.pin-layer'), 'the desk window is in the pin layer above it')
  await leave(card('neighbour-agent'))
  for (const id of ['neighbour-agent', 'neighbour-project']) {
    await hover(card(id))
    assert.deepEqual(plates(), [id], `${id}: hover shows its plate while a desk is open`)
    assert.equal(card(id).classList.contains('far-ghosted'), true, `${id}: the in-card copy hides while the plate shows`)
    await leave(card(id))
    assert.deepEqual(plates(), [], `${id}: leaving retracts it`)
    await inAct(() => card(id).dispatchEvent(new MouseEvent('focusin', { bubbles: true })))
    assert.deepEqual(plates(), [id], `${id}: focus shows it too`)
    await inAct(() => card(id).dispatchEvent(new MouseEvent('focusout', { bubbles: true })))
  }
  // away from the camera's focus the pinned desk's own card is an ordinary mini node (its placeholder only
  // stands in while the camera is on it), so it names itself as well
  await hover(card(owner.id))
  assert.deepEqual(plates(), [owner.id], "the pinned desk's own mini card names itself too")
  await leave(card(owner.id))
  await hover(desk!)
  assert.deepEqual(plates(), [], 'hovering inside the desk reveals no canvas plate')
  await inAct(() => { assert.equal(addPin(tree.slug, 'neighbour-agent', { x: 620, y: 10, w: 360, h: 480 }).ok, true) })
  await inAct(() => removePin(tree.slug, owner.id))
  await hover(card('neighbour-project'))
  assert.deepEqual(plates(), ['neighbour-project'], 'with one of two desks closed, hover still shows the plate')
  await leave(card('neighbour-project'))
  await inAct(() => removePin(tree.slug, 'neighbour-agent'))
  await hover(card('neighbour-project'))
  assert.deepEqual(plates(), ['neighbour-project'], 'and after the last desk closes, as always')
})

test('embedded project desk never reveals its clipped underlying normal-card name', async t => {
  const fetch = globalThis.fetch; installFetch(new FakeServer())
  const proto = HTMLElement.prototype
  const saved = ['scrollWidth', 'clientWidth'].map(key => [key, Object.getOwnPropertyDescriptor(proto, key)] as const)
  for (const [key] of saved) Object.defineProperty(proto, key, { configurable: true, get(this: HTMLElement) { return this.classList.contains('name') ? key === 'scrollWidth' ? 900 : 80 : 0 } })
  const node = project('discord-compress-picker-with-a-long-clipped-name') as unknown as CanvasNode
  const tree = bunchTree([node])
  const el = (focused: boolean) => <ProjectSquare node={node} pos={{ x: 100, y: 100 }} lod="norm" focused={focused}
    tree={tree} map={new Map([[node.id, node]])} refs={{ world: { org: tree.slug }, onOpen: noop } as never} zoom={1} dragging={false} isDrop={false}
    op={async () => ({} as never)} slug={tree.slug} toast={noop} seats={{}} hire={{}} onHire={noop} onNewProject={noop}
    onInbox={noop} onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  const view = await mountView(el(false), el => el)
  t.after(async () => { await view.unmount(); for (const [key, desc] of saved) { if (desc) Object.defineProperty(proto, key, desc); else Reflect.deleteProperty(proto, key) }; globalThis.fetch = fetch })
  await hover(view.el.querySelector('.sq')!)
  assert.ok(view.el.querySelector('.name-full'), 'clipped card without desk reveals its full name')
  await view.render(el(true))
  assert.ok(view.el.querySelector('.cc-head'), 'real embedded project desk mounted')
  await hover(view.el.querySelector('.cc-head')!)
  assert.equal(!!view.el.querySelector('.name-full'), false, 'desk content cannot reveal the hidden card-name backdrop')
})
