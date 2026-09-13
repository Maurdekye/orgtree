// pendexpand.test.tsx — EXPANDED PENDING MAIL STAYS EXPANDED ACROSS DELIVERY
// (docket item: keep-expanded-messages-open-after-sending).
//
// THE DEFECT:
//   An expanded pending or queued chat message collapsed when its delivery
//   state transitioned to sent/delivered.
//
// THE MECHANISM:
//   · `ReceivedMailBody` (canvas/mailpreview.tsx) stored its expanded state
//     in local component `useState(false)`.
//   · That state lived only as long as the component instance.
//   · When a pending message (optimistic ghost in `PendingGhostRow` or durable
//     queued mail in `PendingMailRow`) transitioned to a delivered transcript
//     entry (`SegmentList` -> `MailMessage`), React remounted the row under a
//     new key. The new component instance initialized with `useState(false)`,
//     snapping the fold shut.
//
// THE FIX:
//   · Expand state is lifted to `DeskChat`'s `FoldStore` (canvas/foldstate.tsx).
//   · Mail messages are keyed by durable multi-keys (`mailFoldKeys`):
//       - `op:${client_op}` (minted before send, shared by ghost, queued mail, and transcript row)
//       - `mail:${id}` (server mail ID, shared by queued mail and transcript row)
//       - `ghost:${ghost_id}` (client ghost ID)
//   · When a ghost receives its server mailId via `bindPendingMail` or when
//     `useFold` mounts with multiple keys, `store.alias(keys)` unifies them.
//   · `useFold(keys)` checks `keys.some(k => store.open.has(k))` synchronously
//     during render, ensuring the delivered component mounts already expanded
//     with zero collapse/re-expand flicker.
//   · `foldKeysOf` collects pending, ghost, and transcript mail keys so stale
//     keys are pruned when a message genuinely leaves the desk.
//
// ANTI-VACUITY:
//   · §1: An expanded pending ghost remains expanded after delivery.
//   · §2: An expanded ghost remains expanded across intermediate durable queue to delivery.
//   · §3: An expanded durable queued mail without `client_op` remains expanded after delivery.
//   · §4: A collapsed pending message remains collapsed after delivery (guards against forced open).
//   · §5: Multiple messages maintain independent expansion states during reconciliation.
//   · §6: Explicit collapse while pending remains collapsed after delivery.
//   · §7: Pruning drops keys when messages leave the transcript.
//
// Run:  node apps/desktop/renderer/tests/run.mjs pendexpand

import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { addPending, bindPendingMail, refreshConvo, resetConvos } from '../src/convo'
import type { ChatMessage, PendingMail } from '../src/types'
import { foldKeysOf, mailFoldKeys } from '../src/canvas/foldstate'

const SLUG = 'org'
const NODE_ID = 'writer'

const writer: CanvasNode = {
  id: NODE_ID, generation: 2, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
}

interface Mounted {
  el: HTMLElement
  server: FakeServer
  poll: () => Promise<void>
  unmount: () => Promise<void>
}

async function desk(messages: ChatMessage[] = [], pending_mail: PendingMail[] = []): Promise<Mounted> {
  localStorage.clear()
  resetConvos()
  const server = new FakeServer()
  server.messages = messages
  server.pending_mail = pending_mail
  installFetch(server)
  const view = await mountView(
    <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug={SLUG}
      op={async () => ({})} toast={() => {}} pub={false} bare />,
    (el) => el,
  )
  await inAct(async () => {
    await refreshConvo(SLUG, NODE_ID, { force: true })
    await flush(5)
  })
  return {
    el: view.el,
    server,
    poll: async () => {
      await inAct(async () => {
        await refreshConvo(SLUG, NODE_ID, { force: true })
        await flush(5)
      })
    },
    unmount: async () => {
      await view.unmount()
      resetConvos()
    },
  }
}

// ──────────────────────────── Layout Mocking ────────────────────────────────
// jsdom has no layout engine, so getBoundingClientRect() returns zeros and Range
// rects are empty. `layout()` provides 16px rows spaced 20px apart per text node,
// identical to docketdesc.test.tsx.
const LINE = 20
const HEIGHT = 16

function layout() {
  const win = (globalThis as unknown as { window: Window & typeof globalThis }).window
  const proto = win.HTMLElement.prototype
  const realRect = proto.getBoundingClientRect
  const realWidth = Object.getOwnPropertyDescriptor(proto, 'offsetWidth')
  const realRects = win.Range.prototype.getClientRects
  const seen = new Map<Node, number>()
  proto.getBoundingClientRect = function (this: HTMLElement) {
    return {
      top: 0, left: 0, right: 400, bottom: 2000, width: 400, height: 2000,
      x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect
  }
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => 400 })
  win.Range.prototype.getClientRects = function (this: Range) {
    const node = this.startContainer
    if (!seen.has(node)) seen.set(node, seen.size)
    const i = seen.get(node)!
    return [{
      top: i * LINE, bottom: i * LINE + HEIGHT, left: 0, right: 200,
      width: 200, height: HEIGHT, x: 0, y: i * LINE,
      toJSON: () => ({}),
    } as DOMRect] as unknown as DOMRectList
  }
  return () => {
    proto.getBoundingClientRect = realRect
    if (realWidth) Object.defineProperty(proto, 'offsetWidth', realWidth)
    else delete (proto as unknown as Record<string, unknown>).offsetWidth
    win.Range.prototype.getClientRects = realRects
  }
}

// ──────────────────────────── Helpers ───────────────────────────────────────

/** Generate a body with N paragraphs (> 5 lines folds under MAIL_FOLD_LINES = 5). */
function longBody(tag: string, count = 8): string {
  const lines: string[] = []
  for (let i = 1; i <= count; i++) {
    lines.push(`Paragraph ${i} of ${tag}: detailed description content line ${i}.`)
  }
  return lines.join('\n\n')
}

/** Find a turn-mail card by a substring of its content. */
function findCard(el: HTMLElement, snippet: string): HTMLElement {
  const cards = [...el.querySelectorAll('.turn-mail')] as HTMLElement[]
  const match = cards.find((c) => (c.textContent ?? '').includes(snippet))
  assert.ok(match, `card containing "${snippet.slice(0, 30)}" not found (total cards: ${cards.length})`)
  return match
}

/** Assert and return whether a card is expanded. Checks both aria-expanded and class consistency. */
function isExpanded(card: HTMLElement): boolean {
  const toggle = card.querySelector('.turn-mail-toggle')
  assert.ok(toggle, 'card must render a .turn-mail-toggle button')
  const aria = toggle.getAttribute('aria-expanded')
  const preview = card.querySelector('.turn-mail-preview')
  assert.ok(preview, 'card must render a .turn-mail-preview element')
  const isFoldedClass = preview.classList.contains('folded')
  assert.equal(aria === 'true', !isFoldedClass,
    'DOM consistency: aria-expanded="true" must match absence of .folded class')
  return aria === 'true'
}

/** Click an element within act and flush ticks. */
async function click(el: Element | null | undefined, what: string): Promise<void> {
  assert.ok(el, `nothing to click for ${what}`)
  await inAct(async () => {
    (el as HTMLElement).click()
    await flush(5)
  })
}

// ──────────────────────────── Tests ─────────────────────────────────────────

test('§1 THE PRIMARY BUG: an expanded pending ghost remains expanded across POST bind and delivery to transcript', async () => {
  const restoreLayout = layout()
  const body = longBody('PRIMARY-BUG-1')
  const op = 'op-primary-1'
  const mailId = 'mail-primary-1'
  const m = await desk()
  try {
    // 1. User submits a long message: optimistic ghost paints
    let ghostId = 0
    await inAct(async () => {
      ghostId = addPending(SLUG, NODE_ID, body, null, undefined, op)
      await flush(5)
    })
    let card = findCard(m.el, 'PRIMARY-BUG-1')
    assert.equal(isExpanded(card), false, 'newly submitted ghost must start folded')

    // 2. User expands the ghost while it is pending
    const toggle = card.querySelector('.turn-mail-toggle')
    await click(toggle, 'the turn-mail-toggle on pending ghost')
    assert.equal(isExpanded(card), true, 'clicking toggle must expand the pending ghost')

    // 3. Server answers POST and binds mailId to the ghost
    await inAct(async () => {
      bindPendingMail(SLUG, NODE_ID, ghostId, { id: mailId, from: '@user', body, at: new Date().toISOString() })
      await flush(5)
    })
    card = findCard(m.el, 'PRIMARY-BUG-1')
    assert.equal(isExpanded(card), true, 'ghost must remain expanded after mailId binding')

    // 4. Message reconciles into delivered transcript row
    m.server.messages.push({
      role: 'user', seq: 1, event_id: 'ev-1',
      segments: [{
        kind: 'mail',
        rows: [{
          id: mailId, client_op: op, from: '@user', at: new Date().toISOString(),
          kind: 'message', body,
        }],
      }],
    })
    await m.poll()

    // 5. Delivered card must STILL be expanded
    card = findCard(m.el, 'PRIMARY-BUG-1')
    assert.equal(isExpanded(card), true,
      'THE BUG: expanded pending message collapsed upon transitioning to delivered transcript entry')
    const toggleAfter = card.querySelector('.turn-mail-toggle')
    assert.ok(toggleAfter?.textContent?.includes('click to collapse'),
      'toggle label must indicate expanded state')
  } finally {
    await m.unmount()
    restoreLayout()
  }
})

test('§2 MULTI-STEP PIPELINE: ghost -> durable queued mail -> delivered transcript entry', async () => {
  const restoreLayout = layout()
  const body = longBody('PIPELINE-2')
  const op = 'op-pipe-2'
  const mailId = 'mail-pipe-2'
  const m = await desk()
  try {
    // 1. Submit optimistic ghost
    let ghostId = 0
    await inAct(async () => {
      ghostId = addPending(SLUG, NODE_ID, body, null, undefined, op)
      await flush(5)
    })
    let card = findCard(m.el, 'PIPELINE-2')
    await click(card.querySelector('.turn-mail-toggle'), 'expand pending ghost')
    assert.equal(isExpanded(card), true, 'ghost expanded')

    // 2. Bind response and server announces durable queued mail
    await inAct(async () => {
      bindPendingMail(SLUG, NODE_ID, ghostId, { id: mailId, from: '@user', body, at: new Date().toISOString() })
    })
    m.server.pending_mail.push({
      id: mailId, client_op: op, from: '@user', at: new Date().toISOString(),
      kind: 'message', body,
    })
    await m.poll()

    // Ghost retired against client_op/mailId; durable queued row renders
    card = findCard(m.el, 'PIPELINE-2')
    assert.equal(isExpanded(card), true,
      'expanded message must remain expanded in durable pending queue')

    // 3. Turn delivers queued mail into transcript
    m.server.pending_mail = []
    m.server.messages.push({
      role: 'user', seq: 1, event_id: 'ev-pipe-2',
      segments: [{
        kind: 'mail',
        rows: [{
          id: mailId, client_op: op, from: '@user', at: new Date().toISOString(),
          kind: 'message', body,
        }],
      }],
    })
    await m.poll()

    // Delivered transcript row must remain expanded
    card = findCard(m.el, 'PIPELINE-2')
    assert.equal(isExpanded(card), true,
      'expanded message must remain expanded across queue drain and transcript delivery')
  } finally {
    await m.unmount()
    restoreLayout()
  }
})

test('§3 DURABLE QUEUED MAIL WITHOUT CLIENT_OP: expanding in queue stays expanded upon delivery', async () => {
  const restoreLayout = layout()
  const body = longBody('AGENT-MAIL-3')
  const mailId = 'mail-agent-3'
  // Mail arrives directly in pending_mail without a client_op (e.g. from an agent or API send)
  const m = await desk()
  try {
    m.server.pending_mail.push({
      id: mailId, from: 'agent-helper', at: new Date().toISOString(),
      kind: 'message', body,
    })
    await m.poll()

    let card = findCard(m.el, 'AGENT-MAIL-3')
    assert.equal(isExpanded(card), false, 'starts collapsed in queue')

    // Expand while queued
    await click(card.querySelector('.turn-mail-toggle'), 'expand queued agent mail')
    assert.equal(isExpanded(card), true, 'expanded in queue')

    // Server delivers into transcript
    m.server.pending_mail = []
    m.server.messages.push({
      role: 'user', seq: 1, event_id: 'ev-3',
      segments: [{
        kind: 'mail',
        rows: [{
          id: mailId, from: 'agent-helper', at: new Date().toISOString(),
          kind: 'message', body,
        }],
      }],
    })
    await m.poll()

    card = findCard(m.el, 'AGENT-MAIL-3')
    assert.equal(isExpanded(card), true,
      'queued mail without client_op must stay expanded after delivery via mailId key')
  } finally {
    await m.unmount()
    restoreLayout()
  }
})

test('§4 ANTI-VACUITY: collapsed pending message remains collapsed after delivery', async () => {
  const restoreLayout = layout()
  const body = longBody('COLLAPSED-4')
  const op = 'op-col-4'
  const mailId = 'mail-col-4'
  const m = await desk()
  try {
    await inAct(async () => {
      addPending(SLUG, NODE_ID, body, null, undefined, op)
      await flush(5)
    })
    let card = findCard(m.el, 'COLLAPSED-4')
    assert.equal(isExpanded(card), false, 'pending ghost starts collapsed')

    // Do NOT expand — deliver directly to transcript
    m.server.messages.push({
      role: 'user', seq: 1, event_id: 'ev-4',
      segments: [{
        kind: 'mail',
        rows: [{
          id: mailId, client_op: op, from: '@user', at: new Date().toISOString(),
          kind: 'message', body,
        }],
      }],
    })
    await m.poll()

    card = findCard(m.el, 'COLLAPSED-4')
    assert.equal(isExpanded(card), false,
      'ANTI-VACUITY: a collapsed pending message must not be forced open upon delivery')
    const toggle = card.querySelector('.turn-mail-toggle')
    assert.ok(toggle?.textContent?.includes('click to expand'),
      'toggle label must indicate collapsed state')
  } finally {
    await m.unmount()
    restoreLayout()
  }
})

test('§5 ANTI-VACUITY: multiple messages maintain independent expansion states during reconciliation', async () => {
  const restoreLayout = layout()
  const bodyA = longBody('INDEP-MSG-A')
  const bodyB = longBody('INDEP-MSG-B')
  const opA = 'op-indep-A', mailIdA = 'mail-indep-A'
  const opB = 'op-indep-B', mailIdB = 'mail-indep-B'
  const m = await desk()
  try {
    let ghostA = 0, ghostB = 0
    await inAct(async () => {
      ghostA = addPending(SLUG, NODE_ID, bodyA, null, undefined, opA)
      ghostB = addPending(SLUG, NODE_ID, bodyB, null, undefined, opB)
      await flush(5)
    })

    let cardA = findCard(m.el, 'INDEP-MSG-A')
    let cardB = findCard(m.el, 'INDEP-MSG-B')
    assert.equal(isExpanded(cardA), false)
    assert.equal(isExpanded(cardB), false)

    // Expand message A ONLY
    await click(cardA.querySelector('.turn-mail-toggle'), 'expand message A')
    assert.equal(isExpanded(cardA), true, 'message A must be expanded')
    assert.equal(isExpanded(cardB), false, 'message B must remain collapsed')

    // Bind responses
    await inAct(async () => {
      bindPendingMail(SLUG, NODE_ID, ghostA, { id: mailIdA, from: '@user', body: bodyA, at: new Date().toISOString() })
      bindPendingMail(SLUG, NODE_ID, ghostB, { id: mailIdB, from: '@user', body: bodyB, at: new Date().toISOString() })
    })

    // Deliver both into transcript
    m.server.messages.push({
      role: 'user', seq: 1, event_id: 'ev-indep',
      segments: [{
        kind: 'mail',
        rows: [
          { id: mailIdA, client_op: opA, from: '@user', at: new Date().toISOString(), kind: 'message', body: bodyA },
          { id: mailIdB, client_op: opB, from: '@user', at: new Date().toISOString(), kind: 'message', body: bodyB },
        ],
      }],
    })
    await m.poll()

    cardA = findCard(m.el, 'INDEP-MSG-A')
    cardB = findCard(m.el, 'INDEP-MSG-B')
    assert.equal(isExpanded(cardA), true,
      'reconciled message A must remain expanded')
    assert.equal(isExpanded(cardB), false,
      'ANTI-VACUITY: message A expansion must not leak to message B')
  } finally {
    await m.unmount()
    restoreLayout()
  }
})

test('§6 EXPLICIT COLLAPSE: pending message expanded then collapsed remains collapsed after delivery', async () => {
  const restoreLayout = layout()
  const body = longBody('RE-COLLAPSE-6')
  const op = 'op-recol-6'
  const mailId = 'mail-recol-6'
  const m = await desk()
  try {
    await inAct(async () => {
      addPending(SLUG, NODE_ID, body, null, undefined, op)
      await flush(5)
    })
    let card = findCard(m.el, 'RE-COLLAPSE-6')

    // Expand
    await click(card.querySelector('.turn-mail-toggle'), 'expand pending ghost')
    assert.equal(isExpanded(card), true, 'ghost expanded')

    // Explicitly collapse
    await click(card.querySelector('.turn-mail-toggle'), 'collapse pending ghost')
    assert.equal(isExpanded(card), false, 'ghost collapsed again')

    // Deliver to transcript
    m.server.messages.push({
      role: 'user', seq: 1, event_id: 'ev-6',
      segments: [{
        kind: 'mail',
        rows: [{
          id: mailId, client_op: op, from: '@user', at: new Date().toISOString(),
          kind: 'message', body,
        }],
      }],
    })
    await m.poll()

    card = findCard(m.el, 'RE-COLLAPSE-6')
    assert.equal(isExpanded(card), false,
      'explicitly collapsed message must remain collapsed after delivery')
  } finally {
    await m.unmount()
    restoreLayout()
  }
})

test('§7 PRUNING: removed messages have their expansion keys pruned from the store', async () => {
  const restoreLayout = layout()
  const body = longBody('PRUNE-7')
  const op = 'op-prune-7'
  const mailId = 'mail-prune-7'
  const m = await desk([{
    role: 'user', seq: 1, event_id: 'ev-7',
    segments: [{
      kind: 'mail',
      rows: [{
        id: mailId, client_op: op, from: '@user', at: new Date().toISOString(),
        kind: 'message', body,
      }],
    }],
  }])
  try {
    let card = findCard(m.el, 'PRUNE-7')
    await click(card.querySelector('.turn-mail-toggle'), 'expand delivered mail')
    assert.equal(isExpanded(card), true)

    // Verify foldKeysOf includes the keys while on screen
    const liveKeys = foldKeysOf(m.server.messages)
    assert.ok(liveKeys.has('op:' + op), 'keys include op before removal')
    assert.ok(liveKeys.has('mail:' + mailId), 'keys include mailId before removal')

    // Clear messages from server and poll to simulate leaving transcript
    m.server.messages = []
    await m.poll()

    const prunedKeys = foldKeysOf(m.server.messages)
    assert.equal(prunedKeys.has('op:' + op), false, 'keys no longer include op')
    assert.equal(prunedKeys.has('mail:' + mailId), false, 'keys no longer include mailId')
  } finally {
    await m.unmount()
    restoreLayout()
  }
})

test('§8 mailFoldKeys contract handles all row shapes and identity combinations', () => {
  // Ghost with op and ghost id
  assert.deepEqual(
    mailFoldKeys({ id: null, client_op: 'op-1', ghost_id: 101 }),
    ['op:op-1', 'ghost:101'],
  )
  // Ghost with bound mailId
  assert.deepEqual(
    mailFoldKeys({ id: 'mail-1', client_op: 'op-1', ghost_id: 101 }),
    ['op:op-1', 'mail:mail-1', 'ghost:101'],
  )
  // Queued mail with op and mailId
  assert.deepEqual(
    mailFoldKeys({ id: 'mail-2', client_op: 'op-2' }),
    ['op:op-2', 'mail:mail-2'],
  )
  // Queued mail without op
  assert.deepEqual(
    mailFoldKeys({ id: 'mail-3' }),
    ['mail:mail-3'],
  )
  // Transcript row with message_id alias
  assert.deepEqual(
    mailFoldKeys({ id: 'mail-4', message_id: 'msg-4', client_op: 'op-4' }),
    ['op:op-4', 'mail:mail-4', 'mail:msg-4'],
  )
  // Null / undefined safety
  assert.deepEqual(mailFoldKeys(null), [])
  assert.deepEqual(mailFoldKeys(undefined), [])
  assert.deepEqual(mailFoldKeys({}), [])
})

test('§9 ZERO-FLICKER: synchronous initial mount in expanded state', async () => {
  const restoreLayout = layout()
  const body = longBody('ZERO-FLICKER-9')
  const op = 'op-flicker-9'
  const mailId = 'mail-flicker-9'
  const m = await desk()
  try {
    // Submit and expand ghost
    await inAct(async () => {
      addPending(SLUG, NODE_ID, body, null, undefined, op)
      await flush(5)
    })
    const ghostCard = findCard(m.el, 'ZERO-FLICKER-9')
    await click(ghostCard.querySelector('.turn-mail-toggle'), 'expand ghost')
    assert.equal(isExpanded(ghostCard), true)

    // Replace ghost with delivered transcript row directly in server response
    m.server.messages.push({
      role: 'user', seq: 1, event_id: 'ev-9',
      segments: [{
        kind: 'mail',
        rows: [{
          id: mailId, client_op: op, from: '@user', at: new Date().toISOString(),
          kind: 'message', body,
        }],
      }],
    })
    // Ingest payload: React mounts the brand new MailMessage under typed-input
    await m.poll()

    const deliveredCard = findCard(m.el, 'ZERO-FLICKER-9')
    // Verify it is expanded immediately without needing an extra click or event
    assert.equal(isExpanded(deliveredCard), true)
    const preview = deliveredCard.querySelector('.turn-mail-preview')
    assert.equal(preview?.classList.contains('folded'), false,
      'preview must never mount with .folded class when pre-expanded in FoldStore')
  } finally {
    await m.unmount()
    restoreLayout()
  }
})
