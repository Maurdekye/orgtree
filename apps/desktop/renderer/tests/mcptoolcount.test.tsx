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
    // ⚠ THE `~` IS EXPLAINED IN WORDS ON HOVER (2026-09-18). The tooltip cut
    // could have relied on the `~` prefix alone to distinguish a stale
    // reading from a live one, and that was the explicit judgement call. It
    // does not: the comment above this test has to spell out what `~` means,
    // and a notation needing a comment is what a hover exists to say aloud.
    assert.equal(marks[3]?.getAttribute('aria-label'),
      '3 callable MCP tools last turn — runtime inventory unavailable')

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
    // №21 again: a BLANK "unknown" was the original user complaint, so the
    // reason survived the cut. Pinned by equality — dropping it would leave
    // the assertion above still passing on the bare word "unknown".
    assert.equal(marks[4]?.getAttribute('aria-label'),
      'MCP tool count unknown — runtime inventory unavailable')

    // ⚠ THE TWO LIVE CASES, which is where the cut actually bit. Case 1 used
    // to read "current callable MCP tools: 3 / last successful turn: 3 /
    // provider/source: claude / refresh" — three lines to say what the "MCP
    // 3" glyph beside it already said. The last-turn count survives only in
    // the `changed` case, where it is the reason the chip changed colour.
    assert.equal(marks[1]?.getAttribute('aria-label'), '3 callable MCP tools')
    assert.equal(marks[2]?.getAttribute('aria-label'),
      '2 callable MCP tools (3 last turn)')
    // a real zero, and the singular
    assert.equal(marks[0]?.getAttribute('aria-label'), '0 callable MCP tools')
    // EVERY tooltip is one line and carries no plumbing
    for (const m of marks) {
      const t = m.getAttribute('aria-label') ?? ''
      assert.equal(t.includes('\n'), false, `multi-line tooltip: ${t}`)
      assert.doesNotMatch(t, /provider\/source|last successful turn|current callable/,
        `a cut line came back: ${t}`)
      // title and aria-label must stay in step with each other
      assert.equal(m.getAttribute('title'), t)
    }
  } finally { await view.unmount() }
})

test('the singular is used for exactly one tool', async () => {
  // "1 callable MCP tools" was the shape the first draft produced; the count
  // is user-visible prose now rather than a value after a colon, so it has to
  // read like prose.
  const view = await mountView(
    <McpToolCountMark count={1} last={1} provider="claude" source="init" />, (el) => el)
  try {
    assert.equal(view.el.querySelector('.mcp-tool-count')?.getAttribute('aria-label'),
      '1 callable MCP tool')
  } finally { await view.unmount() }
})

test('App applies MCP websocket inventory directly without a refetch', () => {
  // Since the base+patch protocol (2026-09-19, treesync.ts) the three patch
  // kinds share ONE handler branch that applies via applyPatchFrame; the
  // only fetch it may contain is the rev-GAP catch-up, which fires solely
  // when frames were missed — never as the ordinary update path.
  const src = readFileSync(path.join(__SRC_DIR__, 'App.tsx'), 'utf8')
  // anchor inside handleWs: applyPatchFrame's own dispatch uses the same
  // kind checks earlier in the file
  const handler = src.indexOf('const handleWs')
  const start = src.indexOf("if (data.kind === 'cache_forecast'", handler)
  const end = src.indexOf('// the conversation model', start)
  assert.ok(start >= 0 && end > start, 'ws patch handler branch is absent')
  const block = src.slice(start, end)
  assert.doesNotMatch(block, /setTree\(/, 'metadata must not invalidate the chart tree')
  assert.match(block, /publishNodeMetadata/)
  assert.match(block, /orgtree:mcp-tool-count-applied/)
  assert.match(block, /latency_ms/)
  assert.match(block, /return/)
  assert.doesNotMatch(block, /getTree|bumpLive/,
    'inventory updates fell back to polling/refetch')
  // every refreshTree in the branch is the gap catch-up, nothing else
  const fetches = block.match(/refreshTree/g) ?? []
  const guarded = block.match(/if \(gap\) refreshTree/g) ?? []
  assert.equal(fetches.length, guarded.length,
    'an unconditional refetch crept into the direct-apply branch')
  // and the dispatcher actually routes inventory frames to the MCP patcher
  const apply = src.slice(src.indexOf('export const applyPatchFrame'),
                          src.indexOf('usageTitle'))
  assert.match(apply, /mcp_tool_count/)
  assert.match(apply, /patchMcpNode/)
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
    // ⚠ READINESS SURVIVED THE 2026-09-18 CUT, as a trailing clause rather
    // than a fourth line. It used to read "readiness: waiting — missing
    // mcp__alpha__one"; the word "readiness:" was the label on a line that no
    // longer exists, and the state plus the missing tool is the whole of what
    // it was carrying. Asserted by equality so the count half is pinned too:
    // the clause has to hang off the count, not replace it.
    assert.equal(view.el.querySelector<HTMLElement>('.mcp-tool-count')
      ?.getAttribute('aria-label'),
    '1 callable MCP tool · waiting: missing mcp__alpha__one')
  } finally { await view.unmount() }
})

test('App applies readiness websocket transitions directly without polling', () => {
  // Same merged branch as inventory (base+patch protocol): the direct
  // application is via applyPatchFrame; only the gap catch-up may fetch.
  const src = readFileSync(path.join(__SRC_DIR__, 'App.tsx'), 'utf8')
  // anchor inside handleWs: applyPatchFrame's own dispatch uses the same
  // kind checks earlier in the file
  const handler = src.indexOf('const handleWs')
  const start = src.indexOf("if (data.kind === 'cache_forecast'", handler)
  const end = src.indexOf('// the conversation model', start)
  assert.ok(start >= 0 && end > start, 'ws patch handler branch is absent')
  const block = src.slice(start, end)
  assert.match(block, /'mcp_readiness'/)
  assert.doesNotMatch(block, /setTree\(/, 'metadata must not invalidate the chart tree')
  assert.match(block, /publishNodeMetadata/)
  assert.match(block, /return/)
  assert.doesNotMatch(block, /getTree|bumpLive/,
    'readiness updates fell back to polling/refetch')
  const fetches = block.match(/refreshTree/g) ?? []
  const guarded = block.match(/if \(gap\) refreshTree/g) ?? []
  assert.equal(fetches.length, guarded.length,
    'an unconditional refetch crept into the direct-apply branch')
  const apply = src.slice(src.indexOf('export const applyPatchFrame'),
                          src.indexOf('usageTitle'))
  assert.match(apply, /mcp_readiness/)
  assert.match(apply, /patchMcpReadinessNode/)
})
