// desksettingsroute.test.tsx — a desk whose host passes no settings or lineage
// handler still opens them (docket v3-attention-view-agent-settings-button-on-the-d,
// user 2026-09-29: "i cant open agent settings from the attention view desk,
// the button doesnt work").
//
// The Attention view's desk and a restored desk were handed no `onConfig` /
// `onLineage`, so the gear and the `gen N` badge were buttons wired to nothing.
// The desk now falls back to the shell's own openers on AgentSurfaceRoutes.
// Whether the panel then PAINTS above the Attention stage is a real-browser
// question: tests/attnsettings_probe.py.
//
//   §1 no handler: the gear and the badge call the shell's route with this agent
//   §2 a host's own handler still wins over the route (canvas cards unchanged)
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs desksettingsroute

import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { DeskChatProps } from '../src/canvas/desk'
import { AgentSurfaceRoutesProvider } from '../src/canvas/panelcorner'
import type { CanvasNode } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'

const agent: CanvasNode = {
  id: 'writer', generation: 2, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
}

async function open(extra: Partial<DeskChatProps>) {
  localStorage.clear(); resetConvos()
  installFetch(new FakeServer())
  const calls: string[] = []
  const routes = {
    open: () => {}, show: () => {},
    settings: (id: string) => { calls.push(`settings:${id}`) },
    lineage: (id: string) => { calls.push(`lineage:${id}`) },
  }
  const view = await mountView(
    <AgentSurfaceRoutesProvider value={routes}>
      <DeskChat node={agent} map={new Map([[agent.id, agent]])} slug="org"
        op={async () => ({})} toast={() => {}} pub={false} bare {...extra} />
    </AgentSurfaceRoutesProvider>, el => el)
  await inAct(async () => { await flush(3) })
  const press = async (sel: string) => {
    const button = view.el.querySelector<HTMLButtonElement>(sel)
    assert.ok(button, `${sel} is drawn`)
    await inAct(async () => { button.click(); await flush(2) })
  }
  return { view, calls, press }
}

test('§1 with no handler from its host, the gear and the gen badge open the shell\'s panels', async () => {
  const { view, calls, press } = await open({})
  try {
    await press('[aria-label="settings for writer"]')
    await press('.stackbadge')
    assert.deepEqual(calls, ['settings:writer', 'lineage:writer'])
  } finally { await view.unmount(); resetConvos() }
})

test('§2 a host\'s own handlers still win over the shell route', async () => {
  const own: string[] = []
  const { view, calls, press } = await open({
    onConfig: () => { own.push('config') }, onLineage: () => { own.push('lineage') } })
  try {
    await press('[aria-label="settings for writer"]')
    await press('.stackbadge')
    assert.deepEqual(own, ['config', 'lineage'])
    assert.deepEqual(calls, [], 'the route is only the fallback')
  } finally { await view.unmount(); resetConvos() }
})
