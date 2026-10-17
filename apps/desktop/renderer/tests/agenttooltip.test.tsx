import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as agentnav from '../src/canvas/agentnav'
import {
  AgentNavProvider, agentNavProps, useProvideAgentNav,
} from '../src/canvas/agentnav'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'
import type { AgentTooltipInfo } from '../src/canvas/agentnav'

function RegisteredLink({ id, title }: { id: string; title: string }) {
  const info: AgentTooltipInfo = { title }
  useProvideAgentNav(() => [], target => target === id ? info : null)
  return <button type="button" {...agentNavProps(id)}>{id}</button>
}

test('agent links set the native title and do not render a custom tooltip', async () => {
  const v = await mountView(
    <AgentNavProvider><RegisteredLink id="worker" title="Claude Opus 5.5 · max" /></AgentNavProvider>,
    host => host)
  await flush()
  const link = v.el.querySelector('[data-agent-tooltip="worker"]') as HTMLElement
  assert.ok(link, 'the agent link is marked for the shared native title')

  await inAct(() => link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  assert.equal(link.title, 'Claude Opus 5.5 · max')
  assert.equal(document.querySelector('[role="tooltip"]') === null, true,
    'the browser owns tooltip rendering; the renderer creates no overlay')

  await inAct(() => link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
  assert.equal(link.hasAttribute('title'), false,
    'opening the context menu clears the native title so it cannot cover the menu')
  await v.unmount()
})

test('archived agent title keeps the retired model marker', async () => {
  const v = await mountView(
    <AgentNavProvider><RegisteredLink id="retired" title="Claude Opus 5.5 (retired) · max" /></AgentNavProvider>,
    host => host)
  await flush()
  const link = v.el.querySelector('[data-agent-tooltip="retired"]') as HTMLElement
  await inAct(() => link.dispatchEvent(new Event('focusin', { bubbles: true })))
  assert.equal(link.title, 'Claude Opus 5.5 (retired) · max')
  await v.unmount()
})

test('agent tooltip listeners work on an adopted pop-out document and clean up', () => {
  const popoutDocument = document.implementation.createHTMLDocument('pop-out')
  const link = document.createElement('button')
  link.setAttribute('data-agent-tooltip', 'worker')
  popoutDocument.body.appendChild(popoutDocument.adoptNode(link))
  const registerListeners = Reflect.get(agentnav, 'registerAgentNativeTooltipDocument') as
    ((owner: Document, lookup: (id: string) => AgentTooltipInfo | null) => () => void) | undefined
  assert.equal(typeof registerListeners, 'function', 'the listener can bind to a pop-out owner document')
  const removeListeners = registerListeners!(popoutDocument, (id: string) =>
    id === 'worker' ? { title: 'Claude Opus 5.5 · max' } : null)

  link.dispatchEvent(new Event('pointerover', { bubbles: true }))
  assert.equal(link.title, 'Claude Opus 5.5 · max',
    'the adopted link receives the native title from its owning document')
  link.dispatchEvent(new Event('contextmenu', { bubbles: true }))
  assert.equal(link.hasAttribute('title'), false,
    'the owning document clears the native title before its context menu opens')

  removeListeners()
  link.dispatchEvent(new Event('pointerover', { bubbles: true }))
  assert.equal(link.hasAttribute('title'), false, 'the pop-out listener is removed on cleanup')
})

test('model badge inherits the agent link identity tooltip instead of its tier label', async t => {
  const nd = {
    id: 'worker', state: 'live', tier: 'opus', model_id: 'claude-opus-5-5',
    children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  } as unknown as CanvasNode
  const noop = () => {}
  function RegisteredCard() {
    useProvideAgentNav(() => [], id => id === 'worker'
      ? { title: 'Claude Opus 5.5 · max' } : null)
    return <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod="norm" focused={false}
      dragging={false} isDrop={false} seats={{ opus: 4 }} map={new Map([[nd.id, nd]])}
      op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop}
      pxc={1} zoom={1} compactAt={0.8} maxTop={0} cascadeAlloc
      onSpawn={noop} onConfig={noop} onInbox={noop} onLineage={noop}
      onRecenter={noop} onJump={noop} onMailLink={noop} onWorkLink={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  }
  const v = await mountView(<AgentNavProvider><RegisteredCard /></AgentNavProvider>, host => host)
  t.after(() => v.unmount())
  await flush()
  const card = v.el.querySelector<HTMLElement>('.sq')!
  const badge = card.querySelector<HTMLElement>('.sq-title .tier')!
  await inAct(() => badge.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  assert.equal(badge.title, 'Claude Opus 5.5 · max',
    'the badge itself resolves the full identity tooltip instead of keeping its tier id')
})
