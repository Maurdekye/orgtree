import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentNavProvider, agentNavProps, useProvideAgentNav,
} from '../src/canvas/agentnav'
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
