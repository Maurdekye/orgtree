import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ProjectSquare } from '../src/canvas/projectcard'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
declare const __SRC_DIR__: string
const project = { id: 'release-project', title: 'release-project', kind: 'project', state: 'live',
  tier: 'project', children: [], scope: { tools: {}, add_dirs: [] }, turns: [] } as unknown as CanvasNode
function Card({ lod = 'mini', node = project }: { lod?: 'mini' | 'norm'; node?: CanvasNode }) {
  useProvideAgentNav(() => [], () => ({ title: 'Project · Summary: a synthetic release' }))
  return <ProjectSquare node={node} lod={lod} pos={{ x: 100, y: 150 }} zoom={.24}
    dragging={false} isDrop={false} op={async () => ({} as OpResult)} slug="test-org" toast={noop}
    hire={{}} seats={{}} onHire={noop} onNewProject={noop} onInbox={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
}
const element = (lod: 'mini' | 'norm' = 'mini') => <AgentNavProvider><Card lod={lod} /></AgentNavProvider>
const hover = (el: Element) => inAct(() => el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))

test('shared floating project name uses the full 600px agent ceiling', async t => {
  const id = 'project-transparency-complete-reporting-and-placement'
  const v = await mountView(<AgentNavProvider><Card node={{ ...project, id, title: id }} /></AgentNavProvider>, el => el)
  t.after(() => v.unmount())
  await hover(v.el.querySelector('.sq.project')!)
  assert.equal(v.el.querySelector('.sq-far-ghost.on .sq-far-name')?.textContent, id)
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const body = css.match(/\.sq-far-ghost\.on \.sq-far-name\s*\{([^}]+)\}/)?.[1]
  assert.ok(body, 'shared project/agent floating label rule exists')
  assert.match(body, /max-width:\s*600px/, 'floating labels retain the full name up to the shared ceiling')
})

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

// USER 2026-11-17 18:55:48Z m75a0b53834c2 (item canvas-at-mini-node-zoom-a-project-s-coworker-hi): "at mini node zoom,
// it's nearly impossible to expand the coworker hire tokens on a project, as they disappear once you move your mouse off
// the node". The coworker columns stand off the card by --hsof-l-clear / --hsof-r-clear (styles.css) and exist only while
// the card is hovered. An agent card fills that gap with transparent hover bridges (cards.tsx, minihire.test.tsx §1); the
// project card had none, so the pointer left the card in the gap and the columns vanished before it reached them.
test('mini and norm: a project carries the coworker hover bridges its side hire columns need, as an agent card does', async t => {
  const side = (lod: 'mini' | 'norm') => <AgentNavProvider>
    <ProjectSquare node={project} lod={lod} pos={{ x: 0, y: 0 }} zoom={lod === 'mini' ? .24 : 1}
      dragging={false} isDrop={false} op={async () => ({} as OpResult)} slug="test-org" toast={noop}
      hire={{ claudeHire: { enabled: true, installed: true, reason: null } }}
      seats={{ opus: 5 }} onHire={noop} onNewProject={noop} onInbox={noop} onSpawnSide={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  </AgentNavProvider>
  const v = await mountView(side('mini'), el => el); t.after(() => v.unmount())
  const card = v.el.querySelector<HTMLElement>('.sq.project')!
  assert.equal(card.querySelectorAll(':scope > .hsof.side-l, :scope > .hsof.side-r').length, 2,
    'both coworker columns are mounted at mini (otherwise this tests nothing)')
  assert.ok(card.querySelector(':scope > .hsof-bridge.bridge-l'), 'the left gap is bridged')
  assert.ok(card.querySelector(':scope > .hsof-bridge.bridge-r'), 'the right gap is bridged')
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.sq > \.hsof-bridge\.bridge-l\s*\{[^}]*width:\s*var\(--hsof-l-clear\)/,
    'the bridge spans exactly the gap its column stands off')
  // USER 2026-11-17 19:01:49Z mcbc35fe69dad "Normal zoom too (Rec.)": norm has the same gap (22 px on screen at z 1),
  // so it gets the same bridges, as an agent card has at every zoom. The desk shows its chips without hover and keeps none.
  await v.render(side('norm'))
  const normCard = v.el.querySelector<HTMLElement>('.sq.project')!
  assert.equal(normCard.querySelectorAll(':scope > .hsof.side-l, :scope > .hsof.side-r').length, 2,
    'both coworker columns are mounted at norm')
  assert.ok(normCard.querySelector(':scope > .hsof-bridge.bridge-l'), 'norm: the left gap is bridged')
  assert.ok(normCard.querySelector(':scope > .hsof-bridge.bridge-r'), 'norm: the right gap is bridged')
})
