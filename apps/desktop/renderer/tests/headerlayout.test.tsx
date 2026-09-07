import './harness'
import { FakeServer, flush, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

declare const __SRC_DIR__: string

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

test('desk header has bounded controls and a separate wrapping metadata row', async (t) => {
  const server = new FakeServer()
  // The mid-turn banner this test ends on is gated on MEASURED context
  // (8126a2b), and the desk reads the chat payload's occupancy ahead of the
  // node's. The fake server's 1,000-token default therefore overrode the
  // 85%-full fixture below and held the gate shut — this test was red from
  // that commit on, not from any change to the banner. The server has to
  // agree with the node.
  server.occupancy = 85000
  installFetch(server)
  const id = 'an-agent-name-long-enough-to-wrap-at-high-zoom'
  const n: CanvasNode = {
    id, state: 'live', tier: 'haiku', model_id: 'haiku', children: [], parent: 'superior',
    seat: 1, grant: 4, free: 1, cost_usd: 12.34,
    occupancy: 85000, context_window: 100000,
    scope: { tools: { mcp: ['alpha'] }, add_dirs: [] },
    audiences_held: ['@user', '@extern', 'very-long-audience-name-that-must-wrap'],
    last_status: { status: 'working', summary: 'still working', at: '2026-09-01T10:00:00Z' },
    busy: true, waiting: false, responding: true, inflight_at: '2026-09-01T10:00:00Z',
    proc_live: true, proc_warm: false, proc_relaunch: true,
    proc_relaunch_reason: 'identity-changed — system prompt changed',
    mcp_tool_count: 12, last_turn_mcp_tool_count: 9,
    mcp_tool_count_provider: 'claude', mcp_tool_count_source: 'system/init.tools',
    cache_forecast: {
      generation: 'g', state: 'known_incompatible', reason: 'tools changed',
      // D-226: a real payload carries the readiness triple, and the badge
      // renders THAT. Without it this row is `internal_error` grey and the
      // send-warning below cannot fire at all — the fixture would silently
      // stop exercising the thing this test is about.
      readiness: 'not_ready', readiness_cause: 'prefix_changed',
      source: 'identity', lane: 'subscription', last_receipt_at: '2026-09-01T10:00:00Z',
      ttl_seconds: 3600, expires_at: '2026-09-01T11:00:00Z',
      changed_inputs: ['callable tools'], precompact_action: 'miss_expected',
      precompact_reason: 'below threshold',
    },
    queued: 7, ran_as_label: 'fallback 2 · safe-label',
  }
  const superior: CanvasNode = {
    id: 'superior', state: 'live', tier: 'sonnet', model_id: 'sonnet', children: [n],
    seat: 2, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  }
  const view = await mountView(
    <DeskChat node={n} map={new Map([[id, n], ['superior', superior]])}
      op={op} slug="header" toast={noop} pub={false} bare onJump={noop} />,
    (el) => el,
  )
  t.after(() => view.unmount())
  await flush()
  const head = view.el.querySelector('.cc-head')!
  const top = head.querySelector(':scope > .cc-head-top')!
  const meta = head.querySelector(':scope > .cc-head-meta')!
  assert.ok(top && meta)
  for (const sel of ['.tier', '.cc-name', '.cc-actions', '.cc-tabs', '.cc-icon']) {
    assert.ok(top.querySelector(sel), `top row omitted ${sel}`)
  }
  for (const sel of ['.turn-status-banner.working', '.cc-context-seat .ctxwheel',
    '.cc-process-seat .proc-state', '.turn-status-banner .cc-spin']) {
    assert.ok(top.querySelector(sel), `top static slot omitted ${sel}`)
  }
  assert.deepEqual([...top.children].map((el) => el.classList[0]), [
    'cc-head-left', 'spacer', 'cc-head-right',
  ], 'top row is not left group, one spacer, then right group')
  const left = top.querySelector('.cc-head-left')!
  const right = top.querySelector('.cc-head-right')!
  assert.deepEqual([...left.children].map((el) => el.classList[0]), [
    'tier', 'cc-name', 'cc-context-seat', 'cc-process-seat', 'turn-status-banner',
  ], 'left information group changed order')
  assert.deepEqual([...right.children].map((el) => el.classList[0]), [
    'cc-actions', 'cc-tabs', 'cc-icon',
  ], 'right action group changed order')
  assert.equal(right.querySelectorAll('.cc-actions button').length, 1)
  // chat · history · files · inbox · progress (FR-2, 2026-09-04)
  assert.equal(top.querySelectorAll('.cc-tabs button').length, 5)
  for (const sel of [
    '.mcp-tool-count', '.cache-forecast', '.badge',
  ]) assert.ok(meta.querySelector(sel), `metadata row omitted ${sel}`)
  // User ruling 2026-09-03: mid-turn the red cache card and the process mark's
  // yellow relaunch icon are ONE fact — the sent prefix has moved — seen by two
  // owners (the cache projection and the process lifecycle). This fixture is
  // busy with a changed prefix and a pending relaunch; both must render, and
  // the card must be the yellow steer warning: mid-turn it is that or nothing,
  // never the red that promises a miss (user, 2026-09-03 10:36Z).
  assert.ok(meta.querySelector('.cache-forecast.steer'),
    'mid-turn card on a changed prefix is not the yellow steer warning')
  assert.equal(meta.querySelector('.cache-forecast.cold'), null,
    'mid-turn card wore red')
  assert.ok(top.querySelector('.proc-state .proc-relaunch'),
    'relaunch icon missing while the mid-turn steer card shows')
  assert.equal(meta.querySelector('.statuschip.working'), null,
    'durable working summary duplicated the live Working banner')
  assert.match(top.querySelector('.turn-status-banner')?.getAttribute('title') ?? '',
    /still working/, 'duplicate durable summary was not preserved in the banner tooltip')
  for (const sel of ['.ctxwheel', '.proc-state', '.turn-status-banner', '.turnago']) {
    assert.equal(meta.querySelector(sel), null, `metadata duplicates ${sel}`)
  }
  assert.equal(head.querySelectorAll('.proc-state').length, 1)
  assert.equal(head.querySelectorAll('.ctxwheel').length, 1)
  assert.equal(head.querySelectorAll('.turn-status-banner').length, 1)
  assert.equal(head.querySelectorAll('.proc-state .proc-mark').length, 0,
    'the desk header still renders separate live and warm lights')
  assert.equal(top.querySelector('.mcp-tool-count'), null)
  assert.equal(top.querySelector('.cache-forecast'), null)
  // This desk is `busy: true`, i.e. mid-turn, and mounts `bare` so the
  // composer does not autofocus. Both facts matter now:
  //   · the ORIGINAL red "miss" banner is suppressed mid-turn — a send steers
  //     into the running turn and cannot miss;
  //   · the mid-turn steer-window banner needs a FOCUSED composer, so nothing
  //     renders until the user is actually composing something to send.
  assert.equal(view.el.querySelector('.cache-send-warning'), null,
    'a mid-turn desk with an unfocused composer must show no send warning')
  // Focusing the composer is what makes the warning appear, and it must
  // appear ABOVE the composer rather than in the header — the layout contract
  // this test has always been about.
  const ta = view.el.querySelector('textarea')
  assert.ok(ta, 'composer textarea missing')
  ta!.focus()
  await flush()
  const warn = view.el.querySelector('.cache-send-warning.midturn')
  assert.ok(warn, 'mid-turn cache warning is not attached above the composer')
  assert.equal(view.el.querySelector('.cache-send-warning.miss'), null,
    'the red send-time banner must not fire mid-turn')
  assert.equal(head.querySelector('.cache-send-warning'), null,
    'the send warning leaked into the header')
  assert.ok(head.nextElementSibling?.classList.contains('desk-nav'),
    'superior jump strip is not the distinct row immediately after header metadata')
})

test('fresh desk preserves empty context, off process, and neutral Idle banner', async (t) => {
  const server = new FakeServer()
  server.occupancy = null
  installFetch(server)
  const id = 'fresh-agent'
  const n: CanvasNode = {
    id, state: 'live', tier: 'haiku', model_id: 'haiku', children: [],
    seat: 1, grant: 0, free: 0, context_window: 200_000,
    scope: { tools: {}, add_dirs: [] },
    proc_live: false, proc_warm: false,
  }
  const view = await mountView(
    <DeskChat node={n} map={new Map([[id, n]])} op={op} slug="fresh"
      toast={noop} pub={false} bare />,
    (el) => el,
  )
  t.after(() => view.unmount())
  await flush()
  const top = view.el.querySelector('.cc-head-top')!
  assert.match(top.querySelector('.ctxwheel')?.getAttribute('aria-label') ?? '',
    /context: empty — no completed turn has measured this session yet/)
  assert.equal(top.querySelector('.ctxbtn'), null,
    'fresh empty session received a dead compact action')
  assert.ok(top.querySelector('.proc-state.off'),
    'fresh no-process state did not occupy the process slot')
  const banner = top.querySelector('.turn-status-banner.idle')!
  assert.equal(banner.textContent, 'Idle—')
  assert.equal(top.querySelector('.turnago'), null)
  assert.equal(banner.querySelector('svg,.cc-spin'), null)
})

test('desk cost badge distinguishes unresolved zero and positive estimates', async () => {
  installFetch(new FakeServer())
  const render = async (cost: number) => {
    const n = {
      id: `cost-${cost}`, state: 'live', tier: 'haiku', model_id: 'haiku',
      children: [], seat: 1, grant: 0, free: 0, cost_usd: cost,
      cost_usd_unknown: true, scope: { tools: {}, add_dirs: [] },
      turns: [{ at: '2026-09-05T01:00:00Z', cost, denials: 0,
        estimated: true, cost_complete: false, cost_source: 'catalog-snapshot',
        cost_unknown_fields: ['cache_read'] }],
    } as CanvasNode
    const view = await mountView(
      <DeskChat node={n} map={new Map([[n.id, n]])} op={op} slug={n.id}
        toast={noop} pub={false} bare />, (el) => el)
    await flush()
    return view
  }
  const zero = await render(0)
  try {
    const badge = [...zero.el.querySelectorAll<HTMLElement>('.cc-head-meta .badge')]
      .find((b) => b.textContent?.includes('$'))
    assert.equal(badge?.textContent, '$?')
    assert.match(badge?.title ?? '', /catalog-snapshot · unresolved: cache_read/)
  } finally { await zero.unmount() }
  const positive = await render(1.25)
  try {
    const badge = [...positive.el.querySelectorAll<HTMLElement>('.cc-head-meta .badge')]
      .find((b) => b.textContent?.includes('$'))
    assert.equal(badge?.textContent, '$1.25 estimated\/incomplete')
  } finally { await positive.unmount() }
})

test('the MCP badge is absent for zero configured servers, not zero or unknown', async (t) => {
  installFetch(new FakeServer())
  // Case 1: no MCP servers granted at all — a claim about nothing that
  // exists. Even a stray runtime count (which should never happen on a
  // node with no grant) must not resurrect the badge.
  const noneId = 'no-mcp-agent'
  const none: CanvasNode = {
    id: noneId, state: 'live', tier: 'haiku', model_id: 'haiku', children: [],
    seat: 1, grant: 0, free: 0, scope: { tools: { mcp: [] }, add_dirs: [] },
    mcp_tool_count: 0, last_turn_mcp_tool_count: 0,
  }
  const noneView = await mountView(
    <DeskChat node={none} map={new Map([[noneId, none]])} op={op} slug={noneId}
      toast={noop} pub={false} bare />,
    (el) => el,
  )
  t.after(() => noneView.unmount())
  await flush()
  assert.equal(noneView.el.querySelector('.mcp-tool-count'), null,
    'a node with an empty MCP grant rendered a badge for tools it does not have')

  // Case 2: servers ARE configured but the runtime surface has not been
  // snapshotted yet (no live count, no last-turn count) — "not yet known"
  // is a different claim from "not configured", so the badge stays and
  // must read unknown, never assert a zero it has no evidence for.
  const pendingId = 'pending-mcp-agent'
  const pending: CanvasNode = {
    id: pendingId, state: 'live', tier: 'haiku', model_id: 'haiku', children: [],
    seat: 1, grant: 0, free: 0, scope: { tools: { mcp: ['alpha'] }, add_dirs: [] },
    mcp_tool_count: null, last_turn_mcp_tool_count: null,
  }
  const pendingView = await mountView(
    <DeskChat node={pending} map={new Map([[pendingId, pending]])} op={op} slug={pendingId}
      toast={noop} pub={false} bare />,
    (el) => el,
  )
  t.after(() => pendingView.unmount())
  await flush()
  const mark = pendingView.el.querySelector('.mcp-tool-count')
  assert.ok(mark, 'a configured but not-yet-snapshotted node hid the badge outright')
  assert.match(mark!.textContent ?? '', /MCP\s+—/,
    'an unsnapshotted surface must read unknown, never a definitive zero')
})

test('layout CSS wraps naturally and pins finite controls above metadata', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.cc-head\s*\{[^}]*flex-direction:\s*column/s)
  assert.match(css, /\.cc-head\s*\{[^}]*container-type:\s*inline-size/s)
  assert.match(css, /\.cc-head-top\s*\{[^}]*flex-wrap:\s*wrap/s)
  assert.match(css, /\.cc-head-top\s*\{[^}]*justify-content:\s*flex-start/s)
  assert.match(css, /\.cc-head-meta\s*\{[^}]*flex-wrap:\s*wrap/s)
  assert.match(css, /\.cc-tabs button\s*\{[^}]*min-height:\s*24px/s)
  assert.match(css, /\.cc-actions button\s*\{[^}]*min-height:\s*24px/s)
  assert.match(css, /\.cc-head-left\s*\{[^}]*flex-wrap:\s*nowrap[^}]*gap:\s*2px/s)
  assert.match(css, /\.cc-head-right\s*\{[^}]*flex-wrap:\s*nowrap[^}]*gap:\s*6px/s)
  assert.match(css, /\.cc-head-top > \.spacer\s*\{[^}]*flex:\s*1 1 12px/s)
  assert.match(css, /@container \(min-width:\s*600px\)\s*\{\s*\.cc-head-top\s*\{[^}]*flex-wrap:\s*nowrap/s)
  assert.match(css, /@container \(max-width:\s*599px\)[\s\S]*\.cc-head-right\s*\{[^}]*overflow-x:\s*auto/s)
  assert.match(css, /\.turn-status-banner\s*\{[^}]*min-width:\s*72px/s)
  assert.match(css, /\.turn-status-banner\s*\{[^}]*padding:\s*0;/s)
  assert.match(css, /\.turn-status-banner\s*\{[^}]*border:\s*0;/s)
  assert.match(css, /\.turn-status-banner\s*\{[^}]*background:\s*transparent/s)
  assert.match(css, /\.turn-status-banner\.idle\s*\{[^}]*color:\s*var\(--dim\)/s)
  assert.doesNotMatch(css, /\.turn-status-banner\.idle\s*\{[^}]*animation:/s)
  assert.match(css, /\.cc-context-seat\s*\{[^}]*width:\s*24px/s)
  assert.match(css, /\.cc-process-seat\s*\{[^}]*width:\s*auto[^}]*min-width:\s*16px[^}]*margin-inline:\s*-2px/s)
  assert.match(css, /\.cc-context-seat \.ctxbtn\s*\{[^}]*min-width:\s*24px/s)
  assert.match(css, /\.cc-head-left > \.tier\s*\{[^}]*margin-inline-end:\s*2px/s)
  assert.match(css, /\.cc-head-left > \.cc-name\s*\{[^}]*flex:\s*0 1 auto/s)
  assert.match(css, /\.cc-name\s*\{[^}]*overflow-wrap:\s*anywhere/s)
  assert.doesNotMatch(css, /\.eye-chat \.cc-name\s*\{[^}]*text-overflow:\s*ellipsis/s)
  assert.doesNotMatch(topLevelHeaderCss(css), /margin-(?:left|right):\s*auto/)
})

test('queued or compacting desks keep an unclaimed live process on standby', async (t) => {
  installFetch(new FakeServer())
  for (const extra of [{ waiting: true }, { phase: 'compacting' as const }]) {
    const id = extra.waiting ? 'queued-agent' : 'compacting-agent'
    const n: CanvasNode = {
      id, state: 'live', tier: 'terra', model_id: 'terra', children: [],
      seat: 2, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
      proc_live: true, proc_warm: true, busy: false, ...extra,
    }
    const view = await mountView(
      <DeskChat node={n} map={new Map([[id, n]])} op={op} slug={id}
        toast={noop} pub={false} bare />,
      (el) => el,
    )
    t.after(() => view.unmount())
    await flush()
    assert.ok(view.el.querySelector('.proc-state.standby.prov-openai'),
      `${id} falsely presented its parked CLI as currently used`)
    assert.equal(view.el.querySelector('.proc-state.active'), null)
  }
})

test('switchboard header stays a horizontal surface independent of desk chrome', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const cards = readFileSync(path.join(__SRC_DIR__, 'canvas', 'cards.tsx'), 'utf8')
  assert.match(cards, /<div className="eye-head">/,
    'switchboard header is not rendered with its dedicated layout class')
  assert.doesNotMatch(cards, /className="cc-head eye-head"/,
    'switchboard inherited the desk header column layout again')
  assert.match(css,
    /\.eye-head\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*row[^}]*align-items:\s*center/s,
    'switchboard header no longer guarantees one horizontal eye/tab/action row')
})

function topLevelHeaderCss(css: string) {
  return [...css.matchAll(/\.(?:cc-head-top|cc-head-left|cc-head-right)[^{]*\{[^}]*\}/gs)]
    .map((m) => m[0]).join('\n')
}
