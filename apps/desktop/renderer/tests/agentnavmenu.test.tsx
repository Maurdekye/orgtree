// agentnavmenu.test.tsx — THE CANONICAL AGENT MENU AT EVERY NAVIGATION TARGET
// (user scope expansion 2026-09-19: "expose the same canonical full agent
// context menu at every renderer location where the primary click would
// navigate or jump to that agent", with "all of these surfaces must use the
// same underlying implementation").
//
// ⚠ THE CENTRAL TEST IS AN ENUMERATION, NOT A LIST OF SURFACES. §3 walks every
// `[data-agent-nav]` element the mounted canvas actually renders and holds each
// one to the SAME menu the Agents List row offers for that agent. A test that
// named the surfaces it knew about would pass forever while a fifteenth surface
// went uncovered — which is the exact failure the expansion was filed about,
// one level up. §4 closes the other half: a navigating agent name that FORGOT
// the marker fails here rather than shipping with a copy-only menu.
//
// §1 is the control, and it is the reported bug written down: with no registry
// above it, a navigation target offers `Copy agent name` and nothing else. A
// suite where every case passes because the menu is always full would prove
// nothing, so the negative is pinned first and the positives are measured
// against it.
//
// The menu MECHANISM (opening, dismissal, keyboard, clamping) is
// contextmenu.test.tsx §A; the ENTRY LIST and its gating are
// agentrowmenu.test.tsx. This file is only about reach: that the same menu is
// available from the places a click would take you to the agent, and from
// nowhere new.
//
// Under jsdom every box is 0×0 (contextmenu.test.tsx's note) — nothing here
// reads a size.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs agentnavmenu

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock,
  useFakeClock,
} from './harness'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import {
  AGENT_NAV_ATTR, AgentNavProvider, agentNavProps, useAgentNavRegistry, useProvideAgentNav,
} from '../src/canvas/agentnav'
import type { AgentNavMenu } from '../src/canvas/agentnav'
import { AgentName } from '../src/canvas/identity'
import { SenderChip } from '../src/App'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { resetConvos } from '../src/convo'
import { forgetPins } from '../src/canvas/pins'
import { setCrowdPilesOn } from '../src/canvas/shared'
import type { OpRequest } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

declare const __SRC_DIR__: string
const W = window as unknown as Window & typeof globalThis

// ------------------------------------------------------------------ fixture
// (agentrowmenu.test.tsx's, verbatim — one fixture idiom for the canvas)
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

interface Canvas { el: HTMLElement; ops: OpRequest[] }
async function mountCanvas(t: TestContext, roots: unknown[]): Promise<Canvas> {
  t.after(stubPointerCapture())
  resetConvos()
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  const ops: OpRequest[] = []
  const v = await mountView(
    <OrgCanvas tree={tree(roots)} slug="mine"
      op={(b) => { ops.push(b); return Promise.resolve({}) }}
      toast={() => {}} mailEvt={null} onOpenAgentGallery={() => {}} />,
    (h) => h)
  t.after(() => v.unmount())
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

/** every marked navigation target currently on screen, with the agent each
 *  one points at. The list is READ FROM THE DOM, never written down here. */
function navTargets(el: HTMLElement): { el: Element; id: string; where: string }[] {
  return [...el.querySelectorAll('[' + AGENT_NAV_ATTR + ']')].map((e) => ({
    el: e,
    id: e.getAttribute(AGENT_NAV_ATTR)!,
    // a readable name for the failure message: the element's own first class
    // is what a reader needs in order to find the surface again
    where: (e.getAttribute('class') || e.tagName.toLowerCase()).split(' ')[0]!,
  }))
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

// ---------------------------------------------------------- §1 THE CONTROL
// The bug as reported, and the negative this whole file is measured against.

uiTest('§1 CONTROL: with no registry above it, a navigating name offers ONLY Copy agent name',
  async (t) => {
    const jumped: string[] = []
    const v = await mountView(
      <ObjectMenuBoundary className="app">
        <AgentName id="worker" tier="haiku" onFocus={(id) => { jumped.push(id) }} />
      </ObjectMenuBoundary>, (h) => h)
    t.after(() => v.unmount())
    await flush(2)
    const name = v.el.querySelector('.cc-name-jump') as HTMLElement
    assert.ok(name, 'the name rendered as a navigating button')
    assert.equal(name.getAttribute(AGENT_NAV_ATTR), 'worker',
      'it is marked as a navigation target even where nothing can serve it')
    const have = await menuOf(name, 'an unserved target')
    assert.deepEqual(have, ['Copy agent name'],
      'no registry = no entries invented; the target keeps the menu it had')
    // and it still navigates: an absent menu never costs the primary click
    await inAct(() => { name.click() })
    await flush(2)
    assert.deepEqual(jumped, ['worker'], 'the primary click still navigates')
  })

// ------------------------------------------- §2 THE FIX, ON THE FILED BUG
uiTest('§2 the desk header name offers the agent whole menu, not just Copy agent name',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('boss', { children: [mkNode('worker', { parent: 'boss' })] })])
    await openDesk(c, 'worker')
    const head = c.el.querySelector('.cc-head-left') as HTMLElement | null
    assert.ok(head, 'a desk opened and drew its header name')
    const have = await menuOf(head!, 'the desk header name')
    assert.equal(have[0], 'Copy agent name',
      `the copy entry is still first — have ${JSON.stringify(have)}`)
    assert.ok(have.length > 1,
      `and it is no longer the only one — have ${JSON.stringify(have)}`)
    for (const entry of ['Open desk', 'Open inbox', 'Open docket', 'Settings']) {
      assert.ok(have.includes(entry),
        `the desk name offers "${entry}" — have ${JSON.stringify(have)}`)
    }
  })

// --------------------------------------- §3 EVERY MARKED TARGET, ENUMERATED
uiTest('§3 every navigation target on screen offers the SAME menu as that agent Agents List row',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('boss', { children: [mkNode('worker', { parent: 'boss' })] })])
    // a desk has to be OPEN: at org zoom the canvas renders no navigation
    // target at all, which would make this enumeration pass by finding
    // nothing — the vacuous green this file exists to refuse
    await openDesk(c, 'worker')
    const tray = await openTray(c.el)
    // the reference menus, one per agent, read from the surface that already
    // had the canonical menu before this ticket existed
    const reference = new Map<string, string[]>()
    for (const id of ['boss', 'worker']) {
      const row = rowFor(c.el, id)
      assert.ok(row, `${id} has a row in the Agents List`)
      reference.set(id, await menuOf(row!, `${id} Agents List row`))
    }
    // …and now every marked target, whatever it happens to be. The tray's own
    // rows are excluded: they ARE the reference, and they carry their menu
    // themselves rather than through the registry.
    const targets = navTargets(c.el).filter((x) => !tray.contains(x.el))
    assert.ok(targets.length > 0,
      'the mounted canvas renders at least one marked navigation target')
    const seen: string[] = []
    for (const target of targets) {
      const want = reference.get(target.id)
      if (!want) continue            // a target for an agent with no row here
      const have = await menuOf(target.el, `${target.where} -> ${target.id}`)
      assert.deepEqual(have, want,
        `${target.where} -> ${target.id} must offer the agent canonical menu, `
        + 'not a surface-specific subset')
      seen.push(target.where)
    }
    // ⚠ NOT `> 0`. This fixture renders two KINDS of target — the desk header
    // name and an edge jump chip — and an enumeration that silently narrowed
    // to one of them would still be green while half the feature rotted. If a
    // layout change legitimately removes one, this line is where you find out.
    assert.ok(new Set(seen).size >= 2,
      `at least two kinds of navigation target were checked — saw ${JSON.stringify(seen)}`)
  })

// ------------------------------------------------ §4 THE OMISSION DETECTOR
// §3 can only check surfaces a fixture happens to render. This checks the one
// failure that has ALREADY happened once in this codebase: App.tsx's
// `SenderChip` is a hand-rolled copy of `AgentName`'s navigating button, and
// its own comment says the two must not drift. A future third copy would be
// invisible to any mounted test that does not render it, so it is caught in
// the source instead.
//
// ⚠ FILE-LEVEL, and that is a stated limit rather than an oversight: this
// proves a file that draws a navigating agent name also reaches for the
// marker, not that every element in it does. A second unmarked button added
// to a file that already has a marked one would pass here — §3 is what covers
// the surfaces a fixture reaches, and the two together are the net.

test('§4 every file that draws a navigating agent name also marks it', () => {
  const NAV_CLASS = 'cc-name-jump'
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name))
        : /[.]tsx?$/.test(e.name) ? [path.join(dir, e.name)] : [])
  const offenders = walk(__SRC_DIR__).filter((f) => {
    const text = readFileSync(f, 'utf8')
    return text.includes(NAV_CLASS) && !text.includes('agentNavProps')
      && !text.includes('AGENT_NAV_ATTR')
  }).map((f) => path.relative(__SRC_DIR__, f))
  assert.deepEqual(offenders, [],
    'these files draw a `' + NAV_CLASS + '` agent name — a name the app itself '
    + 'says navigates — without marking it as a navigation target, so it '
    + 'offers a copy-only menu')
})

// ------------------------------------------- §6 THE REGISTRY IS READ LATE
// WHY THIS SECTION EXISTS, stated plainly: a deliberate mutation that reads
// the registry at RENDER time instead of at menu-open time SURVIVED §1-§5. In
// the canvas fixture everything re-renders after OrgCanvas registers, so the
// two reads agree and no mounted test can tell them apart. The property still
// matters — a `memo`'d row that renders before registration and never
// re-renders would hold `null` forever and silently offer a copy-only menu —
// so it is pinned here, at the registry's own contract, instead of at the menu.
//
// ⚠ WHAT THIS DOES AND DOES NOT PROVE. It proves the hook hands back a LIVE
// registry rather than a value captured when the consumer subscribed, which is
// the one edit that would reintroduce the bug. It does NOT prove the whole
// open-menu path dereferences late; no mounted fixture reaches that, and
// saying so here is cheaper than a test that looks like it does.

test('§6 a consumer that subscribed BEFORE registration still reaches the builder', async () => {
  let captured: { readonly current: AgentNavMenu | null } | null | undefined
  function Consumer() {
    const reg = useAgentNavRegistry()
    if (captured === undefined) captured = reg     // ONCE, like a memo'd row
    return null
  }
  const v = await mountView(
    <AgentNavProvider><Consumer /></AgentNavProvider>, (h) => h)
  await flush(2)
  assert.ok(captured, 'the consumer found a registry')
  assert.equal(captured!.current, null,
    'nothing was registered at the moment it subscribed')
  // now somebody registers, exactly as OrgCanvas does, and the consumer is
  // never re-rendered
  const asked: string[] = []
  ;(captured as { current: AgentNavMenu | null }).current = (id) => {
    asked.push(id)
    return [{ label: 'Open desk', onSelect: () => {} }]
  }
  const late = captured!.current
  assert.ok(late, 'the early subscriber reaches the late registration')
  assert.deepEqual(late!('worker').map((e) => (e === 'sep' ? 'sep' : e.label)),
    ['Open desk'], 'and it is the registered builder that answers')
  assert.deepEqual(asked, ['worker'], 'called with the agent the target names')
  v.unmount()
})

// ----------------------------------- §5 THE PRIMARY CLICK IS UNTOUCHED
uiTest('§5 marking a target changes its menu and nothing else — the click still navigates',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('boss', { children: [mkNode('worker', { parent: 'boss' })] })])
    await openDesk(c, 'worker')
    const chip = c.el.querySelector('.desk-nav-chip[' + AGENT_NAV_ATTR + ']') as HTMLElement | null
    if (!chip) return          // no off-screen sibling in this layout; §3 covers the rest
    const before = c.el.querySelector('.cc-head-left')?.getAttribute('data-copy-agent-name')
    await inAct(() => { chip.click() })
    await flush(2); await advance(800, 50); await flush(2)
    const after = c.el.querySelector('.cc-head-left')?.getAttribute('data-copy-agent-name')
    assert.notEqual(after, before, 'the jump chip still jumps on a plain click')
  })

// ================================================================ §7 and §8
// TWO SHAPES THE MARKER COULD NOT SERVE, both found by textmenu in independent
// review of f0d33d9 (2026-09-19) by measurement, and neither visible to §3 or
// §4. They are regression cases for ONE root cause with two faces.
//
// THE ROOT CAUSE, since it is not obvious from either symptom:
// `ObjectMenuBoundary` used to pass the COPY OBJECT to `open` as the anchor,
// and `open` bounds BOTH of its lookups — the copy object AND the navigation
// marker — by that anchor. So the marker was only ever reachable when the copy
// object CONTAINED it. Four shapes exist among the marked targets:
//
//   marker and copy object ON THE SAME ELEMENT  — contains(itself), worked
//   copy object is an ANCESTOR of the marker    — worked (.eye-tab-jump)
//   marker is an ANCESTOR of the copy object    — BROKE  (§7, SenderChip)
//   no copy object above the marker AT ALL      — BROKE  (§8, docket head)
//
// The fix anchors on whichever of the two is OUTER, and stops `open`
// discarding the nav entries when there is no copy object at all.
//
// ⚠ §7 MOUNTS THE REAL COMPONENT, not a replica of its markup. A replica would
// have re-encoded my own reading of the nesting, and the nesting IS the bug.

/** publishes a builder into the registry exactly as OrgCanvas does */
function Registrar({ entries }: { entries: string[] }) {
  useProvideAgentNav((id) => entries.map((label) => ({ label, onSelect: () => { void id } })))
  return null
}

uiTest('§7 a marker ABOVE its copy object still offers the whole menu (App.tsx SenderChip)',
  async (t) => {
    const nodes = new Map<string, unknown>([['worker', mkNode('worker')]])
    const jumped: string[] = []
    const v = await mountView(
      <AgentNavProvider>
        <ObjectMenuBoundary className="app">
          <Registrar entries={['Open desk', 'Open inbox']} />
          <SenderChip id="worker" nodes={nodes as never}
            onFocusAgent={(id: string) => { jumped.push(id) }} />
        </ObjectMenuBoundary>
      </AgentNavProvider>, (h) => h)
    t.after(() => v.unmount())
    await flush(2)

    const button = v.el.querySelector('button.cc-name-jump') as HTMLElement | null
    assert.ok(button, 'the real SenderChip rendered its navigating button')
    // PIN THE INVERTED NESTING ITSELF. If SenderChip is ever rewritten to put
    // both attributes on one element, this case would keep passing for the
    // wrong reason — so assert the shape it is defending against.
    assert.equal(button!.getAttribute(AGENT_NAV_ATTR), 'worker',
      'the outer button carries the marker')
    assert.equal(button!.getAttribute('data-copy-agent-name'), null,
      'and NOT the copy attribute — that is on an inner element')
    const inner = button!.querySelector('[data-copy-agent-name]')
    assert.ok(inner, 'the copy object is INSIDE the marked button — the inverted shape')

    // right-click the inner span, which is what a real pointer lands on
    const have = await menuOf(inner!, 'the sender chip')
    assert.equal(have[0], 'Copy agent name',
      `the copy entry is still first — have ${JSON.stringify(have)}`)
    assert.ok(have.includes('Open desk') && have.includes('Open inbox'),
      `and the agent menu is reachable, not copy-only — have ${JSON.stringify(have)}`)
    // the filed symptom, written down so a regression reads unmistakably
    assert.notDeepEqual(have, ['Copy agent name'],
      'THE REPORTED BUG: an inbox sender chip offering copy-only')

    await inAct(() => { button!.click() })
    await flush(2)
    assert.deepEqual(jumped, ['worker'], 'and the primary click still navigates')
  })

uiTest('§8 a marker with NO copy object above it offers the whole menu (docket question head)',
  async (t) => {
    // The docket question head's button carries the marker, and the nearest
    // `data-copy-ticket-title` is a SIBLING of the question box rather than an
    // ancestor of the button — so there is no copy object above it at all.
    // Before the fix this opened NOTHING: not even "Copy agent name".
    const v = await mountView(
      <AgentNavProvider>
        <ObjectMenuBoundary className="app">
          <Registrar entries={['Open desk', 'Open inbox']} />
          <div className="mailer-head docket-pane-head" data-copy-ticket-title="a ticket" />
          <div className="docket-question-box">
            <div className="docket-question-head">
              <button className="cc-name cc-name-jump" {...agentNavProps('worker')}>worker</button>
            </div>
          </div>
        </ObjectMenuBoundary>
      </AgentNavProvider>, (h) => h)
    t.after(() => v.unmount())
    await flush(2)

    const button = v.el.querySelector('button.cc-name-jump') as HTMLElement | null
    assert.ok(button, 'the question head button rendered')
    // PROVE THE PRECONDITION rather than assuming it: this case is only
    // meaningful while there is genuinely no copy object above the marker.
    assert.equal(button!.closest('[data-copy-agent-name], [data-copy-ticket-title]'), null,
      'precondition: there is genuinely NO copy object above this marker')

    const have = await menuOf(button!, 'the docket question head')
    assert.ok(have.includes('Open desk') && have.includes('Open inbox'),
      `the agent menu is offered — have ${JSON.stringify(have)}`)
    assert.equal(have[0], 'Copy agent name',
      'and it is the CANONICAL menu, copy entry included — a target without a '
      + 'copy object must not receive the menu minus its first entry. '
      + `have ${JSON.stringify(have)}`)
  })

// ------------------------------- §9 EVERY MARKED TARGET ANSWERS AT ALL
// textmenu's suggestion, and the assertion that would have caught BOTH of the
// findings above in one line. §3 compares ENTRIES, but `continue`s past any
// target whose agent has no reference row — so a target that opened NOTHING
// could slip past it. This asks the weaker question of EVERY marked target
// without exception: is the right-click taken, and does a menu appear.
uiTest('§9 every marked target on screen opens a menu AT ALL, entries aside',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('boss', { children: [mkNode('worker', { parent: 'boss' })] })])
    await openDesk(c, 'worker')
    await openTray(c.el)
    const targets = [...c.el.querySelectorAll('[' + AGENT_NAV_ATTR + ']')] as HTMLElement[]
    assert.ok(targets.length > 0, 'the canvas renders marked targets to check')
    for (const el of targets) {
      const what = `${el.className || el.tagName} -> ${el.getAttribute(AGENT_NAV_ATTR)}`
      assert.equal(await rightClick(el), true,
        `a marked target (${what}) must TAKE the right-click`)
      assert.ok(menuEl(), `a marked target (${what}) must OPEN a menu`)
      assert.ok(labels().length > 0, `a marked target (${what}) must offer entries`)
      await esc()
    }
  })

// --------------------- §10 THE THIRD SHAPE, PINNED RATHER THAN ASSUMED
// Copy object is an ANCESTOR of the marker — `.eye-tab-jump`, which sits
// inside a `<span data-copy-agent-name>` (cards.tsx). This shape ALWAYS
// worked, and it is here precisely because it is the one a careless fix
// breaks: textmenu's first reading of the review had it down as broken and
// its own probe refuted that, so it is now pinned rather than left to a
// future reader's judgement.
//
// ⚠ HONEST LIMIT, stated because a reader will otherwise assume more. The
// mutation `anchor = nav ?? object` — dropping the outer-of-the-two rule and
// always preferring the marker — SURVIVES this case, and I could not find a
// real DOM shape in this codebase where it changes any label. It survives
// because `open` now synthesizes the copy entry from the marker when no copy
// object is in scope, and the marker and the enclosing copy object carry the
// SAME agent id at every site that has both. The two would diverge only where
// a `data-copy-ticket-title` element is a strict ANCESTOR of an agent marker,
// and no such shape exists today (reflinks.tsx puts both attributes on one
// element). So this asserts the behaviour that is observable, and does not
// pretend to pin an anchor choice nothing can currently detect.
uiTest('§10 a copy object ABOVE the marker keeps the whole menu, copy entry first',
  async (t) => {
    const v = await mountView(
      <AgentNavProvider>
        <ObjectMenuBoundary className="app">
          <Registrar entries={['Open desk', 'Open inbox']} />
          {/* the .eye-tab-jump shape: copy object wrapping the marked button */}
          <span data-copy-agent-name="worker" className="eye-tab">
            <button className="eye-tab-jump" type="button" {...agentNavProps('worker')}>go</button>
          </span>
        </ObjectMenuBoundary>
      </AgentNavProvider>, (h) => h)
    t.after(() => v.unmount())
    await flush(2)

    const button = v.el.querySelector('button.eye-tab-jump') as HTMLElement | null
    assert.ok(button, 'the jump button rendered')
    // prove the shape, so this cannot pass for the wrong reason later
    assert.equal(button!.getAttribute('data-copy-agent-name'), null,
      'the marked button does NOT carry the copy attribute')
    assert.ok(button!.closest('[data-copy-agent-name]'),
      'and the copy object is an ANCESTOR of it — the third shape')

    const have = await menuOf(button!, 'the eye-tab jump')
    assert.equal(have[0], 'Copy agent name',
      `the copy entry is first — have ${JSON.stringify(have)}`)
    assert.ok(have.includes('Open desk') && have.includes('Open inbox'),
      `and the agent menu came with it — have ${JSON.stringify(have)}`)
  })
