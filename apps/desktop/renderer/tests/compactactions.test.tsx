// compactactions.test.tsx — user 2026-09-12 (uploads/image-80.png): the
// layered/stack count and the freeze badge that unsticks an agent are still
// clickable on a zoomed-out card, and they should not be.
//
// WHY, IN THE USER'S OWN WORDS. "the idea behind making these other badges
// unclickable is to make it easier for the user to click anywhere on an
// agent's surface and focus it from a distance". So this is TWO claims, not
// one: the badge must not fire its action, AND it must not take the press.
// A badge has to stop its own pointerdown to survive the viewport's pointer
// capture, so any badge that is a button is also a hole in the card's
// surface.
//
// NOT REMOVED, INERT — the same shape the doc chips took the day before
// (zoomoutcards.test.tsx): the chips stay visible, because a freeze chip you
// can see is how you know at a glance that an agent is halted. Only the
// action goes, and it goes to the DESK, which already draws both of these
// correctly: a plain freeze chip with a separate labelled `unstick` button
// beside it, and its own lineage button.
//
//   §1  both are present at compact zoom          (signs, not absences)
//   §2  neither is a button or a tab stop, and the freeze chip no longer
//       invites a click — but it is NOT aria-hidden, because "this agent is
//       halted" is status, and nothing else on the card carries it
//   §3  clicking either one does nothing
//   §4  a pointerdown on either REACHES THE CARD  (the press, given back)
//   §5  the shipped stylesheet's half, which jsdom cannot hit-test
//   §6  POSITIVE CONTROL: the desk still has both actions
//
// ⚠ WHAT jsdom CANNOT DO, AND WHERE THE REST LIVES. It performs no layout
// and no hit-testing, so `pointer-events: none` has no effect here: an event
// dispatched AT the chip still runs. §4 is therefore written as the claim
// that the chip no longer STOPS the press — the actual mechanism — and §5
// checks the stylesheet for the rule rather than pretending to observe it.
// `tools/test-compact-card-actions.mjs` drives the real canvas with real
// mouse input and watches where the click is actually delivered; that is the
// half that can see a press land on the card instead of the badge.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs compactactions

import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

declare const __SRC_DIR__: string

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5 }
const W = () => window as unknown as Window & typeof globalThis

function node(): CanvasNode {
  return {
    id: 'stuck', state: 'live', tier: 'opus', model_id: 'opus',
    children: [], seat: 5, grant: 0, free: 0, generation: 2,
    scope: { tools: {}, add_dirs: [] },
    // the two chips under test need their data
    limit_locked: true,
    frozen: { kind: 'limit', error: 'weekly limit reached', account: null, provenance: 'measured' },
    lineage: [{ id: 'stuck@1', generation: 1, state: 'archived', tier: 'opus' }],
  } as unknown as CanvasNode
}

interface Sink { lineage: number; downs: string[]; posts: string[] }

/** Every request the card makes, recorded and answered — `unstickNode` is a
 *  direct POST out of the badge's own handler, so the network is where "did
 *  the action fire" is observed without instrumenting the component. */
function watchFetch(sink: Sink) {
  // ⚠ BOTH GLOBALS. `api.ts` calls a bare `fetch`, which resolves to
  // `globalThis.fetch` — node's — while the harness's `window` is the jsdom
  // one. Patching only `window.fetch` left the recorder permanently empty,
  // which made §3's "no unstick was fired" true for the wrong reason: it
  // would have passed with the action firing on every click. §6 is what
  // catches that, and it did.
  const spy = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input)
    sink.posts.push(`${init?.method ?? 'GET'} ${url}`)
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ released: [], status: 'ok', warnings: [] }) } as unknown as Response)
  }) as typeof fetch
  const before = { g: globalThis.fetch, w: W().fetch }
  globalThis.fetch = spy; W().fetch = spy
  return () => { globalThis.fetch = before.g; W().fetch = before.w }
}

function card(focused: boolean, sink: Sink) {
  const nd = node()
  return mountView(
    <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod="norm" focused={focused}
      dragging={false} isDrop={false} seats={seats}
      map={new Map([[nd.id, nd]])} op={op} slug="org" toast={noop}
      pxc={1} zoom={1} compactAt={0.8} pub={false}
      maxTop={0} kioskRemaining={null} cascadeAlloc
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
      onInbox={noop} onLineage={() => { sink.lineage++ }} onOpenDoc={noop}
      onRecenter={noop} onJump={noop} onMailLink={noop}
      /* the card's own drag start — this IS the focus gesture's first step,
         and what a badge-that-is-a-button swallows */
      onDragStart={(_e, id) => sink.downs.push(id)}
      onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />,
    (el) => el)
}

const sink = (): Sink => ({ lineage: 0, downs: [], posts: [] })
const stack = (el: HTMLElement) => el.querySelector<HTMLElement>('.sq-badges .stackbadge')
const frozen = (el: HTMLElement) => el.querySelector<HTMLElement>('.sq-badges .badge.frozen')

test('§1 outside desk view both badges are still THERE — they are signs, not '
  + 'absences', async (t) => {
  const s = sink()
  const view = await card(false, s)
  t.after(() => view.unmount())
  assert.ok(view.el.querySelector('.sq-badges'), 'the badge row is not drawn at all')
  assert.ok(stack(view.el), 'the stack count was removed; it was meant to stay visible')
  assert.ok(frozen(view.el), 'the freeze chip was removed; a halted agent must still say so')
})

test('§2 …but neither is a control, and the freeze chip no longer invites a '
  + 'click it cannot honour', async (t) => {
  const s = sink()
  const view = await card(false, s)
  t.after(() => view.unmount())
  for (const [el, what] of [[stack(view.el)!, 'the stack count'], [frozen(view.el)!, 'the freeze chip']] as const) {
    assert.equal(el.tagName, 'SPAN', `${what} is still a button, so still has button semantics`)
    assert.equal(el.getAttribute('role'), null, `${what} still announces a role`)
    assert.equal(el.getAttribute('tabindex'), null, `${what} is a tab stop that does nothing`)
    assert.ok(el.classList.contains('inert'), `${what} is not marked inert`)
  }
  const title = frozen(view.el)!.getAttribute('title') ?? ''
  assert.doesNotMatch(title, /click to UNSTICK/,
    'the tooltip still tells the reader to click something that does nothing')
  assert.match(title, /weekly limit reached/,
    '…and it must still say what is actually wrong')
  // ⚠ THE DEPARTURE FROM THE DOC CHIPS, ON PURPOSE. Those are aria-hidden
  // because "has presented a document" is carried by other controls. Nothing
  // else on this card says the agent is halted, so hiding it would take the
  // STATUS from a screen reader while leaving it for everyone else.
  assert.equal(frozen(view.el)!.getAttribute('aria-hidden'), null,
    'a halted agent must still be halted to a screen reader')
  assert.equal(stack(view.el)!.getAttribute('aria-hidden'), null)
})

test('§3 clicking either one does nothing', async (t) => {
  const s = sink()
  const restore = watchFetch(s)
  const view = await card(false, s)
  t.after(() => { view.unmount(); restore() })
  await inAct(() => { stack(view.el)!.click() })
  assert.equal(s.lineage, 0, 'the inert stack count still opened the lineage')
  await inAct(() => { frozen(view.el)!.click() })
  await inAct(async () => {})
  assert.deepEqual(s.posts.filter((p) => p.includes('/unstick')), [],
    'the inert freeze chip still unstuck the agent — the most consequential '
    + 'thing on the card, fired from a view meant only to choose a desk')
})

test('§4 THE SWALLOWED PRESS: a pointerdown on either badge now reaches the '
  + 'agent card', async (t) => {
  const s = sink()
  const view = await card(false, s)
  t.after(() => view.unmount())
  const press = (el: HTMLElement) => inAct(() => {
    el.dispatchEvent(new (W().MouseEvent)('pointerdown', { bubbles: true, cancelable: true }))
  })
  await press(stack(view.el)!)
  await press(frozen(view.el)!)
  assert.deepEqual(s.downs, ['stuck', 'stuck'],
    'a badge is still stopping the press that focuses the agent — the user '
    + 'asked to be able to click anywhere on an agent and focus it')
})

test('§5 the stylesheet stops looking like a control too', async () => {
  // jsdom does no hit-testing, so this is a claim about the shipped CSS and
  // is checked as one. §4 is the behavioural half and does not depend on it.
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const inert = css.match(/\.badge\.inert\s*\{([^}]*)\}/)
  assert.ok(inert, 'no .badge.inert rule — the class is inert in name only')
  assert.match(inert[1]!, /pointer-events:\s*none/)
  // ⚠ `.stackbadge`'s cursor and hover were NOT scoped to `button`, unlike
  // `button.badge.frozen` beside them. Unscoped, an inert span still shows a
  // pointer cursor and still lights up on hover — it goes on looking like a
  // control it is not.
  const base = css.match(/^\.stackbadge\s*\{([^}]*)\}/m)
  assert.ok(base, 'the base .stackbadge rule has gone')
  assert.doesNotMatch(base[1]!, /cursor:\s*pointer/,
    'the pointer cursor is back on every .stackbadge, inert ones included')
  assert.match(css, /button\.stackbadge\s*\{[^}]*cursor:\s*pointer/,
    'a live stack badge in desk view must still look clickable')
  assert.match(css, /button\.stackbadge:hover/,
    'the hover highlight must be scoped to the button form, not dropped')
})

test('§6 POSITIVE CONTROL: in desk view both actions are still there and '
  + 'still work', async (t) => {
  // Everything above says something does NOT happen, and all of it would
  // pass just as well against a build where both actions had been deleted.
  // The desk is where they moved to, so the desk is where the control lives.
  const s = sink()
  const restore = watchFetch(s)
  const view = await card(true, s)
  t.after(() => { view.unmount(); restore() })
  const unstick = view.el.querySelector<HTMLElement>('.badge.unstick')
  const lineage = view.el.querySelector<HTMLElement>('.stackbadge')
  assert.ok(unstick, 'the desk lost its unstick button — the action is now nowhere')
  assert.ok(lineage, 'the desk lost its lineage button — the action is now nowhere')
  assert.equal(unstick!.tagName, 'BUTTON')
  assert.equal(lineage!.tagName, 'BUTTON')
  assert.ok(!lineage!.classList.contains('inert'), 'the inert state leaked into desk view')

  await inAct(() => { lineage!.click() })
  assert.equal(s.lineage, 1, 'the desk stack badge must still open the lineage')
  await inAct(() => { unstick!.click() })
  await inAct(async () => {})
  assert.equal(s.posts.filter((p) => p.includes('/unstick')).length, 1,
    'the desk unstick button must still unstick the agent')
})
