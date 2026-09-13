// Focused tests for far-zoom agent-node state-icon redesign (lod === 'mini').
//
// Verifies:
// 1. Singular centered state icon rendered at far zoom.
// 2. Absence of all secondary metadata (agent name, model/tier, state label,
//    timing/duration, badges, generation, limit state, credit bar, context wheel,
//    error dot, action buttons).
// 3. State mapping fidelity for active, working, idle, blocked, halted, frozen,
//    queued, compacting, done, errored, and archived states.
// 4. State transitions: immediate icon update on status change.
// 5. Bounds and interaction preservation: dimensions, click, drag, context menu,
//    and exterior edge controls (hire chips, doc chips).
// 6. Zoom transitions: norm -> mini -> norm cleanly restores normal content.
// 7. Reduced motion accessibility rules in styles.css.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct } from './harness'
import { NodeSquare, FarZoomStateIcon } from '../src/canvas/cards'
import { deriveAgentVisualState } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

declare const __SRC_DIR__: string

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10, flash: 1, pro: 2, terra: 2, sol: 5, luna: .2 }
const hire = { enabled: true, installed: true, reason: null }

function makeNode(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    title: id,
    state: 'live',
    tier: 'haiku',
    model_id: 'haiku',
    seat: 1,
    grant: 0,
    free: 0,
    scope: { tools: {}, add_dirs: [] },
    children: [],
    lineage: [],
    turns: [],
    audiences_held: [],
    bearer_state: null,
    frozen: null,
    limit_locked: false,
    mail_pending: 0,
    last_status: null,
    prev_status: null,
    inflight_at: null,
    last_denials: [],
    occupancy: 500,
    occupancy_est: false,
    context_window: 1000,
    busy: false,
    proc_warm: true,
    proc_live: true,
    proc_relaunch: false,
    proc_relaunch_reason: null,
    isBearerOf: null,
    generation: 1,
    ...extra,
  } as unknown as CanvasNode
}

function renderCard(
  n: CanvasNode,
  lod: 'mini' | 'norm' = 'mini',
  opts: {
    onPin?: () => void
    pinned?: boolean
    onOpenDoc?: (id: string) => void
    onDragStart?: (e: unknown, id: string) => void
  } = {},
) {
  return mountView(
    <NodeSquare
      key={n.id}
      node={n}
      pos={{ x: 100, y: 200 }}
      lod={lod}
      focused={false}
      dragging={false}
      isDrop={false}
      seats={seats}
      codexHire={hire}
      antigravityHire={hire}
      claudeHire={hire}
      map={new Map([[n.id, n]])}
      op={op}
      slug="test-org"
      toast={noop}
      pxc={1}
      zoom={lod === 'mini' ? 0.35 : 1}
      compactAt={0.8}
      pub={false}
      maxTop={100}
      kioskRemaining={null}
      cascadeAlloc
      onSpawn={noop}
      onSpawnSide={noop}
      onSpawnTop={noop}
      onConfig={noop}
      onInbox={noop}
      onLineage={noop}
      onOpenDoc={opts.onOpenDoc ?? noop}
      onRecenter={noop}
      onJump={noop}
      onMailLink={noop}
      onDragStart={opts.onDragStart ?? noop}
      onDragMove={noop}
      onDragEnd={noop}
      onDragCancel={noop}
      onPin={opts.onPin ?? noop}
      pinned={opts.pinned ?? false}
    />,
    (el) => el,
  )
}

test('§1 Far-zoom node renders singular state icon and omits all secondary metadata', async () => {
  const n = makeNode('agent-worker', {
    tier: 'sonnet',
    busy: true,
    inflight_at: new Date(Date.now() - 30_000).toISOString(),
    pending_switch: { tier: 'opus' },
    limit_locked: true,
    lineage: [makeNode('ancestor', { generation: 0 })],
    last_error: 'warning occurred',
  })
  ;(n as unknown as { documents: unknown[] }).documents = [{ id: 'doc-1', title: 'plan' }]

  const view = await renderCard(n, 'mini')
  try {
    const card = view.el.querySelector<HTMLElement>('.sq')!
    assert.ok(card, 'agent card is rendered')
    assert.ok(card.classList.contains('mini'), 'card has .mini class at far zoom')

    // 1. The singular state icon must be present
    const stateIcon = card.querySelector('.sq-far-icon')
    assert.ok(stateIcon, 'singular state icon is present in the node interior')

    // 2. All secondary interior elements must be explicitly absent
    assert.equal(card.querySelector('.name'), null, 'agent name is absent')
    assert.equal(card.querySelector('.sq-title'), null, 'title row is absent')
    assert.equal(card.querySelector('.tier'), null, 'model/tier badge is absent')
    assert.equal(card.querySelector('.queued-mark'), null, 'queued-switch mark is absent')
    assert.equal(card.querySelector('.sq-meta'), null, 'meta container is absent')
    assert.equal(card.querySelector('.sq-workstate'), null, 'workstate container is absent')
    assert.equal(card.querySelector('.sq-idle'), null, 'written state label is absent')
    assert.equal(card.querySelector('.sq-idle-time'), null, 'elapsed duration is absent')
    assert.equal(card.querySelector('.turnago'), null, 'turn age badge is absent')
    assert.equal(card.querySelector('.ctxwheel'), null, 'context wheel is absent')
    assert.equal(card.querySelector('.errdot'), null, 'error dot is absent')
    assert.equal(card.querySelector('.sq-actions'), null, 'shortcut actions are absent')
    assert.equal(card.querySelector('.sq-badges'), null, 'badges container is absent')
    assert.equal(card.querySelector('.badge'), null, 'all badge chips are absent')
    assert.equal(card.querySelector('.stackbadge'), null, 'generation/stack badge is absent')
    assert.equal(card.querySelector('.cbar-wrap'), null, 'credit bar is absent')
    assert.equal(card.querySelector('.cbar'), null, 'credit bar fill is absent')

    // 3. Verify exactly ONE interior element exists
    const interior = Array.from(card.children).filter(
      (el) =>
        !el.classList.contains('hsof') &&
        !el.classList.contains('hsof-bridge') &&
        !el.classList.contains('doc-chips'),
    )
    assert.equal(interior.length, 1, 'literally ONE interior element is rendered')
    assert.equal(interior[0], stateIcon, 'the single interior element is the state icon')
  } finally {
    await view.unmount()
  }
})

test('§2 State fidelity: correct indicators rendered across all supported states', async () => {
  const cases: {
    name: string
    node: CanvasNode
    expectedClass: string
    check: (el: Element) => boolean
  }[] = [
    {
      name: 'active mid-turn (busy: true, claude)',
      node: makeNode('active-claude', { busy: true, tier: 'opus' }),
      expectedClass: 'active',
      check: (el) => el.classList.contains('cc-spin') && el.classList.contains('prov-claude'),
    },
    {
      name: 'active mid-turn (busy: true, codex)',
      node: makeNode('active-codex', { busy: true, tier: 'terra' }),
      expectedClass: 'active',
      check: (el) => el.classList.contains('cc-spin') && el.classList.contains('prov-openai'),
    },
    {
      name: 'active mid-turn (busy: true, antigravity)',
      node: makeNode('active-agy', { busy: true, tier: 'flash' }),
      expectedClass: 'active',
      check: (el) => el.classList.contains('cc-spin') && el.classList.contains('prov-google'),
    },
    {
      name: 'working (reported working, not mid-turn)',
      node: makeNode('working-node', { busy: false, last_status: { status: 'working', summary: 'working', at: '' } }),
      expectedClass: 'working',
      check: (el) => el.classList.contains('working') && !el.classList.contains('cc-spin'),
    },
    {
      name: 'idle (live, not busy)',
      node: makeNode('idle-node', { busy: false, last_status: { status: 'idle', summary: 'idle', at: '' } }),
      expectedClass: 'idle',
      check: (el) => el.classList.contains('idle'),
    },
    {
      name: 'blocked (reported blocked)',
      node: makeNode('blocked-node', { busy: false, last_status: { status: 'blocked', summary: 'blocked', at: '' } }),
      expectedClass: 'blocked',
      check: (el) => el.classList.contains('blocked'),
    },
    {
      name: 'halted (durable halt)',
      node: makeNode('halted-node', { halt: { phase: 'halted' } }),
      expectedClass: 'halted',
      check: (el) => el.classList.contains('halted'),
    },
    {
      name: 'usage frozen',
      node: makeNode('frozen-node', { frozen: { until: 'tomorrow', until_ts: 1234567 } }),
      expectedClass: 'frozen',
      check: (el) => el.classList.contains('frozen'),
    },
    {
      name: 'queued behind turn slot',
      node: makeNode('queued-node', { waiting: true }),
      expectedClass: 'queued',
      check: (el) => el.classList.contains('queued'),
    },
    {
      name: 'compacting',
      node: makeNode('compacting-node', { phase: 'compacting' }),
      expectedClass: 'compacting',
      check: (el) => el.classList.contains('compacting'),
    },
    {
      name: 'done',
      node: makeNode('done-node', { last_status: { status: 'done', summary: 'done', at: '' } }),
      expectedClass: 'done',
      check: (el) => el.classList.contains('done'),
    },
    {
      name: 'errored',
      node: makeNode('errored-node', { last_error: 'Something failed' }),
      expectedClass: 'errored',
      check: (el) => el.classList.contains('errored'),
    },
    {
      name: 'archived',
      node: makeNode('archived-node', { state: 'archived' }),
      expectedClass: 'archived',
      check: (el) => el.classList.contains('archived'),
    },
  ]

  for (const c of cases) {
    // 1. Authoritative pure derivation parity
    const visual = deriveAgentVisualState(c.node)
    assert.equal(visual.farKind, c.expectedClass, `${c.name}: deriveAgentVisualState matches expected kind`)

    // 2. Far-zoom rendering parity
    const view = await renderCard(c.node, 'mini')
    try {
      const icon = view.el.querySelector('.sq-far-icon')
      assert.ok(icon, `${c.name}: state icon rendered`)
      assert.ok(icon.classList.contains(c.expectedClass), `${c.name}: has class ${c.expectedClass}`)
      assert.ok(c.check(icon), `${c.name}: specific state check passed`)

      // Singular interior child check across all cases
      const interior = Array.from(view.el.querySelector('.sq')!.children).filter(
        (el) =>
          !el.classList.contains('hsof') &&
          !el.classList.contains('hsof-bridge') &&
          !el.classList.contains('doc-chips'),
      )
      assert.equal(interior.length, 1, `${c.name}: literally one interior element`)
      assert.equal(interior[0], icon, `${c.name}: interior element is the state icon`)
    } finally {
      await view.unmount()
    }

    // 3. Normal zoom rendering parity (no regression / errors)
    const normView = await renderCard(c.node, 'norm')
    try {
      const normCard = normView.el.querySelector('.sq')!
      assert.ok(normCard.classList.contains('norm'), `${c.name}: normal card renders`)
      assert.equal(normCard.querySelector('.sq-far-icon'), null, `${c.name}: far icon absent at norm`)
    } finally {
      await normView.unmount()
    }
  }
})

test('§2b State precedence hierarchy: halt > frozen > active > queued > compacting > lifecycle > reported > error fallback > idle', async () => {
  // Precedence 1: halt beats everything
  const haltNode = makeNode('p-halt', {
    halt: { phase: 'halted' },
    frozen: { until: 'now', until_ts: 123 },
    limit_locked: true,
    busy: true,
    waiting: true,
    phase: 'compacting',
    state: 'archived',
    last_status: { status: 'working', summary: 'w', at: '' },
    last_error: 'fatal',
  })
  assert.equal(deriveAgentVisualState(haltNode).kind, 'halted')
  let view = await renderCard(haltNode, 'mini')
  try {
    const icon = view.el.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('halted'), 'halt beats all lower states')
  } finally {
    await view.unmount()
  }

  // Precedence 2: frozen beats active, queued, compacting, lifecycle, reported, error
  const frozenNode = makeNode('p-frozen', {
    frozen: { until: 'now', until_ts: 123 },
    limit_locked: false,
    busy: true,
    waiting: true,
    phase: 'compacting',
    state: 'live',
    last_status: { status: 'working', summary: 'w', at: '' },
    last_error: 'fatal',
  })
  assert.equal(deriveAgentVisualState(frozenNode).kind, 'frozen')
  view = await renderCard(frozenNode, 'mini')
  try {
    const icon = view.el.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('frozen'), 'frozen beats active/queued/compacting/reported/error')
  } finally {
    await view.unmount()
  }

  // Precedence 3: active (mid-turn working) beats lifecycle, reported, error
  const activeNode = makeNode('p-active', {
    busy: true,
    state: 'archived',
    last_status: { status: 'blocked', summary: 'b', at: '' },
    last_error: 'fatal',
  })
  assert.equal(deriveAgentVisualState(activeNode).kind, 'active')
  view = await renderCard(activeNode, 'mini')
  try {
    const icon = view.el.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('active'), 'active beats lifecycle/reported/error')
  } finally {
    await view.unmount()
  }

  // Precedence 4: queued beats lifecycle, reported, error
  const queuedNode = makeNode('p-queued', {
    waiting: true,
    state: 'archived',
    last_status: { status: 'working', summary: 'w', at: '' },
    last_error: 'fatal',
  })
  assert.equal(deriveAgentVisualState(queuedNode).kind, 'queued')
  view = await renderCard(queuedNode, 'mini')
  try {
    const icon = view.el.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('queued'), 'queued beats lifecycle/reported/error')
  } finally {
    await view.unmount()
  }

  // Precedence 5: compacting beats lifecycle, reported, error
  const compactingNode = makeNode('p-compacting', {
    phase: 'compacting',
    state: 'archived',
    last_status: { status: 'working', summary: 'w', at: '' },
    last_error: 'fatal',
  })
  assert.equal(deriveAgentVisualState(compactingNode).kind, 'compacting')
  view = await renderCard(compactingNode, 'mini')
  try {
    const icon = view.el.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('compacting'), 'compacting beats lifecycle/reported/error')
  } finally {
    await view.unmount()
  }

  // Precedence 6: lifecycle (archived) beats reported, error
  const archivedNode = makeNode('p-archived', {
    state: 'archived',
    last_status: { status: 'working', summary: 'w', at: '' },
    last_error: 'fatal',
  })
  assert.equal(deriveAgentVisualState(archivedNode).kind, 'archived')
  view = await renderCard(archivedNode, 'mini')
  try {
    const icon = view.el.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('archived'), 'lifecycle beats reported/error')
  } finally {
    await view.unmount()
  }

  // Precedence 7: reported status beats error fallback
  const reportedNode = makeNode('p-reported', {
    last_status: { status: 'working', summary: 'w', at: '' },
    last_error: 'fatal',
  })
  assert.equal(deriveAgentVisualState(reportedNode).kind, 'working')
  view = await renderCard(reportedNode, 'mini')
  try {
    const icon = view.el.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('working'), 'reported status beats error fallback')
  } finally {
    await view.unmount()
  }

  const blockedReportedNode = makeNode('p-blocked', {
    last_status: { status: 'blocked', summary: 'b', at: '' },
    last_error: 'fatal',
  })
  assert.equal(deriveAgentVisualState(blockedReportedNode).kind, 'blocked')
  view = await renderCard(blockedReportedNode, 'mini')
  try {
    const icon = view.el.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('blocked'), 'reported blocked beats error fallback')
  } finally {
    await view.unmount()
  }

  // Precedence 8: error fallback beats idle default
  const errorNode = makeNode('p-error', {
    last_error: 'fatal error occurred',
  })
  assert.equal(deriveAgentVisualState(errorNode).farKind, 'errored')
  assert.equal(deriveAgentVisualState(errorNode).kind, 'idle')
  view = await renderCard(errorNode, 'mini')
  try {
    const icon = view.el.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('errored'), 'error fallback beats idle')
  } finally {
    await view.unmount()
  }

  // Precedence 9: idle default
  const idleNode = makeNode('p-idle', {})
  assert.equal(deriveAgentVisualState(idleNode).kind, 'idle')
  view = await renderCard(idleNode, 'mini')
  try {
    const icon = view.el.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('idle'), 'fallback is idle')
  } finally {
    await view.unmount()
  }
})

test('§2c Normal card preservation: non-limit frozen, legacy waiting/error classes, and last_error-only idle', async () => {
  // 1. Non-limit frozen (e.g. spend: true -> freezeKind is 'spend', NOT 'limit')
  const spendFrozenNode = makeNode('spend-frozen', {
    frozen: { until: 'later', spend: true, until_ts: 999999 },
    state: 'live',
  })
  const spendVisual = deriveAgentVisualState(spendFrozenNode)
  assert.equal(spendVisual.kind, 'idle', 'non-limit frozen is not usage frozen')
  assert.equal(spendVisual.farKind, 'idle', 'farKind is idle for non-limit frozen')
  assert.equal(spendVisual.normalClass, 'idle', 'normalClass is idle for non-limit frozen')

  const spendNormView = await renderCard(spendFrozenNode, 'norm')
  try {
    const normCard = spendNormView.el.querySelector('.sq')!
    assert.equal(normCard.querySelector('.usage-freeze-status'), null, 'no usage freeze banner on non-limit frozen')
    assert.ok(normCard.querySelector('.sq-idle.idle'), 'renders sq-idle idle on normal card')
    assert.equal(normCard.querySelector('.sq-idle')!.textContent?.trim(), 'Idle')
  } finally {
    await spendNormView.unmount()
  }

  const spendMiniView = await renderCard(spendFrozenNode, 'mini')
  try {
    const miniCard = spendMiniView.el.querySelector('.sq')!
    const icon = miniCard.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('idle'), 'far zoom renders idle icon on non-limit frozen')
    assert.equal(icon.classList.contains('frozen'), false)
  } finally {
    await spendMiniView.unmount()
  }

  // 2. Legacy recorded waiting status
  const waitingNode = makeNode('legacy-waiting', {
    last_status: { status: 'waiting', summary: 'waiting in queue', at: '' },
  })
  const waitingVisual = deriveAgentVisualState(waitingNode)
  assert.equal(waitingVisual.normalClass, 'waiting', 'normalClass preserves exact waiting class')
  assert.equal(waitingVisual.normalLabel, 'Waiting', 'normalLabel preserves exact Waiting label')
  assert.equal(waitingVisual.farKind, 'queued', 'farKind normalizes to queued')

  const waitingNormView = await renderCard(waitingNode, 'norm')
  try {
    const normCard = waitingNormView.el.querySelector('.sq')!
    const labelEl = normCard.querySelector('.sq-idle')!
    assert.ok(labelEl.classList.contains('waiting'), 'normal card preserves sq-idle waiting class')
    assert.equal(labelEl.textContent?.trim(), 'Waiting', 'normal card preserves Waiting label')
  } finally {
    await waitingNormView.unmount()
  }

  const waitingMiniView = await renderCard(waitingNode, 'mini')
  try {
    const miniCard = waitingMiniView.el.querySelector('.sq')!
    const icon = miniCard.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('queued'), 'far zoom renders queued icon for waiting status')
  } finally {
    await waitingMiniView.unmount()
  }

  // 3. Legacy recorded error status
  const errorNode = makeNode('legacy-error', {
    last_status: { status: 'error', summary: 'encountered error', at: '' },
  })
  const errorVisual = deriveAgentVisualState(errorNode)
  assert.equal(errorVisual.normalClass, 'error', 'normalClass preserves exact error class')
  assert.equal(errorVisual.normalLabel, 'Error', 'normalLabel preserves exact Error label')
  assert.equal(errorVisual.farKind, 'errored', 'farKind normalizes to errored')

  const errorNormView = await renderCard(errorNode, 'norm')
  try {
    const normCard = errorNormView.el.querySelector('.sq')!
    const labelEl = normCard.querySelector('.sq-idle')!
    assert.ok(labelEl.classList.contains('error'), 'normal card preserves sq-idle error class')
    assert.equal(labelEl.textContent?.trim(), 'Error', 'normal card preserves Error label')
  } finally {
    await errorNormView.unmount()
  }

  const errorMiniView = await renderCard(errorNode, 'mini')
  try {
    const miniCard = errorMiniView.el.querySelector('.sq')!
    const icon = miniCard.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('errored'), 'far zoom renders errored icon for error status')
  } finally {
    await errorMiniView.unmount()
  }

  // 4. last_error without reported status: normal card stays Idle + errdot, far zoom shows singular errored icon
  const lastErrorOnlyNode = makeNode('last-error-only', {
    last_error: 'Connection timed out',
  })
  const lastErrorVisual = deriveAgentVisualState(lastErrorOnlyNode)
  assert.equal(lastErrorVisual.normalClass, 'idle', 'normalClass remains idle')
  assert.equal(lastErrorVisual.normalLabel, 'Idle', 'normalLabel remains Idle')
  assert.equal(lastErrorVisual.farKind, 'errored', 'farKind is errored for singular far zoom')

  const lastErrorNormView = await renderCard(lastErrorOnlyNode, 'norm')
  try {
    const normCard = lastErrorNormView.el.querySelector('.sq')!
    const labelEl = normCard.querySelector('.sq-idle')!
    assert.ok(labelEl.classList.contains('idle'), 'normal card renders sq-idle idle')
    assert.equal(labelEl.textContent?.trim(), 'Idle', 'normal card renders Idle text')
    const errdot = normCard.querySelector('.errdot')
    assert.ok(errdot, 'errdot is mounted beside idle state on normal card')
  } finally {
    await lastErrorNormView.unmount()
  }

  const lastErrorMiniView = await renderCard(lastErrorOnlyNode, 'mini')
  try {
    const miniCard = lastErrorMiniView.el.querySelector('.sq')!
    const icon = miniCard.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('errored'), 'far zoom renders singular errored icon')
    assert.equal(miniCard.querySelector('.errdot'), null, 'errdot is omitted at far zoom')
    assert.equal(miniCard.querySelector('.sq-idle'), null, 'text label is omitted at far zoom')
  } finally {
    await lastErrorMiniView.unmount()
  }
})

test('§3 State transitions update far-zoom icon immediately', async () => {
  const n = makeNode('transitioning-agent', { busy: true, tier: 'haiku' })
  const view = await renderCard(n, 'mini')
  try {
    let icon = view.el.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('active'), 'starts as active spinning arrows')

    // Turn completes; agent reported working
    const workingNode = makeNode('transitioning-agent', {
      busy: false,
      tier: 'haiku',
      last_status: { status: 'working', summary: 'background task', at: '' },
    })
    await inAct(async () => {
      await view.render(
        <NodeSquare
          node={workingNode}
          pos={{ x: 100, y: 200 }}
          lod="mini"
          focused={false}
          dragging={false}
          isDrop={false}
          seats={seats}
          map={new Map([[workingNode.id, workingNode]])}
          op={op}
          slug="test-org"
          toast={noop}
          pxc={1}
          zoom={0.35}
          cascadeAlloc
          onSpawn={noop}
          onConfig={noop}
          onInbox={noop}
          onLineage={noop}
          onMailLink={noop}
          onDragStart={noop}
          onDragMove={noop}
          onDragEnd={noop}
          onDragCancel={noop}
        />,
      )
    })
    icon = view.el.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('working'), 'transitions immediately to pulsating working')
    assert.equal(icon.classList.contains('active'), false)

    // Agent finishes work and reports idle
    const idleNode = makeNode('transitioning-agent', {
      busy: false,
      tier: 'haiku',
      last_status: { status: 'idle', summary: 'waiting', at: '' },
    })
    await inAct(async () => {
      await view.render(
        <NodeSquare
          node={idleNode}
          pos={{ x: 100, y: 200 }}
          lod="mini"
          focused={false}
          dragging={false}
          isDrop={false}
          seats={seats}
          map={new Map([[idleNode.id, idleNode]])}
          op={op}
          slug="test-org"
          toast={noop}
          pxc={1}
          zoom={0.35}
          cascadeAlloc
          onSpawn={noop}
          onConfig={noop}
          onInbox={noop}
          onLineage={noop}
          onMailLink={noop}
          onDragStart={noop}
          onDragMove={noop}
          onDragEnd={noop}
          onDragCancel={noop}
        />,
      )
    })
    icon = view.el.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('idle'), 'transitions immediately to hollow idle ring')

    // Agent becomes blocked
    const blockedNode = makeNode('transitioning-agent', {
      busy: false,
      tier: 'haiku',
      last_status: { status: 'blocked', summary: 'missing input', at: '' },
    })
    await inAct(async () => {
      await view.render(
        <NodeSquare
          node={blockedNode}
          pos={{ x: 100, y: 200 }}
          lod="mini"
          focused={false}
          dragging={false}
          isDrop={false}
          seats={seats}
          map={new Map([[blockedNode.id, blockedNode]])}
          op={op}
          slug="test-org"
          toast={noop}
          pxc={1}
          zoom={0.35}
          cascadeAlloc
          onSpawn={noop}
          onConfig={noop}
          onInbox={noop}
          onLineage={noop}
          onMailLink={noop}
          onDragStart={noop}
          onDragMove={noop}
          onDragEnd={noop}
          onDragCancel={noop}
        />,
      )
    })
    icon = view.el.querySelector('.sq-far-icon')!
    assert.ok(icon.classList.contains('blocked'), 'transitions immediately to red blocked diamond')
  } finally {
    await view.unmount()
  }
})

test('§4 Preserves outer bounds, geometry, selection, and edge controls at far zoom', async () => {
  const started: string[] = []
  const openedDocs: string[] = []
  const n = makeNode('geo-agent', { tier: 'haiku', busy: true })
  ;(n as unknown as { documents: unknown[] }).documents = [{ id: 'doc-alpha', title: 'guide' }]

  const view = await renderCard(n, 'mini', {
    onDragStart: (_e, id) => started.push(id),
    onOpenDoc: (id) => openedDocs.push(id),
  })
  try {
    const card = view.el.querySelector<HTMLElement>('.sq')!

    // Geometry bounds: 124 x 124 px at position (100, 200)
    assert.equal(card.style.width, '124px', 'width remains exactly 124px')
    assert.equal(card.style.height, '124px', 'height remains exactly 124px')
    assert.equal(card.style.transform, 'translate(100px, 200px)', 'transform position preserved')

    // Exterior edge controls: hire chips and document chips
    assert.ok(card.querySelectorAll('.hsof').length > 0, 'exterior hire tokens remain mounted')
    assert.ok(card.querySelectorAll('.doc-chips').length > 0, 'exterior doc chips remain mounted')

    // Interaction / selection: pointerdown on card triggers drag start / selection
    const ev = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    await inAct(() => {
      card.dispatchEvent(ev)
    })
    assert.deepEqual(started, ['geo-agent'], 'pointerdown reaches card drag/selection handler')

    // Context menu trigger preserved
    assert.ok(card.getAttribute('data-copy-agent-name'), 'data-copy-agent-name preserved on card')
  } finally {
    await view.unmount()
  }
})

test('§5 Zoom transition norm -> mini -> norm cleanly restores normal content', async () => {
  const n = makeNode('zoom-transition-agent', {
    tier: 'sonnet',
    busy: true,
    inflight_at: new Date(Date.now() - 15_000).toISOString(),
  })

  // 1. Render at normal zoom
  const view = await renderCard(n, 'norm')
  try {
    const card = view.el.querySelector<HTMLElement>('.sq')!
    assert.ok(card.classList.contains('norm'), 'card has .norm class')
    assert.ok(card.querySelector('.sq-head'), 'sq-head present at norm')
    assert.ok(card.querySelector('.name'), 'name present at norm')
    assert.ok(card.querySelector('.tier'), 'tier token present at norm')
    assert.ok(card.querySelector('.sq-meta'), 'sq-meta present at norm')
    assert.ok(card.querySelector('.cbar'), 'credit bar present at norm')
    assert.equal(card.querySelector('.sq-far-icon'), null, 'far-zoom icon absent at norm')

    // 2. Transition to far zoom (mini)
    await inAct(async () => {
      await view.render(
        <NodeSquare
          node={n}
          pos={{ x: 100, y: 200 }}
          lod="mini"
          focused={false}
          dragging={false}
          isDrop={false}
          seats={seats}
          map={new Map([[n.id, n]])}
          op={op}
          slug="test-org"
          toast={noop}
          pxc={1}
          zoom={0.35}
          cascadeAlloc
          onSpawn={noop}
          onConfig={noop}
          onInbox={noop}
          onLineage={noop}
          onMailLink={noop}
          onDragStart={noop}
          onDragMove={noop}
          onDragEnd={noop}
          onDragCancel={noop}
        />,
      )
    })
    const miniCard = view.el.querySelector<HTMLElement>('.sq')!
    assert.ok(miniCard.classList.contains('mini'), 'card has .mini class')
    assert.ok(miniCard.querySelector('.sq-far-icon'), 'far-zoom icon present at mini')
    assert.equal(miniCard.querySelector('.sq-head'), null, 'sq-head removed at mini')
    assert.equal(miniCard.querySelector('.name'), null, 'name removed at mini')
    assert.equal(miniCard.querySelector('.tier'), null, 'tier token removed at mini')
    assert.equal(miniCard.querySelector('.cbar'), null, 'credit bar removed at mini')

    // 3. Transition back to normal zoom
    await inAct(async () => {
      await view.render(
        <NodeSquare
          node={n}
          pos={{ x: 100, y: 200 }}
          lod="norm"
          focused={false}
          dragging={false}
          isDrop={false}
          seats={seats}
          map={new Map([[n.id, n]])}
          op={op}
          slug="test-org"
          toast={noop}
          pxc={1}
          zoom={1}
          cascadeAlloc
          onSpawn={noop}
          onConfig={noop}
          onInbox={noop}
          onLineage={noop}
          onMailLink={noop}
          onDragStart={noop}
          onDragMove={noop}
          onDragEnd={noop}
          onDragCancel={noop}
        />,
      )
    })
    const normCard = view.el.querySelector<HTMLElement>('.sq')!
    assert.ok(normCard.classList.contains('norm'), 'card returns to .norm class')
    assert.ok(normCard.querySelector('.sq-head'), 'sq-head restored at norm')
    assert.ok(normCard.querySelector('.name'), 'name restored at norm')
    assert.ok(normCard.querySelector('.tier'), 'tier token restored at norm')
    assert.ok(normCard.querySelector('.sq-meta'), 'sq-meta restored at norm')
    assert.ok(normCard.querySelector('.cbar'), 'credit bar restored at norm')
    assert.equal(normCard.querySelector('.sq-far-icon'), null, 'far-zoom icon cleanly removed when returning to norm')
  } finally {
    await view.unmount()
  }
})

test('§6 Reduced motion accessibility rules present in stylesheet for far-zoom animations', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(
    css,
    /\.sq\.mini\s*\{[^}]*align-items:\s*center[^}]*justify-content:\s*center/s,
    '.sq.mini is centered in stylesheet',
  )
  assert.match(
    css,
    /\.sq-far-icon\.active,\s*\.sq-far-icon\.cc-spin\s*\{[^}]*width:\s*60px/s,
    'enlarged active icon sizing is present',
  )
  assert.match(
    css,
    /\.sq-far-icon\.working\s*\{[^}]*background:\s*var\(--work\)[^}]*animation:\s*pulse/s,
    'enlarged working pulsating-blue styling is present',
  )
  assert.match(
    css,
    /\.sq-far-icon\.idle\s*\{[^}]*border:\s*5px solid/s,
    'enlarged idle hollow-grey styling is present',
  )
  assert.match(
    css,
    /\.sq-far-icon\.blocked\s*\{[^}]*background:\s*var\(--bad\)[^}]*transform:\s*rotate\(45deg\)/s,
    'enlarged blocked red-diamond styling is present',
  )

  // Reduced motion
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.sq-far-icon\.active\.cc-spin\s*\{[^}]*animation:\s*none/s,
    'prefers-reduced-motion halts active spinning animation',
  )
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.sq-far-icon\.working[^}]*\{[^}]*animation:\s*none/s,
    'prefers-reduced-motion halts working pulse animation',
  )
})
