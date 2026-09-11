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
// NOT REMOVED, INERT. The chips stay visible: the ask was that they not be
// clickable, and a chip you can see is how you know at a glance which agents
// have presented something. So the tests below are not absence checks. They
// say the chip is THERE and that every route into it is gone:
//
//   §1  present and visible at mini            (it is a sign, not a control)
//   §2  not a button, not a tab stop, no title (keyboard and AT get nothing)
//   §3  a click on it opens nothing
//   §4  a right-click on it raises no menu
//   §5  a pointerdown on it REACHES THE CARD   (the swallowed gesture, back)
//   §6  the sheet passes pointers through      (the half jsdom cannot hit-test)
//   §7  at normal zoom it is a button again and opens its document
//
// ⚠ §7 IS NOT OPTIONAL. §1-§6 all describe a chip that does nothing, and
// every one of them would pass against a chip that does nothing AT ANY ZOOM.
// §5b, §7 and §8 are the sections that fail if the inert state leaks into
// normal zoom — measured, by running that mutation, not assumed.
//
// ⚠ WHAT jsdom CANNOT DO. It performs no layout and no hit-testing, so
// `pointer-events: none` has no effect there: an event dispatched AT the chip
// still runs. That is why §5 is written as it is — it proves the chip no
// longer STOPS the press (the actual mechanism that starved the focus path),
// which is true with or without hit-testing — and why §6 checks the shipped
// stylesheet for the rule rather than pretending to observe it.
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
      pxc={1} zoom={lod === 'mini' ? 0.4 : 1} compactAt={0.8} pub={false}
      maxTop={0} kioskRemaining={null} cascadeAlloc
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

test('§1 zoomed out, the document card is still THERE — it is a sign, not a '
  + 'control', async (t) => {
  const view = await card('mini')
  t.after(() => view.unmount())
  assert.ok(view.el.querySelector('.sq'), 'no card rendered at all')
  const c = chip(view.el)
  assert.ok(c, 'the document chip was removed; it was meant to stay visible')
  assert.ok(view.el.querySelector('.doc-chips.inert'),
    'the container is not marked inert, so the sheet cannot reach it')
})

test('§2 …but it is not a button, not a tab stop, and offers nothing to a '
  + 'screen reader', async (t) => {
  const view = await card('mini')
  t.after(() => view.unmount())
  const c = chip(view.el)!
  // the tag itself is the assertion: at this zoom the chip is not an action,
  // so it must not be a control of any kind
  assert.equal(c.tagName, 'SPAN', 'still a button, so still has button semantics')
  assert.equal(c.getAttribute('role'), null)
  assert.equal(c.getAttribute('tabindex'), null, 'a tab stop that does nothing')
  assert.equal(c.getAttribute('aria-hidden'), 'true')
  assert.equal(c.getAttribute('title'), null,
    'a "read the plan" tooltip on something that cannot be read is the lie')
})

test('§3 clicking it opens nothing', async (t) => {
  const sink = { opened: [] as string[], downs: [] as string[] }
  const view = await card('mini', sink)
  t.after(() => view.unmount())
  await inAct(() => { chip(view.el)!.click() })
  assert.deepEqual(sink.opened, [], 'the inert chip still opened its document')
})

test('§4 right-clicking it raises no menu of its own', async (t) => {
  const view = await card('mini')
  t.after(() => view.unmount())
  const ev = new (W().MouseEvent)('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })
  await inAct(() => { chip(view.el)!.dispatchEvent(ev) })
  assert.equal(document.querySelector('.ctxmenu [role="menuitem"]')?.textContent,
    // the CARD's menu may legitimately open (the event bubbles to it); what
    // must not appear is the presentation card's own "Open"/"Copy"/"Download"
    'Open desk',
    'the chip raised its own menu instead of letting the card have the press')
})

test('§5 THE SWALLOWED GESTURE: a pointerdown on the chip now reaches the '
  + 'agent card', async (t) => {
  const sink = { opened: [] as string[], downs: [] as string[] }
  const view = await card('mini', sink)
  t.after(() => view.unmount())
  const ev = new (W().MouseEvent)('pointerdown', { bubbles: true, cancelable: true })
  await inAct(() => { chip(view.el)!.dispatchEvent(ev) })
  assert.deepEqual(sink.downs, ['presenter'],
    'the chip is still stopping the press that focuses the agent — this is '
    + 'the exact mechanism the user is reporting')
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
    assert.match(c.getAttribute('title') ?? '', /read the plan/)
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
    assert.match(cards, /inert=\{lod === 'mini'\}/,
      'the doc chips are not gated on the shared lod value')
    assert.equal(typeof Z_MINI, 'number')
  })
