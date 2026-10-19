import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ProjectSquare } from '../src/canvas/projectcard'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const project = { id: 'release-project', title: 'release-project', kind: 'project', state: 'live',
  tier: 'project', children: [], scope: { tools: {}, add_dirs: [] }, turns: [] } as unknown as CanvasNode
function Card({ lod = 'mini' }: { lod?: 'mini' | 'norm' }) {
  useProvideAgentNav(() => [], () => ({ title: 'Project · Summary: a synthetic release' }))
  return <ProjectSquare node={project} lod={lod} pos={{ x: 100, y: 150 }} zoom={.24}
    dragging={false} isDrop={false} op={async () => ({} as OpResult)} slug="test-org" toast={noop}
    hire={{}} seats={{}} onHire={noop} onNewProject={noop} onInbox={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
}
const element = (lod: 'mini' | 'norm' = 'mini') => <AgentNavProvider><Card lod={lod} /></AgentNavProvider>
const hover = (el: Element) => inAct(() => el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))

test('far-zoom project tooltip keeps details without repeating its floating name', async t => {
  const v = await mountView(element(), el => el); t.after(() => v.unmount())
  const icon = v.el.querySelector<HTMLElement>('.project-mini')!
  await hover(icon)
  assert.equal(icon.title, 'Project · Summary: a synthetic release')
})

test('project hover puts the same name presentation above the card layer', async t => {
  const v = await mountView(element(), el => el); t.after(() => v.unmount())
  assert.equal(!!v.el.querySelector('.sq-far-ghost'), false)
  const card = v.el.querySelector<HTMLElement>('.sq.project')!
  await hover(card)
  const label = v.el.querySelector<HTMLElement>('.sq-far-ghost.on')
  assert.ok(label, 'project hover reveals the shared floating label')
  assert.equal(label.closest('.sq') === null, true, 'above the card stacking context')
  assert.equal(label.querySelector('.sq-far-name')?.textContent, project.id)
  assert.ok(label.querySelector('.sq-far-tier .sq-far-scaler svg'), 'folder icon precedes the name')
  assert.equal(label.style.left, '100px'); assert.equal(label.style.top, '150px')
  await v.render(element('norm'))
  assert.equal(!!v.el.querySelector('.sq-far-ghost'), false, 'zoom removes the far-zoom label immediately')
  await v.render(element())
  assert.equal(!!v.el.querySelector('.sq-far-ghost.on'), true, 'stationary hover restores the label')
})

test('project keyboard focus reveals the name and blur retracts it', async t => {
  const v = await mountView(element(), el => el); t.after(() => v.unmount())
  const card = v.el.querySelector<HTMLElement>('.sq.project')!
  await inAct(() => card.dispatchEvent(new MouseEvent('focusin', { bubbles: true })))
  assert.equal(!!v.el.querySelector('.sq-far-ghost.on'), true)
  await inAct(() => card.dispatchEvent(new MouseEvent('focusout', { bubbles: true, relatedTarget: document.body })))
  assert.equal(!!v.el.querySelector('.sq-far-ghost.on'), false)
  await inAct(() => new Promise(r => setTimeout(r, 300)))
  assert.equal(!!v.el.querySelector('.sq-far-ghost'), false)
})

test('normal project icon still names the project and the visible name has rich details', async t => {
  const v = await mountView(element('norm'), el => el); t.after(() => v.unmount())
  const icon = v.el.querySelector<HTMLElement>('.project-mark')!
  await hover(icon)
  assert.equal(icon.title, 'release-project\nProject · Summary: a synthetic release')
  const name = v.el.querySelector<HTMLElement>('.sq-title .name')!
  await hover(name)
  assert.equal(name.title, 'Project · Summary: a synthetic release')
  assert.equal(!!v.el.querySelector('.sq-far-ghost'), false)
})
