// Focused renderer tests for far-zoom hover agent name reveal.
//
// Verifies:
// 1. Far-zoom default placement: model card/icon rests at the node's upper-left corner (top: 4px, left: 4px).
// 2. Far-zoom hover reveal: reveals agent name in an annotation centered horizontally above the node.
// 3. Arrangement: model card/icon on the left, agent name on the right.
// 4. Smooth transitions and return to upper-left corner on hover exit.
// 5. Long names: legible, bounded max-width with ellipsis, unabridged title attribute.
// 6. Non-interference: pointer-events: none, card dimensions and drag/click interaction preserved.
// 7. Normal zoom preservation: non-far-zoom presentation remains unchanged.
// 8. Accessibility: keyboard focus (:focus-within, :focus-visible) and reduced-motion rules.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView } from './harness'
import { NodeSquare, FarZoomStateIcon } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

declare const __SRC_DIR__: string

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10, flash: 1, pro: 2, terra: 2, sol: 5, luna: 0.2 }
const hire = { enabled: true, installed: true, reason: null }

function makeNode(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    title: id,
    state: 'live',
    tier: 'sonnet',
    model_id: 'sonnet',
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
      onOpenDoc={noop}
      onRecenter={noop}
      onJump={noop}
      onMailLink={noop}
      onDragStart={opts.onDragStart ?? noop}
      onDragMove={noop}
      onDragEnd={noop}
      onDragCancel={noop}
      pinned={false}
    />,
    (el) => el,
  )
}

test('§1 Far-zoom node mounts model token in upper-left corner with revealed name annotation', async () => {
  const node = makeNode('agent-specialist', { tier: 'sonnet' })
  const view = await renderCard(node, 'mini')
  try {
    const card = view.el.querySelector<HTMLElement>('.sq')!
    assert.ok(card, 'agent card is rendered')
    assert.ok(card.classList.contains('mini'), 'card has .mini class at far zoom')

    const farTier = card.querySelector<HTMLElement>('.sq-far-tier')
    assert.ok(farTier, '.sq-far-tier element is present')

    // Model token inside far-tier
    const tierIcon = farTier?.querySelector<HTMLElement>('.tier')
    assert.ok(tierIcon, 'model tier chip is present')
    assert.equal(tierIcon?.textContent?.trim(), 'S', 'tier chip displays Sonnet token')

    // Revealed name element inside far-tier
    const nameEl = farTier?.querySelector<HTMLElement>('.sq-far-name')
    assert.ok(nameEl, '.sq-far-name element is mounted')
    assert.equal(nameEl?.textContent?.trim(), 'agent-specialist', 'name element contains agent id')
    assert.equal(nameEl?.getAttribute('title'), 'agent-specialist', 'name element carries title attribute')

    // Normal zoom title row is absent
    assert.equal(card.querySelector('.sq-title'), null, 'normal title row is omitted at far zoom')
    assert.equal(card.querySelector('.name'), null, 'normal agent name class is absent')
  } finally {
    await view.unmount()
  }
})

test('§2 Stylesheet places model token at upper-left resting corner and centers hover annotation above node', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')

  // Resting placement: upper-left corner (top: 4px, left: 4px)
  assert.match(
    css,
    /\.sq-far-tier\s*\{[^}]*position:\s*absolute[^}]*top:\s*4px[^}]*left:\s*4px/s,
    'sq-far-tier rests at top: 4px, left: 4px',
  )

  // Hover/focus reveal: centered horizontally above node (top: -26px, left: 50%, translateX(-50%))
  assert.match(
    css,
    /\.sq\.mini:hover\s+\.sq-far-tier[^{]*\{[^}]*top:\s*-26px[^}]*left:\s*50%[^}]*transform:\s*translateX\(-50%\)/s,
    'hover/focus animates sq-far-tier upward and centered above the node',
  )

  // Name reveals on hover/focus
  assert.match(
    css,
    /\.sq\.mini:hover\s+\.sq-far-name[^{]*\{[^}]*opacity:\s*1[^}]*max-width:\s*180px/s,
    'hover reveals sq-far-name with opacity and max-width expansion',
  )
})

test('§3 Arrangement matches named-agent presentation: model card on left, agent name on right', async () => {
  const node = makeNode('worker-alpha', { tier: 'opus' })
  const view = await renderCard(node, 'mini')
  try {
    const farTier = view.el.querySelector<HTMLElement>('.sq-far-tier')!
    assert.ok(farTier, '.sq-far-tier is present')

    // Children order: tier chip first, name second
    const children = Array.from(farTier.children)
    assert.equal(children.length, 2, 'sq-far-tier contains tier chip and name element')
    assert.ok(children[0].classList.contains('tier'), 'first child is model tier chip (left side)')
    assert.ok(children[1].classList.contains('sq-far-name'), 'second child is agent name (right side)')
  } finally {
    await view.unmount()
  }
})

test('§4 Smooth animated transitions and return on hover exit', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')

  // Transitions defined on sq-far-tier for smooth movement and return
  assert.match(
    css,
    /\.sq-far-tier\s*\{[^}]*transition:[^;}]*\btop\b[^;}]*\bleft\b[^;}]*\btransform\b/s,
    'smooth transition defined for top, left, and transform on sq-far-tier',
  )

  // Transitions defined on sq-far-name for fading and collapsing
  assert.match(
    css,
    /\.sq-far-name\s*\{[^}]*transition:[^;}]*\bopacity\b[^;}]*\bmax-width\b/s,
    'smooth transition defined for opacity and max-width on sq-far-name',
  )
})

test('§5 Long names truncate cleanly with ellipsis and maintain unabridged title attribute', async () => {
  const longId = 'coordinator-astra-subordinate-worker-specialist-forty-two'
  const node = makeNode(longId, { tier: 'flash', account: 'google/primary' })
  const view = await renderCard(node, 'mini')
  try {
    const nameEl = view.el.querySelector<HTMLElement>('.sq-far-name')!
    assert.ok(nameEl, 'name element is rendered for long name')
    assert.equal(nameEl.textContent?.trim(), longId, 'name text contains complete id')
    assert.equal(nameEl.getAttribute('title'), `${longId}: account google/primary`, 'title attribute preserves account annotation')

    // Stylesheet verifies ellipsis and max-width bounding
    const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
    assert.match(
      css,
      /\.sq-far-name\s*\{[^}]*overflow:\s*hidden[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/s,
      'long names are styled with text-overflow ellipsis and nowrap',
    )
  } finally {
    await view.unmount()
  }
})

test('§6 Non-interference: pointer-events: none, dimensions, and card interaction preserved', async () => {
  let dragStarted = false
  const node = makeNode('interactive-node', { tier: 'haiku' })
  const view = await renderCard(node, 'mini', {
    onDragStart: () => { dragStarted = true },
  })
  try {
    const card = view.el.querySelector<HTMLElement>('.sq')!
    const farTier = card.querySelector<HTMLElement>('.sq-far-tier')!

    // Pointer events none prevents blocking node interaction
    const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
    assert.match(
      css,
      /\.sq-far-tier\s*\{[^}]*pointer-events:\s*none/s,
      'sq-far-tier has pointer-events: none',
    )
    assert.match(
      css,
      /\.sq-far-name\s*\{[^}]*pointer-events:\s*none/s,
      'sq-far-name has pointer-events: none',
    )

    // Drag interaction on card fires normally
    card.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100, clientY: 200 }))
    assert.equal(dragStarted, true, 'card drag interaction fires without interference')
  } finally {
    await view.unmount()
  }
})

test('§7 Normal zoom presentation preserves normal title row and omits far-zoom elements', async () => {
  const node = makeNode('norm-agent', { tier: 'haiku' })
  const view = await renderCard(node, 'norm')
  try {
    const card = view.el.querySelector<HTMLElement>('.sq')!
    assert.ok(card.classList.contains('norm'), 'card has .norm class')

    // Normal zoom header rows are mounted
    assert.ok(card.querySelector('.sq-title'), 'sq-title is mounted at normal zoom')
    assert.ok(card.querySelector('.sq-title .name'), '.name is mounted at normal zoom')
    assert.equal(card.querySelector('.sq-title .name')?.textContent?.trim(), 'norm-agent')

    // Far-zoom elements are unmounted
    assert.equal(card.querySelector('.sq-far-tier'), null, 'sq-far-tier is absent at norm')
    assert.equal(card.querySelector('.sq-far-name'), null, 'sq-far-name is absent at norm')
    assert.equal(card.querySelector('.sq-far-icon'), null, 'sq-far-icon is absent at norm')
  } finally {
    await view.unmount()
  }
})

test('§8 Keyboard focus accessibility (:focus-within and :focus-visible) triggers reveal', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')

  assert.match(
    css,
    /\.sq\.mini:focus-within\s+\.sq-far-tier/,
    ':focus-within triggers sq-far-tier reveal for keyboard users',
  )
  assert.match(
    css,
    /\.sq\.mini:focus-visible\s+\.sq-far-tier/,
    ':focus-visible triggers sq-far-tier reveal for keyboard users',
  )
  assert.match(
    css,
    /\.sq\.mini:focus-within\s+\.sq-far-name/,
    ':focus-within triggers sq-far-name reveal for keyboard users',
  )
  assert.match(
    css,
    /\.sq\.mini:focus-visible\s+\.sq-far-name/,
    ':focus-visible triggers sq-far-name reveal for keyboard users',
  )
})

test('§9 Reduced motion accessibility halts position transitions', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')

  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.sq-far-tier[^}]*\{[^}]*transition:\s*none/s,
    'prefers-reduced-motion disables transition on sq-far-tier',
  )
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.sq-far-name[^}]*\{[^}]*transition:\s*none/s,
    'prefers-reduced-motion disables transition on sq-far-name',
  )
})
