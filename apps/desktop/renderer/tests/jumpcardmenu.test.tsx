// jumpcardmenu.test.tsx — THE FLOATING NEIGHBOR JUMP CARDS OFFER THE AGENT'S
// OWN CANONICAL MENU (docket item
// `open-agent-context-menu-from-floating-neighbor-j`).
//
// THE GAP, as filed: with an agent's desk focused, the floating jump cards at
// the window edges — one per off-screen live sibling, `OrgCanvas`'s
// `.edge-jump` buttons — answered a right-click with NOTHING AT ALL. Not a
// reduced menu, no menu: the button carried neither a copy object
// (`data-copy-agent-name`) nor a navigation marker (`data-agent-nav`), so the
// app-level `ObjectMenuBoundary` had no object to draw for and left the press
// to the browser.
//
// WHY IT WAS INVISIBLE TO THE EXISTING GUARDS, since that is the interesting
// part and the reason this file is written the way it is:
//   * `agentnavmenu.test.tsx` §3 ENUMERATES every `[data-agent-nav]` element
//     the canvas renders and holds each to the canonical menu — but it can
//     only enumerate what is MARKED, so an unmarked surface is not a failure
//     it can see. Its fixture is also a single sibling, and the floating cards
//     are drawn only for a sibling that is off-screen: with one child there is
//     no card at all.
//   * §4 is a SOURCE check, and it keys on the class `cc-name-jump`. The edge
//     card draws `.ej-name`, so the file that forgot the marker was not one
//     §4 looked at.
//   * `edgejump.test.ts` is about PLACEMENT, and it tests the pure placement
//     function precisely because jsdom has no box model.
//   So the surface fell between three nets, each of which was right about
//   what it covered.
//
// ⚠ THE FIX IS TWO PARTS AND THE FIRST ONE ALONE IS NOTHING. Marking the card
// with `agentNavProps` says WHICH AGENT a press is about; it does not deliver
// the press anywhere. The entries are served by a `contextmenu` handler on an
// `ObjectMenuBoundary`, and these cards are siblings of the desk surface, not
// descendants of it — the desk's own marked targets sit inside
// `movable-events` (popout.tsx), which IS a boundary, and that is the whole
// reason marking them sufficed. Measured, not reasoned: with the marker added
// and no boundary, a dispatched `contextmenu` on the card still reported
// `{"prevented":false,"menu":false}` — byte-for-byte the pre-fix reading — and
// §1 failed with "the l floating card (left): the right-click was taken". The
// cards now sit in their own `ObjectMenuBoundary`, `display: contents` so the
// wrapper is not a box and they stay positioned against `.viewport`. §3 holds
// both halves, because either one alone leaves the card inert.
//
// ⚠ THE CENTRAL ASSERTION IS AN EQUALITY AGAINST THE AGENTS LIST ROW, and it
// is deliberately NOT "the menu is non-empty". Each card must offer the SAME
// menu that agent's own row offers — the surface that had the canonical menu
// before this ticket existed — so the test fails if a card raises a
// surface-specific subset, and fails if a card is bound to the wrong agent.
//
// ⚠ AND THE FIXTURE MAKES THE TWO CARDS' MENUS GENUINELY DIFFERENT, which is
// what stops the equality being vacuous. The left neighbor has no reports and
// the right neighbor has a live report, so their canonical menus differ in a
// way a wrong-agent binding cannot hide: `Retire…` versus
// `Retire all subordinates…` + `Dissolve suborganization…`. §1 asserts the two
// reference menus differ before it compares anything to them — a suite where
// both agents happened to offer the same list would prove nothing about which
// card pointed where.
//
// Under jsdom every box is 0×0, so the viewport rect is stubbed exactly as
// `canvasanchor.test.tsx` stubs it: the floating cards are placed from real
// geometry (`vp.width`, the free region, the neighbors' screen rects) and are
// simply not rendered at all without it. Nothing else here reads a size.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs jumpcardmenu

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock,
  useFakeClock,
} from './harness'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AGENT_NAV_ATTR } from '../src/canvas/agentnav'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { resetConvos } from '../src/convo'
import { forgetPins } from '../src/canvas/pins'
import { setCrowdPilesOn } from '../src/canvas/shared'
import type { OpRequest } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

declare const __SRC_DIR__: string
const W = window as unknown as Window & typeof globalThis

// ------------------------------------------------------------------ fixture
// (agentnavmenu.test.tsx's, verbatim — one fixture idiom for the canvas)
const asTree = (v: unknown) => v as TreePayload
function mkNode(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
    ...extra,
  }
}
function tree(roots: unknown[]): TreePayload {
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots, cost_usd_total: 0,
    audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}
type Cap = { setPointerCapture?: unknown; releasePointerCapture?: unknown; hasPointerCapture?: unknown }
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Cap } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture, h: proto.hasPointerCapture }
  proto.setPointerCapture = () => {}; proto.releasePointerCapture = () => {}; proto.hasPointerCapture = () => false
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r; proto.hasPointerCapture = had.h }
}

/** The viewport box the floating cards are placed against. Big enough that the
 *  desk fit leaves a real strip beside it, which is where the cards live. */
const VP = { w: 1280, h: 900 }

interface Canvas { el: HTMLElement; ops: OpRequest[] }
async function mountCanvas(t: TestContext, roots: unknown[]): Promise<Canvas> {
  t.after(stubPointerCapture())
  resetConvos()
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  // ⚠ THE VIEWPORT MUST MEASURE. `edgeJumps` bails on `!vp.width`, so under
  // jsdom's zero-box model no floating card is rendered at all and every
  // assertion below would pass by finding nothing.
  const proto = HTMLElement.prototype
  const real = proto.getBoundingClientRect
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList?.contains('viewport')) {
      return { x: 0, y: 0, left: 0, top: 0, width: VP.w, height: VP.h,
        right: VP.w, bottom: VP.h, toJSON() {} } as DOMRect
    }
    return real.call(this)
  }
  const ops: OpRequest[] = []
  const v = await mountView(
    <OrgCanvas tree={tree(roots)} slug="mine"
      op={(b) => { ops.push(b); return Promise.resolve({}) }}
      toast={() => {}} mailEvt={null} onOpenAgentGallery={() => {}} />,
    (h) => h)
  t.after(async () => { proto.getBoundingClientRect = real; await v.unmount() })
  await flush(); await advance(400, 50); await flush()
  return { el: v.el, ops }
}

// -------------------------------------------------------------- the gestures
async function rightClick(el: Element): Promise<boolean> {
  const ev = new W.MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })
  await inAct(() => { el.dispatchEvent(ev) })
  await flush(2)
  return ev.defaultPrevented
}
const menuEl = () => document.querySelector('.ctxmenu') as HTMLElement | null
const labels = () => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .map((b) => (b as HTMLButtonElement).textContent ?? '')
async function esc() {
  await inAct(() => {
    document.body.dispatchEvent(new W.KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await flush(2)
}
/** the menu an object offers, read and then dismissed */
async function menuOf(target: Element, what: string): Promise<string[]> {
  assert.equal(await rightClick(target), true, `${what}: the right-click was taken`)
  assert.ok(menuEl(), `${what}: a menu opened`)
  const have = labels()
  await esc()
  assert.equal(menuEl(), null, `${what}: Escape dismissed the menu`)
  return have
}

async function openTray(el: HTMLElement): Promise<HTMLElement> {
  if (!el.querySelector('.tray')) {
    const toggle = el.querySelector('.tray-toggle') as HTMLElement
    assert.ok(toggle, 'the agents list toggle rendered')
    await inAct(() => { toggle.click() })
    await flush(2)
  }
  const tray = el.querySelector('.tray') as HTMLElement | null
  assert.ok(tray, 'the Agents List opened')
  return tray!
}
const rowFor = (el: HTMLElement, id: string) =>
  [...el.querySelectorAll('.tray-row')].find((r) =>
    r.querySelector('.tray-name')?.textContent === id) as HTMLElement | undefined

/** open a desk the way the Agents List opens one */
async function openDesk(c: Canvas, id: string): Promise<void> {
  await openTray(c.el)
  const main = rowFor(c.el, id)?.querySelector('.tray-main') as HTMLElement | undefined
  assert.ok(main, `${id} has a row whose main line opens its desk`)
  await inAct(() => { main!.click() })
  await flush(2); await advance(800, 50); await flush(2)
}

/** the floating neighbor cards on screen, LEFT first, with the agent each one
 *  points at — read from the DOM, never written down here */
function jumpCards(el: HTMLElement): { el: HTMLElement; id: string; side: string }[] {
  return [...el.querySelectorAll('.edge-jump')].map((e) => ({
    el: e as HTMLElement,
    // the card's own label, which is the agent it navigates to
    id: e.querySelector('.ej-name')?.textContent ?? '',
    side: (e.getAttribute('class') ?? '').includes('edge-jump l') ? 'l' : 'r',
  })).sort((a, b) => (a.side === 'l' ? -1 : 1) - (b.side === 'l' ? -1 : 1))
}

function uiTest(name: string, body: (t: TestContext) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    // ⚠ localStorage BEFORE forgetPins: `forgetPins` only drops the module
    // cache, so a pin leaked by an earlier file makes the agent pinnedFocus,
    // no desk opens, and it reads as "no menu" (desk-menu's finding).
    try { localStorage.removeItem('orgtree-pile-mine') } catch { /* private mode */ }
    forgetPins()
    setCrowdPilesOn(false)
    try { await body(t) } finally {
      forgetPins(); setCrowdPilesOn(false); realClock()
    }
  })
}

/**
 * THE FIXTURE THE WHOLE FILE RESTS ON: `boss` with three live reports. The
 * desk opened on the MIDDLE one has an off-screen neighbor on each side, which
 * is the only shape that draws two floating cards at once. `left` has no
 * reports and `right` has one, so the two agents' canonical menus DIFFER —
 * see the file header on why that matters.
 */
const fixture = () => [mkNode('boss', { children: [
  mkNode('left', { parent: 'boss' }),
  mkNode('mid', { parent: 'boss' }),
  mkNode('right', { parent: 'boss', children: [mkNode('grand', { parent: 'right' })] }),
] })]

// ---------------------------------------------------- §0 THE SHAPE IS REAL
uiTest('§0 the focused desk draws one floating card per off-screen neighbor',
  async (t) => {
    const c = await mountCanvas(t, fixture())
    await openDesk(c, 'mid')
    const cards = jumpCards(c.el)
    assert.equal(cards.length, 2,
      'a desk focused between two off-screen siblings draws BOTH floating '
      + `cards — otherwise every assertion below is vacuous. saw ${JSON.stringify(cards.map((x) => x.id))}`)
    assert.deepEqual(cards.map((x) => x.id), ['left', 'right'],
      'the left card names the sibling to its left and the right card the one '
      + 'to its right — each card carries its own agent')
  })

// ---------------------------------------- §1 EACH CARD OFFERS ITS OWN AGENT
uiTest('§1 each floating card opens the canonical menu for the agent it names',
  async (t) => {
    const c = await mountCanvas(t, fixture())
    await openDesk(c, 'mid')
    const tray = await openTray(c.el)
    const cards = jumpCards(c.el)
    assert.equal(cards.length, 2, 'two floating cards are on screen')

    // the reference menus, from the surface that already had the canonical
    // menu before this ticket existed
    const reference = new Map<string, string[]>()
    for (const id of ['left', 'right']) {
      const row = rowFor(c.el, id)
      assert.ok(row, `${id} has a row in the Agents List`)
      reference.set(id, await menuOf(row!, `${id} Agents List row`))
    }
    // ⚠ THE EQUALITY BELOW IS ONLY WORTH ANYTHING IF THE TWO REFERENCES DIFFER.
    // If both agents happened to offer the same list, a card bound to the
    // WRONG neighbor would compare equal and pass.
    const onlyRight = reference.get('right')!.filter((x) => !reference.get('left')!.includes(x))
    const onlyLeft = reference.get('left')!.filter((x) => !reference.get('right')!.includes(x))
    assert.ok(onlyRight.length > 0 && onlyLeft.length > 0,
      'the fixture makes the two neighbors\' canonical menus differ by '
      + 'STATE-DEPENDENT entries — the acceptance condition that says a card\'s '
      + 'conditional entries must match the canonical menu is only exercised by '
      + `a fixture where they do differ. right-only ${JSON.stringify(onlyRight)}, `
      + `left-only ${JSON.stringify(onlyLeft)}`)

    for (const card of cards) {
      const want = reference.get(card.id)
      assert.ok(want, `${card.id} is an agent this tree holds`)
      const have = await menuOf(card.el, `the ${card.side} floating card (${card.id})`)
      assert.deepEqual(have, want,
        `the floating card naming ${card.id} must offer THAT agent's canonical menu, `
        + 'not its neighbor\'s and not a surface-specific subset')
      // ⚠ THE WRONG-AGENT FAILURE, ASSERTED IN ITS OWN RIGHT rather than left
      // to the equality above. Two different things can go wrong on one card —
      // offering too little, and offering the NEIGHBOUR's list — and only this
      // line names the second. It is a real check because the two references
      // are asserted to differ, a few lines up.
      const other = reference.get(card.id === 'left' ? 'right' : 'left')!
      assert.notDeepEqual(have, other,
        `the ${card.side} card (${card.id}) must not offer its NEIGHBOUR's menu`)
    }
    assert.ok(!tray.contains(cards[0]!.el), 'the cards are not the Agents List rows')
  })

// -------------------------------- §2 THE PRIMARY CLICK STILL JUMPS (unchanged)
uiTest('§2 a plain click on a floating card still jumps, and raises no menu',
  async (t) => {
    const c = await mountCanvas(t, fixture())
    await openDesk(c, 'mid')
    const before = c.el.querySelector('.cc-head-left')?.getAttribute('data-copy-agent-name')
    assert.equal(before, 'mid', 'the focused desk is mid')
    const card = jumpCards(c.el).find((x) => x.id === 'left')
    assert.ok(card, 'the left floating card is on screen')
    await inAct(() => { card!.el.click() })
    await flush(2); await advance(800, 50); await flush(2)
    const after = c.el.querySelector('.cc-head-left')?.getAttribute('data-copy-agent-name')
    assert.equal(after, 'left', 'the floating card still jumps to the agent it names')
    assert.equal(menuEl(), null, 'and a primary click raises no menu')
  })

// ------------------------------------------------- §3 THE CONTROL, IN SOURCE
// The regression this file exists for is an OMISSION — a navigating card that
// draws no marker — and §1/§2 can only see the cards a fixture happens to
// render. This is the cheap structural half: the floating card is built in one
// place, and that place must reach for the marker. It is deliberately narrow
// (it names the file and the class rather than enumerating surfaces) because
// the mounted half above is what proves behaviour.
//
// ⚠ IT CHECKS TWO THINGS, BECAUSE THE FIX IS TWO THINGS AND THE FIRST ONE
// ALONE WAS MEASURED TO CHANGE NOTHING. The marker tells the menu code WHICH
// AGENT a press is about; it does not deliver the press anywhere. The entries
// are served by a `contextmenu` handler on an `ObjectMenuBoundary`, and the
// floating cards are siblings of the desk surface rather than descendants of
// it — the desk's own marked targets sit inside `movable-events`, which IS a
// boundary, and that is why marking them was enough there. Adding only
// `agentNavProps` to these cards left them exactly as inert as before: the
// probe read `{"prevented":false,"menu":false}` both before and after. So a
// future edit that keeps the marker and drops the wrapper is a real
// regression, and this is the cheap check that names it.
test('§3 the floating card is marked AND sits under a menu boundary', () => {
  const src = readFileSync(
    path.join(__SRC_DIR__, 'canvas', 'OrgCanvas.tsx'), 'utf8')
  const at = src.indexOf("className={'edge-jump '")
  assert.ok(at > 0, 'the floating card is still rendered in OrgCanvas.tsx')
  // the button's own props, from its opening tag to the first child
  const tag = src.slice(src.lastIndexOf('<button', at), at)
  assert.ok(tag.includes('agentNavProps('),
    'the floating card must be marked as a navigation target with the SHARED '
    + 'helper, so its menu is the canonical agent menu — the same one every '
    + 'other marked target reaches through agentnav.tsx')
  assert.ok(tag.includes(AGENT_NAV_ATTR) || tag.includes('agentNavProps('),
    'and the marker is the one the registry looks for')
  assert.ok(tag.includes('data-copy-agent-name'),
    'and it carries a copy object, like every other jump chip — otherwise the '
    + 'press takes the boundary\'s other arm and offers a different list')

  // the wrapper: the boundary must OPEN before the card's own <button> and
  // close after the map that renders it. Read as a slice of the source rather
  // than by counting tags, because the point is only that the one map of
  // cards is enclosed.
  const open = src.lastIndexOf('<ObjectMenuBoundary', at)
  assert.ok(open > 0 && open < src.lastIndexOf('<button', at),
    'the floating cards must be wrapped in an ObjectMenuBoundary — without it '
    + 'a marked card reaches no `contextmenu` handler at all and opens nothing')
  const close = src.indexOf('</ObjectMenuBoundary>', at)
  assert.ok(close > at,
    'and the boundary must CLOSE after the cards it encloses, not before them')
  assert.ok(src.slice(open, close).includes('edgeJumps.map('),
    'the boundary must enclose the cards themselves — the `edgeJumps.map` that '
    + 'renders them has to be inside it')
})
