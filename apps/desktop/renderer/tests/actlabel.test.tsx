// Overview state follows the September 7 single-word Active ruling.
// Historical activity must never make an idle card look like a running turn.

import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Activity } from '../src/canvas/desk'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import type { ActivityInfo, OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

function node(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, state: 'live', tier: 'opus', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'opus', ...extra,
  }
}

const label = (act: ActivityInfo) =>
  mountView(<Activity act={act} />, (el) => el)

const card = (nd: CanvasNode, lod: 'mini' | 'norm' = 'norm') =>
  mountView(
    <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod={lod} focused={false}
      dragging={false} isDrop={false} seats={{ used: 1, total: 4 }}
      map={new Map([[nd.id, nd]])} op={op} slug="org" toast={noop}
      pxc={1} zoom={1} compactAt={0.8} pub={false} maxTop={0}
      kioskRemaining={null} cascadeAlloc
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
      onInbox={noop} onLineage={noop} onOpenDoc={noop} onRecenter={noop}
      onJump={noop} onMailLink={noop} onDragStart={noop} onDragMove={noop}
      onDragEnd={noop} onDragCancel={noop} />,
    (el) => el)

// User ruling 2026-09-07: system-observed state is the single word Active.
// Tool names and activity phases must not replace it on the overview card.
// The old V1 long-tool-label assertions predate that explicit replacement.
test('every running activity uses the same bounded Active label', async () => {
  for (const act of [{phase:'tool',tool:'mcp__orgtree__orgtree_send_notice'},
    {phase:'tool',tool:'Bash'}, {phase:'thinking'}, {phase:'writing'}] as ActivityInfo[]) {
    const v = await label(act)
    try {
      assert.equal(v.el.querySelector('.actlabel-text')?.textContent, 'Active')
      assert.equal(v.el.querySelector('.actlabel')?.getAttribute('title'), 'active')
      assert.ok(v.el.querySelector('.cc-spin'), 'running indicator is retained')
    } finally { await v.unmount() }
  }
})
test('overview cards report Active only during an actual turn and retain the mini indicator', async () => {
  const act: ActivityInfo = {phase:'tool',tool:'mcp__mcplink__get_protoflux_subgraph'}
  const busy = await card(node('a1', {busy:true,activity:act}))
  const idle = await card(node('a2', {activity:act}))
  const mini = await card(node('a3', {busy:true,activity:act}), 'mini')
  try {
    assert.equal(busy.el.querySelector('.sq-idle.active')?.textContent, 'Active')
    assert.equal(idle.el.querySelector('.sq-idle.active'), null, 'historical activity is not a live turn')
    assert.equal(mini.el.querySelector('.actlabel'), null)
    assert.ok(mini.el.querySelector('.cc-spin'), 'mini card keeps its busy indicator')
  } finally {await busy.unmount();await idle.unmount();await mini.unmount()}
})

test('a Sol card carries the OpenAI theme and the S tier tag', async () => {
  const codex = await card(node('codex-sol', {
    tier: 'sol', model_id: 'gpt-5.6-sol', seat: 5,
  }))
  const sq = codex.el.querySelector('.sq')
  assert.ok(sq?.classList.contains('prov-openai'),
    'the provider theme class is missing from the Codex card')
  assert.ok(sq?.classList.contains('tier-sol'),
    'the independent Sol tier stripe class is missing from the Codex card')
  assert.equal(sq?.querySelector('.tier')?.textContent, 'S')
})
