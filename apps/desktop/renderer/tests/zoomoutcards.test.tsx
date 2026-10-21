// zoomoutcards.test.tsx — user 2026-09-11: "dont make any cards in agents
// when zoomed out clickable."
//
// WHICH CARDS. An agent card carries presented-document cards on its edge
// (`DocChips` → `PresentationCard`, class `.doc-chip`). They were the last
// OPERABLE thing on a far-zoom card: the shortcut row (`.sq-actions`) and the
// badge row (`.sq-badges`) are unmounted at `mini` already, on this same
// threshold and for this same reason — a screen-constant control drawn OVER
// an ever-smaller card swallows the click that focuses the agent, because
// PresentationCard stops the pointerdown and so starves the drag-end →
// centerOn path.
//
// (The hire strips were in that list until 2026-09-11, when the user asked
// for them back at maximum zoom — they sit OUTSIDE the card rather than over
// it, so they take nothing from it. tests/minihire.test.tsx and
// tests/minihire_probe.py own that behaviour; nothing here depends on it.)
//
// USER 2026-10-13 superseded the visible-inert attachment rule: presented
// markdown/HTML chips unmount at mini. The agent card remains the focus/drag
// and context-menu target; its document attachment returns at normal zoom.
// Keep the normal-zoom positive controls and shared-threshold audit, so an
// always-missing document surface cannot pass these absence checks.
// The lower-level inert stylesheet remains checked independently.
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
const W = () => window as unknown as Window & typeof globalThis

function node(): CanvasNode {
  return {
    id: 'presenter', state: 'live', tier: 'haiku', model_id: 'haiku',
    children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] },
    documents: [{ id: 'd1', title: 'the plan', format: 'md' }],
  } as unknown as CanvasNode
}

function card(lod: 'mini' | 'norm',
  sink: { opened: string[]; downs: string[] } = { opened: [], downs: [] }) {
  const nd = node()
  return mountView(
    <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod={lod} focused={false}
      dragging={false} isDrop={false} seats={seats}
      map={new Map([[nd.id, nd]])} op={op} slug="org" toast={noop}
      pxc={1} zoom={lod === 'mini' ? 0.4 : 1} compactAt={0.8}
      maxTop={0} cascadeAlloc
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
      onInbox={noop} onLineage={noop} onOpenDoc={(id) => sink.opened.push(id)}
      onRecenter={noop} onJump={noop} onMailLink={noop}
      /* the card's own drag start — this IS the focus gesture's first step,
         and what the chip used to swallow */
      onDragStart={(_e, id) => sink.downs.push(id)}
      onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />,
    (el) => el)
}

const chip = (el: HTMLElement) => el.querySelector<HTMLElement>('.doc-chip')

test('§1 mini omits the document attachment while preserving its owning agent card', async t => {
  const view = await card('mini'); t.after(() => view.unmount())
  assert.ok(view.el.querySelector('.sq'), 'the owning card rendered')
  assert.equal(node().documents?.length, 1, 'the fixture has a document to omit')
  assert.equal(chip(view.el) === null, true, 'mini unmounts the document chip')
  assert.equal(view.el.querySelector('.doc-chips') === null, true, 'the whole attachment surface unmounts')
})

test('§2 mini has no document button, tab stop or read tooltip', async t => {
  const view = await card('mini'); t.after(() => view.unmount())
  assert.ok(view.el.querySelector('.sq-far-tier'), 'the far card content rendered')
  assert.equal(view.el.querySelectorAll('.doc-chip, .doc-chips, [title="the plan"]').length, 0)
})

test('§3 clicking the mini card does not open its omitted document', async t => {
  const sink = { opened: [] as string[], downs: [] as string[] }
  const view = await card('mini', sink); t.after(() => view.unmount())
  await inAct(() => { view.el.querySelector<HTMLElement>('.sq')!.click() })
  assert.deepEqual(sink.opened, [])
})

test('§4 right-clicking mini offers the agent menu, never the document menu', async t => {
  const view = await card('mini'); t.after(() => view.unmount())
  const ev = new (W().MouseEvent)('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })
  await inAct(() => { view.el.querySelector('.sq')!.dispatchEvent(ev) })
  const labels = [...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map(el => el.textContent)
  assert.deepEqual(labels.slice(0, 2), ['Copy mention', 'Open ▸'])
  assert.ok(labels.includes('Focus'), 'the agent focus route is retained')
  assert.equal(labels.includes('Download'), false, 'no presentation-specific action')
})

test('§5 a pointerdown on mini reaches its agent drag/focus path', async t => {
  const sink = { opened: [] as string[], downs: [] as string[] }
  const view = await card('mini', sink); t.after(() => view.unmount())
  const ev = new (W().MouseEvent)('pointerdown', { bubbles: true, cancelable: true })
  await inAct(() => { view.el.querySelector('.sq')!.dispatchEvent(ev) })
  assert.deepEqual(sink.downs, ['presenter'])
})

test('§5b …and at normal zoom it still stops it, which is correct there — '
  + 'the chip is a real control again', async (t) => {
  const sink = { opened: [] as string[], downs: [] as string[] }
  const view = await card('norm', sink)
  t.after(() => view.unmount())
  const ev = new (W().MouseEvent)('pointerdown', { bubbles: true, cancelable: true })
  await inAct(() => { chip(view.el)!.dispatchEvent(ev) })
  assert.deepEqual(sink.downs, [],
    'pressing a live chip must not also start dragging the agent')
})

test('§6 the sheet lets the pointer through at mini', async () => {
  // jsdom does no hit-testing, so this is a claim about the shipped CSS and
  // is checked as one. §5 is the behavioural half and does not depend on it.
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const rule = css.match(/\.doc-chips\.inert\s*\{([^}]*)\}/)
  assert.ok(rule, 'no .doc-chips.inert rule — the class is inert in name only')
  assert.match(rule[1]!, /pointer-events:\s*none/)
  // and the live chips are NOT affected
  const live = css.match(/^\.doc-chips\s*\{([^}]*)\}/m)
  assert.ok(live, 'the base .doc-chips rule has gone')
  assert.doesNotMatch(live[1]!, /pointer-events:\s*none/,
    'pointer-events:none leaked onto the live chips')
})

test('§7 zoomed in it is a live control again, and opens its document',
  async (t) => {
    const sink = { opened: [] as string[], downs: [] as string[] }
    const view = await card('norm', sink)
    t.after(() => view.unmount())
    const c = chip(view.el)!
    assert.equal(c.tagName, 'BUTTON', 'the chip did not come back as a control')
    assert.equal(c.getAttribute('aria-hidden'), null)
    assert.equal(view.el.querySelector('.doc-chips.inert'), null)
    assert.equal(c.getAttribute('title'), 'the plan')
    await inAct(() => { c.click() })
    assert.deepEqual(sink.opened, ['d1'],
      'the document card must still open its document at normal zoom — this '
      + 'is the test that fails if the inert state leaked')
  })

test('§8 the gate reuses the canvas threshold rather than inventing one',
  async () => {
    // OrgCanvas computes `lod` ONCE from Z_MINI and hands the same string to
    // every card. If a future edit gives the doc chips their own zoom number,
    // the two rules can disagree about what "zoomed out" means.
    const src = readFileSync(path.join(__SRC_DIR__, 'canvas/OrgCanvas.tsx'), 'utf8')
    assert.match(src, /const lod = view\.z < Z_MINI \? 'mini' : 'norm'/,
      'the single lod rule has moved or changed shape')
    const cards = readFileSync(path.join(__SRC_DIR__, 'canvas/cards.tsx'), 'utf8')
    assert.match(cards, /lod !== 'mini'[^\n]+\n\s*<DocChips/,
      'the document attachment must use the shared lod value')
    assert.equal(typeof Z_MINI, 'number')
  })
