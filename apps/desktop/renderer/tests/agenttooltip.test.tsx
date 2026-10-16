// agenttooltip.test.tsx — every renderer agent link gets one delayed,
// resolved tooltip with the provider identity the tree actually carries.

import { advance, flush, inAct, mountView, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentNavProvider, agentNavProps, useProvideAgentNav,
} from '../src/canvas/agentnav'
import type { AgentTooltipInfo } from '../src/canvas/agentnav'

interface TooltipInfo {
  name: string
  provider: string
  model: string
  effort: string
  account: string
}

function RegisteredLink({ info }: { info: TooltipInfo }) {
  // Keep the focused red control loadable on the base where the optional
  // second registration argument does not exist yet.
  const provide = useProvideAgentNav as unknown as (
    menu: () => never[], tooltip: (id: string) => TooltipInfo | null,
  ) => void
  provide(() => [], id => id === info.name ? info : null)
  return <button type="button" {...agentNavProps(info.name)}>{info.name}</button>
}

test('agent links reveal one account-aware tooltip after the standard delay', async () => {
  useFakeClock()
  const info: AgentTooltipInfo = {
    name: 'worker', provider: 'Codex', model: 'gpt-5.6', effort: 'high',
    account: 'default · worker@example.test',
  }
  const v = await mountView(
    <AgentNavProvider><RegisteredLink info={info} /></AgentNavProvider>, host => host)
  await flush()
  const link = v.el.querySelector('[data-agent-tooltip="worker"]') as HTMLElement
  assert.ok(link, 'the link exposes the shared tooltip target')

  await inAct(() => link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  await advance(499, 50)
  assert.equal(document.querySelector('[role="tooltip"]') === null, true,
    'the tooltip waits for the standard hover delay')
  await advance(1, 1)
  await flush()
  const tooltip = document.querySelector('[role="tooltip"]')
  assert.ok(tooltip, 'the shared tooltip appears after the delay')
  assert.equal(tooltip!.querySelector('strong')?.textContent, 'worker')
  assert.deepEqual([...tooltip!.querySelectorAll('span')].map((span) => span.textContent?.trim()), [
    'Provider: Codex', 'Model: gpt-5.6', 'Effort: high', 'Account: default · worker@example.test',
  ])
  await v.unmount()
})

test('archived agent tooltip identifies the last model as retired', async () => {
  useFakeClock()
  const info: AgentTooltipInfo = {
    name: 'retired', provider: 'Claude', model: 'opus (retired)',
    effort: 'medium', account: 'claude/primary · retired@example.test',
  }
  const v = await mountView(
    <AgentNavProvider><RegisteredLink info={info} /></AgentNavProvider>, host => host)
  await flush()
  const link = v.el.querySelector('[data-agent-tooltip="retired"]') as HTMLElement
  assert.ok(link, 'the archived agent link exposes the shared tooltip target')
  await inAct(() => link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  await advance(500, 50)
  await flush()
  const tooltip = document.querySelector('[role="tooltip"]')
  assert.equal(tooltip?.querySelector('strong')?.textContent, 'retired')
  assert.deepEqual([...tooltip!.querySelectorAll('span')].map((span) => span.textContent?.trim()), [
    'Provider: Claude', 'Model: opus (retired)', 'Effort: medium',
    'Account: claude/primary · retired@example.test',
  ])
  await v.unmount()
})
