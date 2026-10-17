import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
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
  assert.equal(badge.hasAttribute('title'), false,
    'tier id title on the nested badge must not override the shared tooltip')
  await inAct(() => badge.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  assert.equal(card.title, 'Claude Opus 5.5 · max')
})
