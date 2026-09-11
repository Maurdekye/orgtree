// zoomoutcards.test.tsx — user 2026-09-11: "dont make any cards in agents
// when zoomed out clickable."
//
// WHICH CARDS. An agent card carries presented-document cards on its edge
// (`DocChips` → `PresentationCard`, class `.doc-chip`). They were the last
// interactive thing still mounted on a far-zoom card: the shortcut row
// (`.sq-actions`), the badge row (`.sq-badges`) and the hire chips were each
// unmounted at `mini` already, on this same threshold and for this same
// reason — a screen-constant control on an ever-smaller card swallows the
// click that focuses the agent, because PresentationCard stops the
// pointerdown and so starves the drag-end → centerOn path.
//
// So this is one property with two halves, and the halves are inseparable:
// GONE at `mini`, BACK at `norm`. §1 alone would pass against a component
// that never renders doc chips at all; §2 is what refuses that.
//
// ⚠ THE THRESHOLD IS NOT A NEW ONE. `lod` is computed once in OrgCanvas
// (`view.z < Z_MINI ? 'mini' : 'norm'`) and handed to every card. §4 pins
// that this file did not invent a second rule — the gate is the same string
// the three sibling gates read.
//
// Run:  cd frontend && node tests/run.mjs zoomoutcards

import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NodeSquare } from '../src/canvas/cards'
import { Z_MINI } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

declare const __SRC_DIR__: string

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5 }

function node(): CanvasNode {
  return {
    id: 'presenter', state: 'live', tier: 'haiku', model_id: 'haiku',
    children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] },
    documents: [{ id: 'd1', title: 'the plan', format: 'md' }],
  } as unknown as CanvasNode
}

function card(lod: 'mini' | 'norm', opened: string[] = []) {
  const nd = node()
  return mountView(
    <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod={lod} focused={false}
      dragging={false} isDrop={false} seats={seats}
      map={new Map([[nd.id, nd]])} op={op} slug="org" toast={noop}
      pxc={1} zoom={lod === 'mini' ? 0.4 : 1} compactAt={0.8} pub={false}
      maxTop={0} kioskRemaining={null} cascadeAlloc
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
      onInbox={noop} onLineage={noop} onOpenDoc={(id) => opened.push(id)}
      onRecenter={noop} onJump={noop} onMailLink={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop}
      onDragCancel={noop} />,
    (el) => el)
}

test('§1 zoomed out, an agent carries no clickable document cards', async (t) => {
  const view = await card('mini')
  t.after(() => view.unmount())

  // POSITIVE CONTROL — the card itself really rendered. Every assertion below
  // is a negative, and a negative is free against an empty mount.
  assert.ok(view.el.querySelector('.sq'), 'no card rendered at all')

  assert.equal(view.el.querySelectorAll('.doc-chip').length, 0,
    'a document card is still on the zoomed-out agent')
  // …and not merely hidden: no hit target, no tab stop, no menu host
  assert.equal(view.el.querySelector('.doc-chips'), null,
    'the chip container survives, so something can still take a pointer')
})

test('§2 …and zoomed in they are back, and they open the document', async (t) => {
  const opened: string[] = []
  const view = await card('norm', opened)
  t.after(() => view.unmount())

  const chips = view.el.querySelectorAll<HTMLButtonElement>('.doc-chip')
  assert.equal(chips.length, 1,
    'the document card must return at normal zoom — without this, §1 passes '
    + 'for a component that simply never shows one')
  await inAct(() => { chips[0]!.click() })
  assert.deepEqual(opened, ['d1'], 'the card must still open its document')
})

test('§3 the gesture the chips used to swallow — the click that focuses the '
  + 'agent — has nothing left in its way at mini', async (t) => {
  const view = await card('mini')
  t.after(() => view.unmount())
  // PresentationCard stops pointerdown; that is the specific mechanism that
  // starved the focus path. At mini there must be no element left on the
  // card that does so.
  const stoppers = view.el.querySelectorAll('.doc-chip, .sq-actions, .sq-badges')
  assert.equal(stoppers.length, 0,
    `${stoppers.length} interactive overlay(s) remain on a far-zoom card`)
})

test('§4 the gate reuses the canvas threshold rather than inventing one',
  async () => {
  // OrgCanvas computes `lod` ONCE from Z_MINI and hands the same string to
  // every card. If a future edit gives the doc chips their own zoom number,
  // the two rules can disagree about what "zoomed out" means — this is what
  // says they must not.
  const src = readFileSync(path.join(__SRC_DIR__, 'canvas/OrgCanvas.tsx'), 'utf8')
  assert.match(src, /const lod = view\.z < Z_MINI \? 'mini' : 'norm'/,
    'the single lod rule has moved or changed shape')
  const cards = readFileSync(path.join(__SRC_DIR__, 'canvas/cards.tsx'), 'utf8')
  assert.match(cards, /lod !== 'mini'\r?\n?\s*&& \(node\.documents\?\.length \?\? 0\) > 0/,
    'the doc chips are not gated on the shared lod value')
  assert.equal(typeof Z_MINI, 'number')
})
