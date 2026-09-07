import './harness'
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { patchMcpNode, patchMcpReadinessNode } from '../src/App'
import { McpToolCountMark, TurnStartingMark } from '../src/canvas/desk'
import type { TreeNode } from '../src/types'

declare const __SRC_DIR__: string

const root = (): TreeNode => ({
  id: 'agent', state: 'live', tier: 'haiku', model_id: 'haiku', parent: null,
  seat: 1, grant: 0, free: 0, children: [], scope: { tools: {
    bash: true, web: true, edit: true, subagents: false, mcp: [] }, add_dirs: [] },
} as unknown as TreeNode)

const event = (count: number | null, last: number | null) => ({
  type: 'node_stream' as const, node: 'agent', kind: 'mcp_tool_count',
  count, last_turn_count: last, provider: 'claude', source: 'system/init.tools',
  reason: count == null ? 'initializing' : null, emitted_at_ms: Date.now(),
})

test('realtime inventory payloads apply stepwise before any turn boundary', async () => {
  let n = root()
  const seen: (number | null)[] = []
  for (const count of [null, 0, 1, 3, 2, 0, null]) {
    n = patchMcpNode(n, 'agent', event(count, null))
    seen.push(n.mcp_tool_count)
  }
  assert.deepEqual(seen, [null, 0, 1, 3, 2, 0, null])

  // 946f4ab — THE CHIP SAYS THE NUMBER IT HAS. There are THREE states here,
  // not two, and the last two used to render identically:
  //   · measured now            → "MCP 3"   (`same`/`changed`)
  //   · measured LAST TURN only → "MCP ~3"  (`unknown stale`)
  //   · never measured at all   → "MCP —"   (`unknown`)
  // The live count is null for every window in which no provider process has
  // published, which on a mostly-idle agent is most of its life, so collapsing
  // the middle case into "—" reported a node whose surface we know perfectly
  // well as unknown. The `~` is load-bearing: it says "3 last turn", never
  // "3 right now".
  const view = await mountView(<>
    <McpToolCountMark count={0} last={null} provider="claude" source="init" />
    <McpToolCountMark count={3} last={3} provider="claude" source="refresh" />
    <McpToolCountMark count={2} last={3} provider="claude" source="refresh" />
    <McpToolCountMark count={null} last={3} provider="antigravity" source="ACP"
      reason="runtime inventory unavailable" />
    <McpToolCountMark count={null} last={null} provider="antigravity" source="ACP"
      reason="runtime inventory unavailable" />
  </>, (el) => el)
  try {
    const marks = [...view.el.querySelectorAll<HTMLElement>('.mcp-tool-count')]
    assert.equal(marks[0]?.classList.contains('same'), true,
      'a real zero with no previous turn must be green, not unknown')
    assert.equal(marks[1]?.classList.contains('same'), true)
    assert.equal(marks[2]?.classList.contains('changed'), true)

    // unresolved NOW but measured last turn: the number survives, marked
    assert.equal(marks[3]?.classList.contains('unknown'), true)
    assert.equal(marks[3]?.classList.contains('stale'), true,
      'a last-turn fallback must be marked stale, not styled as a live count')
    assert.match(marks[3]?.textContent ?? '', /MCP\s+~3/)
    assert.doesNotMatch(marks[3]?.textContent ?? '', /—/,
      'a node with a known last-turn count must not read as never-measured')
    assert.match(marks[3]?.getAttribute('aria-label') ?? '', /runtime inventory unavailable/)

    // ⚠ NEVER MEASURED IS STILL "—". This is the case the fallback must not
    // swallow: with no live count AND no last-turn count there is no number
    // to stand behind, and inventing one — or borrowing a neighbour's — is
    // the failure the `~` notation exists to avoid.
    assert.equal(marks[4]?.classList.contains('unknown'), true)
    assert.equal(marks[4]?.classList.contains('stale'), false,
      'nothing was ever measured — there is no stale number to fall back to')
    assert.match(marks[4]?.textContent ?? '', /MCP\s+—/)
    assert.doesNotMatch(marks[4]?.textContent ?? '', /~/)
    assert.match(marks[4]?.getAttribute('aria-label') ?? '', /unknown/)
  } finally { await view.unmount() }
})

test('App applies MCP websocket inventory directly without a refetch', () => {
  const src = readFileSync(path.join(__SRC_DIR__, 'App.tsx'), 'utf8')
  const start = src.indexOf("if (data.kind === 'mcp_tool_count')")
  const end = src.indexOf('// the conversation model', start)
  assert.ok(start >= 0 && end > start, 'MCP websocket handler is absent')
  const block = src.slice(start, end)
  assert.match(block, /setTree\(/)
  assert.match(block, /patchMcpNode/)
  assert.match(block, /orgtree:mcp-tool-count-applied/)
  assert.match(block, /latency_ms/)
  assert.match(block, /return/)
  assert.doesNotMatch(block, /refreshTree|getTree|bumpLive/,
    'inventory updates fell back to polling/refetch')
})

test('readiness websocket transitions repaint the unique gated label', async () => {
  let n = root()
  n = patchMcpReadinessNode(n, 'agent', {
    type: 'node_stream', node: 'agent', kind: 'mcp_readiness',
    waiting: true, state: 'waiting', reason: 'missing mcp__alpha__one',
  })
  assert.equal(n.mcp_readiness_waiting, true)
  assert.equal(n.mcp_readiness_state, 'waiting')
  n = patchMcpReadinessNode(n, 'agent', {
    type: 'node_stream', node: 'agent', kind: 'mcp_readiness',
    waiting: false, state: 'ready', reason: 'surface complete',
  })
  assert.equal(n.mcp_readiness_waiting, false)
  assert.equal(n.mcp_readiness_state, 'ready')

  const view = await mountView(<>
    <TurnStartingMark mcpWaiting={false} />
    <TurnStartingMark mcpWaiting reason="missing mcp__alpha__one" />
    <McpToolCountMark count={1} last={1} provider="claude" source="init"
      readinessState="waiting" readinessReason="missing mcp__alpha__one" />
  </>, (el) => el)
  try {
    const labels = [...view.el.querySelectorAll<HTMLElement>('.msg')]
    assert.match(labels[0]?.textContent ?? '', /starting/i)
    assert.match(labels[1]?.textContent ?? '', /Waiting for MCP tools/)
    assert.equal(labels[1]?.title, 'missing mcp__alpha__one')
    assert.match(view.el.querySelector<HTMLElement>('.mcp-tool-count')
      ?.getAttribute('aria-label') ?? '', /readiness: waiting.*mcp__alpha__one/s)
  } finally { await view.unmount() }
})

test('App applies readiness websocket transitions directly without polling', () => {
  const src = readFileSync(path.join(__SRC_DIR__, 'App.tsx'), 'utf8')
  const start = src.indexOf("if (data.kind === 'mcp_readiness')")
  const end = src.indexOf('// the conversation model', start)
  assert.ok(start >= 0 && end > start, 'readiness websocket handler is absent')
  const block = src.slice(start, end)
  assert.match(block, /setTree\(/)
  assert.match(block, /patchMcpReadinessNode/)
  assert.match(block, /return/)
  assert.doesNotMatch(block, /refreshTree|getTree|bumpLive/,
    'readiness updates fell back to polling/refetch')
})
