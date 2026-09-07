// turnspinner.test.tsx — active agent turns throughout the app must use
// spinning arrows (.cc-spin / DestinationBusy), visible only while the agent
// is actually in a turn (node.busy). Zoomed-out agent cards (NodeSquare,
// mapMode) and the bottom-left agent tray must not mount CLI process dots
// (.proc-state), which were mistaken for active turns. Outside an actual turn,
// recorded non-idle state (working, blocked, etc.) is displayed using its
// appropriate state color, but must never show active-turn spinning arrows.
// The context wheel sits to the left of zoom-view state text, matching desk view.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeSquare } from '../src/canvas/cards'
import {
  Activity, AgentWorkstate, deriveTurnState, DestinationBusy, MapTurnAge,
  ProcessLifecycleMark, pulseAgeClock, TrayStatus, TurnStatusBanner,
} from '../src/canvas/desk'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({ ok: true } as any)
const toast = () => {}
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10,
  'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, flash: 1, pro: 2 }
const hire = { enabled: true, installed: true, reason: null }

function makeNode(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'test-agent',
    title: 'test-agent',
    state: 'live',
    tier: 'haiku',
    model_id: 'haiku',
    proc_warm: true,
    proc_live: true,
    proc_relaunch: false,
    proc_relaunch_reason: null,
    busy: false,
    waiting: false,
    children: [],
    seat: 1,
    grant: 0,
    free: 0,
    occupancy: 500,
    context_window: 1000,
    scope: { tools: {}, add_dirs: [] },
    ...overrides,
  }
}

function renderCard(node: CanvasNode, mapMode = false) {
  return mountView(
    <NodeSquare
      node={node}
      pos={{ x: 0, y: 0 }}
      lod={mapMode ? 'map' : 'norm'}
      mapMode={mapMode}
      focused={false}
      dragging={false}
      isDrop={false}
      seats={seats}
      codexHire={hire}
      antigravityHire={hire}
      claudeHire={hire}
      map={new Map([[node.id, node]])}
      op={op}
      slug="org"
      toast={noop}
      pxc={1}
      zoom={1}
      compactAt={0.8}
      pub={false}
      maxTop={0}
      kioskRemaining={null}
      cascadeAlloc
      onSpawn={noop}
      onSpawnSide={noop}
      onSpawnTop={noop}
      onConfig={noop}
      onInbox={noop}
      onLineage={noop}
      onOpenDoc={noop}
      onRecenter={noop}
      onJump={noop}
      onMailLink={noop}
      onDragStart={noop}
      onDragMove={noop}
      onDragEnd={noop}
      onDragCancel={noop}
    />,
    (el) => el
  )
}

function makeTree(nodes: CanvasNode[]): TreePayload {
  const mk = (n: CanvasNode) => ({
    id: n.id,
    title: n.title || n.id,
    tier: n.tier || 'haiku',
    model_id: n.model_id || 'haiku',
    state: n.state || 'live',
    seat: 1,
    grant: 0,
    free: 0,
    ui_order: 0,
    cost_usd: 0,
    occupancy: null,
    context_window: null,
    charter: null,
    mail_pending: 0,
    limit_locked: false,
    last_status: n.last_status ?? null,
    prev_status: null,
    inflight_at: n.inflight_at ?? null,
    last_denials: [],
    turns: n.turns ?? [],
    frozen: n.frozen ?? null,
    audiences_held: [],
    bearer_state: null,
    generation: 0,
    children: [],
    lineage: [],
    proc_warm: n.proc_warm,
    proc_live: n.proc_live,
    proc_relaunch: n.proc_relaunch,
    proc_relaunch_reason: n.proc_relaunch_reason,
    busy: n.busy,
    waiting: n.waiting,
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  })
  return {
    slug: 'org',
    name: 'org',
    workspace: null,
    dirs: [],
    max_top_grant: 1000,
    default_top_grant: 50,
    compact_at: 0,
    default_tools: null,
    default_visibility: 'team',
    default_effort: '',
    credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10, terra: 2, flash: 1 },
    audiences: [],
    roots: nodes.map(mk),
    cost_usd_total: 0,
    audit: { live_nodes: nodes.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0,
    user_inbox_newest: null,
    fable_lock: null,
    spend_frozen: false,
    storage_blocked: false,
    auto_resume: false,
    fable_limit_policy: 'freeze',
    fable_filter_policy: 'halt',
    cascade_hire: false,
    cascade_alloc: true,
    sandboxed: false,
    audience_requests: [],
    org_inbox: null,
    net: null,
  } as unknown as TreePayload
}

test('NodeSquare: warm idle agent shows no proc-state dot and no spinner, with context wheel left of state text', async (t) => {
  const node = makeNode({ proc_warm: true, busy: false })
  const view = await renderCard(node)
  t.after(() => view.unmount())
  const root = view.el.querySelector('.sq')!
  assert.equal(root.querySelectorAll('.proc-state').length, 0,
    'warm idle card must not render .proc-state')
  assert.equal(root.querySelectorAll('.cc-spin').length, 0,
    'warm idle card must not render .cc-spin')

  const meta = root.querySelector('.sq-meta')!
  const firstChild = meta.firstElementChild
  assert.ok(firstChild?.classList.contains('ctxwheel'),
    'context wheel is placed left of state text in sq-meta')
})

test('NodeSquare: recorded state outside turn displays state text and idle time without spinning arrow', async (t) => {
  const node = makeNode({
    busy: false,
    last_status: { status: 'working', summary: 'recorded working state' } as any,
  })
  const view = await renderCard(node)
  t.after(() => view.unmount())
  const root = view.el.querySelector('.sq')!
  const idleWord = root.querySelector('.sq-idle')
  assert.ok(idleWord, '.sq-idle mounted')
  assert.equal(idleWord.textContent, 'Working', 'displays recorded non-idle state, Title Case like the desk banner')
  assert.ok(idleWord.classList.contains('working'), 'has appropriate state class')
  assert.equal(root.querySelectorAll('.cc-spin').length, 0,
    'recorded working outside a turn must never show active-turn spinning arrow')
})

test('NodeSquare: active turn renders spinning arrow on the left, active text, and elapsed turn time', async (t) => {
  const claudeNode = makeNode({
    id: 'claude',
    tier: 'haiku',
    busy: true,
    inflight_at: new Date(Date.now() - 30_000).toISOString(),
  })
  const codexNode = makeNode({
    id: 'codex',
    tier: 'terra',
    busy: true,
    inflight_at: new Date(Date.now() - 60_000).toISOString(),
  })
  const agyNode = makeNode({
    id: 'agy',
    tier: 'flash',
    busy: true,
    inflight_at: new Date(Date.now() - 90_000).toISOString(),
  })

  for (const [n, prov] of [[claudeNode, 'prov-claude'], [codexNode, 'prov-openai'], [agyNode, 'prov-google']] as const) {
    const view = await renderCard(n)
    t.after(() => view.unmount())
    const root = view.el.querySelector('.sq')!
    assert.equal(root.querySelectorAll('.proc-state').length, 0,
      'active card does not mount .proc-state')
    const seat = root.querySelector('.sq-workstate')!
    assert.ok(seat, '.sq-workstate mounted')
    const destSpin = seat.querySelector(`.cc-spin.${prov}`)
    assert.ok(destSpin, `destination spinner in meta has ${prov} color class`)
    assert.equal(seat.firstElementChild, destSpin, 'spinning arrow must be on the left of sq-workstate')
    const workWord = seat.querySelector('.sq-idle.working')
    assert.ok(workWord, 'literal working text element mounted')
    assert.equal(workWord.textContent, 'Active', 'literal executing-turn text rendered, Title Case like the desk banner')
    const time = seat.querySelector('.sq-idle-time')
    assert.ok(time, 'elapsed turn time mounted')
    assert.match(time.textContent ?? '', /\d|—/, 'elapsed turn time rendered')
    // and no trailing DestinationBusy
    assert.equal(root.querySelectorAll('.cc-spin').length, 1,
      'only one spinning arrow mounted inside sq-workstate')
  }
})

test('mapMode: warm idle agent shows no proc-state and no spinner, retains recorded state dot and idle time', async (t) => {
  const node = makeNode({
    proc_warm: true,
    busy: false,
    last_status: { status: 'working', summary: 'finished turn' } as any,
    turns: [{ at: new Date(Date.now() - 120_000).toISOString(), killed: false, cost: 0, denials: 0 }],
  })
  const view = await renderCard(node, true)
  t.after(() => view.unmount())
  const root = view.el.querySelector('.maplod')!
  assert.ok(root, '.maplod root mounted')
  assert.equal(root.querySelectorAll('.proc-state').length, 0, 'no proc-state in mapMode')
  assert.equal(root.querySelectorAll('.cc-spin').length, 0, 'no cc-spin in mapMode when idle')
  assert.equal(root.querySelectorAll('.statusdot.working').length, 1,
    'recorded status dot shown outside turn')
  const mapAgo = root.querySelector('.map-ago')
  assert.ok(mapAgo, 'map-ago rendered for idle agent')
  assert.match(mapAgo.textContent ?? '', /\d/, 'map-ago contains idle time number')
})

test('mapMode: active turn renders spinning arrow and elapsed turn time', async (t) => {
  const busyNode = makeNode({
    tier: 'haiku',
    busy: true,
    waiting: false,
    inflight_at: new Date(Date.now() - 40_000).toISOString(),
  })
  const waitingNode = makeNode({ tier: 'haiku', busy: true, waiting: true })

  const busyView = await renderCard(busyNode, true)
  t.after(() => busyView.unmount())
  assert.ok(busyView.el.querySelector('.map-top .cc-spin.prov-claude'),
    'busy mapMode renders destination spinning arrow')
  const agoEl = busyView.el.querySelector('.map-ago')
  assert.ok(agoEl, 'busy mapMode renders map-ago with elapsed turn time')
  assert.match(agoEl.textContent ?? '', /\d|—/, 'map-ago contains elapsed time')

  const waitingView = await renderCard(waitingNode, true)
  t.after(() => waitingView.unmount())
  assert.equal(waitingView.el.querySelectorAll('.cc-spin').length, 0,
    'waiting mapMode does not render spinner')
  assert.ok(waitingView.el.querySelector('.statusdot.waiting'),
    'waiting mapMode renders waiting statusdot')
})

test('OrgCanvas tray-main: idle shows status and idle time; active turn shows spinner, active label, and elapsed time', async (t) => {
  const idleNode = makeNode({
    id: 'idle-agent',
    proc_warm: true,
    busy: false,
    last_status: { status: 'working', summary: 'recorded state' } as any,
    turns: [{ at: new Date(Date.now() - 300_000).toISOString(), killed: false, cost: 0, denials: 0 }],
  })
  const activeNode = makeNode({
    id: 'active-agent',
    tier: 'terra',
    busy: true,
    waiting: false,
    inflight_at: new Date(Date.now() - 50_000).toISOString(),
  })
  const queuedNode = makeNode({
    id: 'queued-agent',
    tier: 'haiku',
    busy: true,
    waiting: true,
  })

  const tree = makeTree([idleNode, activeNode, queuedNode])
  const view = await mountView(
    <OrgCanvas
      tree={tree}
      op={op}
      slug="org"
      toast={toast}
      mailEvt={null}
    />,
    (el) => el
  )
  t.after(() => view.unmount())
  await flush()

  const toggle = view.el.querySelector('.tray-toggle') as HTMLElement
  assert.ok(toggle, 'tray toggle button found')
  await inAct(() => { toggle.click() })
  await flush()

  const trayButtons = [...view.el.querySelectorAll<HTMLButtonElement>('.tray-main')]
  assert.equal(trayButtons.length, 3, 'mounted 3 tray rows')

  // Row 0: idle agent
  assert.equal(trayButtons[0]!.querySelectorAll('.proc-state').length, 0,
    'idle tray row must not have proc-state')
  assert.equal(trayButtons[0]!.querySelectorAll('.cc-spin').length, 0,
    'idle tray row must not have cc-spin')
  assert.ok(trayButtons[0]!.querySelector('.statusdot.working'),
    'idle tray row shows recorded status dot without spinner')
  const idleLabel = trayButtons[0]!.querySelector('.tray-status-label')
  assert.ok(idleLabel, 'idle tray row has status label')
  assert.equal(idleLabel.textContent, 'Working', 'idle tray row shows recorded state, Title Case')
  const idleTime = trayButtons[0]!.querySelector('.tray-status-time')
  assert.ok(idleTime, 'idle tray row has idle elapsed time')
  assert.match(idleTime.textContent ?? '', /\d/, 'idle elapsed time has number')

  // Row 1: active agent
  assert.equal(trayButtons[1]!.querySelectorAll('.proc-state').length, 0,
    'active tray row must not have proc-state')
  const activeSpinner = trayButtons[1]!.querySelector('.cc-spin.prov-openai')
  assert.ok(activeSpinner, 'active tray row has cc-spin with prov-openai color')
  const activeLabel = trayButtons[1]!.querySelector('.tray-status-label.working')
  assert.ok(activeLabel, 'active tray row has working status label')
  assert.equal(activeLabel.textContent, 'Active', 'active tray row label is Active (the executing turn), Title Case')
  const activeTime = trayButtons[1]!.querySelector('.tray-status-time')
  assert.ok(activeTime, 'active tray row has elapsed turn time')
  assert.match(activeTime.textContent ?? '', /\d|—/, 'active turn time rendered')

  // Row 2: queued waiting agent
  assert.equal(trayButtons[2]!.querySelectorAll('.cc-spin').length, 0,
    'queued tray row must not have cc-spin')
  assert.ok(trayButtons[2]!.querySelector('.statusdot.waiting'),
    'queued tray row has waiting dot')
})

test('TurnStatusBanner in desk header: displays recorded non-idle state without spinner outside turn, and themed spinner when active', async () => {
  const stamp = { at: '2026-09-06T19:00:00Z', cost_usd: 0, killed: false }

  // Idle with recorded 'working'
  const workingView = await mountView(
    <TurnStatusBanner state="idle" turn={stamp} recordedState="working" tier="haiku" />,
    (el) => el
  )
  try {
    const banner = workingView.el.querySelector('.turn-status-banner')!
    assert.ok(banner.classList.contains('working'), 'has working class')
    assert.equal(banner.querySelector('.turn-status-label')?.textContent, 'Working')
    assert.equal(banner.querySelectorAll('.cc-spin').length, 0,
      'recorded working outside turn must not render spinning arrow')
    assert.ok(banner.querySelector('.turn-status-time'), 'renders time element')
  } finally {
    workingView.unmount()
  }

  // Idle with recorded 'blocked'
  const blockedView = await mountView(
    <TurnStatusBanner state="idle" turn={stamp} recordedState="blocked" tier="terra" />,
    (el) => el
  )
  try {
    const banner = blockedView.el.querySelector('.turn-status-banner')!
    assert.ok(banner.classList.contains('blocked'), 'has blocked class')
    assert.equal(banner.querySelector('.turn-status-label')?.textContent, 'Blocked')
    assert.equal(banner.querySelectorAll('.cc-spin').length, 0,
      'recorded blocked outside turn must not render spinning arrow')
  } finally {
    blockedView.unmount()
  }

  // Active working turn
  const activeView = await mountView(
    <TurnStatusBanner state="working" inflightAt="2026-09-06T19:00:00Z" tier="terra" />,
    (el) => el
  )
  try {
    const banner = activeView.el.querySelector('.turn-status-banner')!
    assert.ok(banner.classList.contains('working'))
    assert.equal(banner.querySelector('.turn-status-label')?.textContent, 'Active',
      'an EXECUTING turn is Active; Working is reserved for the agent-reported status (line above)')
    const spin = banner.querySelector('.cc-spin.prov-openai')
    assert.ok(spin, 'active turn renders spinning arrow themed with destination provider')
    const time = banner.querySelector('.turn-status-time')
    assert.ok(time, 'active turn renders elapsed time')
  } finally {
    activeView.unmount()
  }
})

test('explicit diagnostic process cue is preserved in desk header', async () => {
  const view = await mountView(
    <div className="cc-process-seat">
      <ProcessLifecycleMark warm live tier="haiku" />
    </div>,
    (el) => el
  )
  try {
    assert.equal(view.el.querySelectorAll('.proc-state').length, 1,
      'explicit diagnostic seat in desk header mounts proc-state')
    assert.equal(view.el.querySelectorAll('.proc-state.standby').length, 1)
  } finally {
    view.unmount()
  }
})

test('Activity component renders spinning arrow and active text without gears or tool names', async () => {
  const dotView = await mountView(
    <Activity dotOnly tier="terra" />,
    (el) => el
  )
  try {
    assert.ok(dotView.el.querySelector('.cc-spin.prov-openai'), 'dotOnly renders themed spinning arrow')
    assert.equal(dotView.el.querySelectorAll('.actgear').length, 0, 'no actgear')
    assert.equal(dotView.el.querySelectorAll('.actdots').length, 0, 'no actdots')
  } finally {
    dotView.unmount()
  }

  const fullView = await mountView(
    <Activity tier="haiku" />,
    (el) => el
  )
  try {
    assert.ok(fullView.el.querySelector('.actlabel'), 'renders .actlabel container')
    assert.ok(fullView.el.querySelector('.cc-spin.prov-claude'), 'renders themed spinning arrow')
    assert.equal(fullView.el.querySelector('.actlabel-text')?.textContent, 'Active', 'renders literal Active text')
    assert.equal(fullView.el.querySelectorAll('.actgear').length, 0, 'no actgear')
    assert.equal(fullView.el.querySelectorAll('.actdots').length, 0, 'no actdots')
  } finally {
    fullView.unmount()
  }
})

test('pulseAgeClock advances elapsed turn times across banner, square, map, and tray without props changing', async () => {
  const baseEpoch = Date.parse('2026-09-06T12:00:00Z')
  let mockNow = baseEpoch + 10_000 // 10s elapsed
  const origNow = Date.now
  Date.now = () => mockNow

  try {
    const node = makeNode({
      busy: true,
      inflight_at: '2026-09-06T12:00:00Z',
    })

    const view = await mountView(
      <div>
        <TurnStatusBanner state="working" inflightAt={node.inflight_at} tier="haiku" />
        <div className="sq-workstate">
          <AgentWorkstate node={node} />
        </div>
        <MapTurnAge node={node} />
        <TrayStatus node={node} />
      </div>,
      (el) => el
    )

    try {
      assert.equal(view.el.querySelector('.turn-status-time')?.textContent, '10s')
      assert.equal(view.el.querySelector('.sq-idle-time')?.textContent, '10s')
      assert.equal(view.el.querySelector('.map-ago')?.textContent, '10s')
      assert.equal(view.el.querySelector('.tray-status-time')?.textContent, '10s')

      // Advance clock by 15 seconds (total 25s elapsed)
      mockNow += 15_000
      await inAct(async () => {
        pulseAgeClock()
        await flush()
      })

      // Check all 4 views updated their text without any props re-render
      assert.equal(view.el.querySelector('.turn-status-time')?.textContent, '25s')
      assert.equal(view.el.querySelector('.sq-idle-time')?.textContent, '25s')
      assert.equal(view.el.querySelector('.map-ago')?.textContent, '25s')
      assert.equal(view.el.querySelector('.tray-status-time')?.textContent, '25s')
    } finally {
      view.unmount()
    }
  } finally {
    Date.now = origNow
  }
})

test('NodeSquare and mapMode render queued and compacting even when node.busy is false', async () => {
  // 1. Queued agent with busy=false, waiting=true
  const queuedNode = makeNode({
    id: 'queued-agent',
    busy: false,
    waiting: true,
    inflight_at: new Date(Date.now() - 30_000).toISOString(),
    last_status: { status: 'working', summary: 'old recorded work', at: '' },
  })

  const queuedCard = await renderCard(queuedNode, false)
  const queuedMap = await renderCard(queuedNode, true)

  try {
    // In NodeSquare:
    const seat = queuedCard.el.querySelector('.sq-workstate')
    assert.ok(seat, '.sq-workstate mounted')
    assert.equal(seat.querySelectorAll('.cc-spin').length, 0, 'queued card has no spinning arrow')
    assert.ok(seat.querySelector('.statusdot.waiting'), 'queued card has waiting status dot')
    const word = seat.querySelector('.sq-idle.waiting')
    assert.ok(word, 'queued card has .sq-idle.waiting word')
    assert.equal(word.textContent?.trim(), 'Queued', 'queued card says Queued, not old recorded working')
    const time = seat.querySelector('.sq-idle-time')
    assert.ok(time, 'queued card has elapsed time')

    // In mapMode:
    assert.equal(queuedMap.el.querySelectorAll('.cc-spin').length, 0, 'queued map has no spinning arrow')
    assert.ok(queuedMap.el.querySelector('.statusdot.waiting'), 'queued map has waiting status dot')
    assert.ok(queuedMap.el.querySelector('.map-ago'), 'queued map renders active elapsed time (map-ago)')
  } finally {
    await queuedCard.unmount()
    await queuedMap.unmount()
  }

  // 2. Compacting agent with busy=false, phase='compacting'
  const compactingNode = makeNode({
    id: 'compacting-agent',
    busy: false,
    phase: 'compacting',
    inflight_at: new Date(Date.now() - 40_000).toISOString(),
    last_status: { status: 'done', summary: 'old done', at: '' },
  })

  const compactingCard = await renderCard(compactingNode, false)
  const compactingMap = await renderCard(compactingNode, true)

  try {
    // In NodeSquare:
    const seat = compactingCard.el.querySelector('.sq-workstate')
    assert.ok(seat, '.sq-workstate mounted')
    assert.equal(seat.querySelectorAll('.cc-spin').length, 0, 'compacting card has no spinning arrow')
    const word = seat.querySelector('.sq-idle.compacting')
    assert.ok(word, 'compacting card has .sq-idle.compacting word')
    assert.equal(word.textContent?.trim(), 'Compacting')

    // In mapMode:
    assert.equal(compactingMap.el.querySelectorAll('.cc-spin').length, 0, 'compacting map has no spinning arrow')
    assert.ok(compactingMap.el.querySelector('.statusdot.compacting'), 'compacting map has compacting status dot')
    assert.ok(compactingMap.el.querySelector('.map-ago'), 'compacting map renders elapsed time')
  } finally {
    await compactingCard.unmount()
    await compactingMap.unmount()
  }
})

test('DeskChat derives turnBannerState from shared deriveTurnState with chat.busy fallback', async () => {
  assert.equal(deriveTurnState({ busy: false, waiting: true }), 'queued')
  assert.equal(deriveTurnState({ busy: false, phase: 'compacting' }), 'compacting')
  assert.equal(deriveTurnState({ busy: false, waiting: false }), 'idle')
  assert.equal(deriveTurnState({ busy: true }), 'working')
  assert.equal(deriveTurnState({ busy: false, waiting: false, phase: null }), 'idle')
  // With chat.busy fallback:
  assert.equal(deriveTurnState({ busy: false || true }), 'working')
})



test('zoom card, tray and desk banner agree on the Title Case word for every state (user 2026-09-07)', async () => {
  const wordOf = async (render: () => Promise<{ el: HTMLElement; unmount: () => void }>, sel: string) => {
    const v = await render()
    try { return v.el.querySelector(sel)?.textContent?.trim() } finally { v.unmount() }
  }
  // reported statuses out of turn: the card word, the tray word and the desk
  // banner word are the SAME string — and it is Title Case
  for (const status of ['working', 'blocked', 'idle', 'done'] as const) {
    const node = makeNode({ busy: false, last_status: { status, summary: 's' } as any })
    const expected = status.charAt(0).toUpperCase() + status.slice(1)
    assert.equal(await wordOf(() => renderCard(node), '.sq-idle'), expected, `card word for ${status}`)
    assert.equal(await wordOf(() => mountView(<TrayStatus node={node} turn={null} />, (el) => el),
      '.tray-status-label'), expected, `tray word for ${status}`)
    assert.equal(await wordOf(() => mountView(
      <TurnStatusBanner state="idle" recordedState={status} tier="haiku" />, (el) => el),
      '.turn-status-label'), expected, `desk word for ${status}`)
  }
  // the executing turn: Active on all three, and the class stays the raw value
  const busy = makeNode({ busy: true, inflight_at: new Date().toISOString() })
  const card = await renderCard(busy)
  try {
    assert.equal(card.el.querySelector('.sq-idle')?.textContent?.trim(), 'Active')
    assert.ok(card.el.querySelector('.sq-idle.working'), 'class names stay the raw value')
  } finally { card.unmount() }
  assert.equal(await wordOf(() => mountView(<TrayStatus node={busy} turn={null} />, (el) => el),
    '.tray-status-label'), 'Active')
  assert.equal(await wordOf(() => mountView(
    <TurnStatusBanner state="working" inflightAt={busy.inflight_at} tier="haiku" />, (el) => el),
    '.turn-status-label'), 'Active')
})

test('Working state gets fixed non-provider styling across providers, while Active in-turn keeps provider theme', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const css = fs.readFileSync(path.resolve('src/styles.css'), 'utf-8')

  // CSS rules verification: Working state gets var(--work) (fixed sky #7cc0ff)
  assert.match(css, /\.sq-idle\.working\s*\{\s*color:\s*var\(--work\);/,
    'sq-idle.working uses fixed var(--work)')
  assert.match(css, /\.turn-status-banner\.working\s*\{\s*color:\s*var\(--work\);/,
    'turn-status-banner.working uses fixed var(--work)')
  assert.match(css, /\.tray-status-label\.working\s*\{\s*color:\s*var\(--work\);/,
    'tray-status-label.working uses fixed var(--work)')

  // Active in-turn rules: Active state uses var(--accent) (provider theme)
  assert.match(css, /\.sq-idle\.working\.active[^{]*\{\s*color:\s*var\(--accent\);/,
    'sq-idle active turn uses var(--accent)')
  assert.match(css, /\.turn-status-banner\.working\.active[^{]*\{\s*color:\s*var\(--accent\);/,
    'turn-status-banner active turn uses var(--accent)')
  assert.match(css, /\.tray-status-label\.working\.active[^{]*\{\s*color:\s*var\(--accent\);/,
    'tray-status-label active turn uses var(--accent)')

  // Across providers: Claude (haiku), OpenAI (terra), Google (flash)
  for (const tier of ['haiku', 'terra', 'flash'] as const) {
    // 1. Out-of-turn with recorded status 'working'
    const idleNode = makeNode({ id: `idle-${tier}`, tier, busy: false, last_status: { status: 'working', summary: 'working on task' } as any })
    const idleCard = await renderCard(idleNode)
    try {
      const el = idleCard.el.querySelector('.sq-idle')
      assert.ok(el, `card mounts sq-idle for ${tier}`)
      assert.equal(el?.textContent?.trim(), 'Working', `card displays Working for ${tier}`)
      assert.ok(el?.classList.contains('working'), `card has working class for ${tier}`)
      assert.ok(!el?.classList.contains('active'), `idle card must not have active class for ${tier}`)
    } finally { idleCard.unmount() }

    const idleTray = await mountView(<TrayStatus node={idleNode} turn={null} />, (el) => el)
    try {
      const label = idleTray.el.querySelector('.tray-status-label')
      assert.ok(label, `tray mounts status label for ${tier}`)
      assert.equal(label?.textContent?.trim(), 'Working', `tray displays Working for ${tier}`)
      assert.ok(label?.classList.contains('working'), `tray has working class for ${tier}`)
      assert.ok(!label?.classList.contains('active'), `idle tray must not have active class for ${tier}`)
      const dot = idleTray.el.querySelector('.statusdot')
      assert.ok(dot?.classList.contains('working'), `tray statusdot has working class for ${tier}`)
    } finally { idleTray.unmount() }

    const stamp = { at: '2026-09-07T12:00:00Z', cost_usd: 0, killed: false }
    const idleBanner = await mountView(
      <TurnStatusBanner state="idle" turn={stamp} recordedState="working" tier={tier} />,
      (el) => el
    )
    try {
      const banner = idleBanner.el.querySelector('.turn-status-banner')
      assert.ok(banner?.classList.contains('working'), `banner has working class for ${tier}`)
      assert.ok(!banner?.classList.contains('active'), `idle banner must not have active class for ${tier}`)
      assert.equal(banner?.querySelector('.turn-status-label')?.textContent, 'Working', `banner displays Working for ${tier}`)
    } finally { idleBanner.unmount() }

    // 2. Active turn (busy: true)
    const activeNode = makeNode({ id: `active-${tier}`, tier, busy: true, inflight_at: new Date().toISOString() })
    const activeCard = await renderCard(activeNode)
    try {
      const el = activeCard.el.querySelector('.sq-idle')
      assert.ok(el, `card mounts sq-idle for active ${tier}`)
      assert.equal(el?.textContent?.trim(), 'Active', `active card displays Active for ${tier}`)
      assert.ok(el?.classList.contains('working'), `active card retains working class for ${tier}`)
      assert.ok(el?.classList.contains('active'), `active card has active class for ${tier}`)
    } finally { activeCard.unmount() }

    const activeTray = await mountView(<TrayStatus node={activeNode} turn={null} />, (el) => el)
    try {
      const label = activeTray.el.querySelector('.tray-status-label')
      assert.ok(label, `tray mounts status label for active ${tier}`)
      assert.equal(label?.textContent?.trim(), 'Active', `active tray displays Active for ${tier}`)
      assert.ok(label?.classList.contains('working'), `active tray retains working class for ${tier}`)
      assert.ok(label?.classList.contains('active'), `active tray has active class for ${tier}`)
    } finally { activeTray.unmount() }

    const activeBanner = await mountView(
      <TurnStatusBanner state="working" inflightAt={activeNode.inflight_at} tier={tier} />,
      (el) => el
    )
    try {
      const banner = activeBanner.el.querySelector('.turn-status-banner')
      assert.ok(banner?.classList.contains('working'), `active banner retains working class for ${tier}`)
      assert.ok(banner?.classList.contains('active'), `active banner has active class for ${tier}`)
      assert.equal(banner?.querySelector('.turn-status-label')?.textContent, 'Active', `active banner displays Active for ${tier}`)
    } finally { activeBanner.unmount() }
  }
})

