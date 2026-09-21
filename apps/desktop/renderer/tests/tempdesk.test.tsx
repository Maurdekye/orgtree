// tempdesk.test.tsx — the glance that rearranges nothing.
//
// The feature is "read another agent's desk without changing the workspace",
// so most of what matters is what does NOT happen: no focus change, no pin, no
// window, no second composer, and everything back where it was on dismissal.
// Those are the assertions here.
//
// ⚠ THE CENTRAL ONE IS §2. The modal BORROWS the canonical desk rather than
// drawing a copy, and the witness for that is the canvas slot showing the
// registry's own "open elsewhere" placeholder while the modal holds it — then
// having the real desk back afterwards. A test that only checked the modal
// contains a desk would pass just as happily against a second, divergent,
// read-only imitation, which is the thing the ticket forbids.
import './harness'
import { FakeServer, advance, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { resetConvos } from '../src/convo'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import { TempDeskModal } from '../src/canvas/tempdesk'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { openSurfaces } from '../src/windowlife'
import type { CanvasNode, TreePayload } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const W = window as unknown as Window & typeof globalThis
const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

const agent = (id: string): CanvasNode => ({
  id, tier: 'opus', state: 'live', generation: 0, parent: null, children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: { mcp: [] }, add_dirs: [] },
} as unknown as CanvasNode)

const deskProps = (map: Map<string, CanvasNode>) => ({
  map, op, slug: 'org', toast: noop, pub: false,
})

/** the canvas slot for an agent, plus the modal when `open` — the real shape:
 *  one ordinary destination, and a borrowing one that comes and goes */
function scene(node: CanvasNode, open: boolean, close = noop,
  canvasProps: Record<string, unknown> = {}) {
  const map = new Map([[node.id, node]])
  // ⚠ THE MODAL IS FIRST IN TREE ORDER HERE, DELIBERATELY, AND THAT IS NOT HOW
  // OrgCanvas RENDERS IT. Registration re-runs for every slot on any parent
  // re-render, in tree order, so a slot placed LAST wins under plain
  // last-writer-wins whatever the borrow does. In the real host the modal does
  // come last, which means a docked desk would mostly stay in it by accident of
  // ordering — so a fixture that copies that ordering cannot tell the borrow
  // from the accident, and my first version of §2b could not. Putting the modal
  // FIRST makes the canvas the last writer, which is what the borrow actually
  // has to survive. (Where the borrow is load-bearing regardless of ordering is
  // the restore target — deskowner §7b/§7e — and the detached case, which no
  // ordinary slot can take at all.)
  return (
    <DeskHosts map={map} slug="org">
      {open && <TempDeskModal node={node} close={close} desk={deskProps(map)} />}
      <div data-which="canvas">
        <DeskSlot node={node} map={map} op={op} slug="org" toast={noop} pub={false}
          bare {...canvasProps} />
      </div>
    </DeskHosts>
  )
}

const canvasBox = (el: HTMLElement) =>
  el.querySelector('[data-which="canvas"]') as HTMLElement
const modal = () => document.querySelector('.tempdesk-panel') as HTMLElement | null
const backdrop = () => document.querySelector('.tempdesk-over') as HTMLElement | null
const borrowed = (el: HTMLElement) =>
  /desk is open elsewhere/.test(canvasBox(el).textContent ?? '')

const setup = () => { resetConvos(); installFetch(new FakeServer()) }

test('§1 it is a real modal dialog, named for the agent it is showing',
  async (t: TestContext) => {
    setup()
    const n = agent('alpha')
    const view = await mountView(scene(n, true), (el) => el)
    t.after(() => view.unmount())
    await flush()
    const m = modal()
    assert.ok(m, 'the modal did not render')
    assert.equal(m!.getAttribute('role'), 'dialog')
    assert.equal(m!.getAttribute('aria-modal'), 'true')
    assert.match(m!.getAttribute('aria-label') ?? '', /alpha/,
      'a screen reader is not told whose desk this is')
  })

test('§2 IT BORROWS THE CANONICAL DESK — it does not draw a second one',
  async (t: TestContext) => {
    // ⚠ THE TEST THAT DISTINGUISHES A BORROW FROM A COPY. While the modal is
    // open the canvas slot must show the registry's own placeholder, because
    // there is exactly ONE desk and the modal has it. Afterwards the canvas
    // has it back. A read-only imitation would leave the canvas desk untouched
    // and pass any weaker assertion.
    setup()
    const n = agent('beta')
    const view = await mountView(scene(n, false), (el) => el)
    t.after(() => view.unmount())
    await flush()
    assert.equal(borrowed(view.el), false,
      'the canvas slot already showed a placeholder before the modal opened')
    await view.render(scene(n, true))
    await flush()
    assert.ok(modal(), 'the modal did not open')
    assert.equal(borrowed(view.el), true,
      'the canvas slot kept the desk while the modal was open — so the modal '
      + 'is showing a SECOND desk, which is the divergent copy the ticket forbids')
    // and exactly one composer exists across both surfaces
    assert.equal(document.querySelectorAll('.cc-head-meta').length <= 1, true,
      'more than one desk header is mounted for one agent')
    await view.render(scene(n, false))
    await flush()
    assert.equal(modal(), null, 'the modal did not close')
    assert.equal(borrowed(view.el), false,
      'the desk did not come back to the canvas after the modal closed')
  })

test('§2b IT KEEPS THE DESK WHILE THE CANVAS RE-RENDERS UNDER IT',
  async (t: TestContext) => {
    // ⚠ THIS IS THE TEST THAT NEEDS `borrow`, AND §2 IS NOT. I checked: §2
    // passes with `borrow` removed, because an ordinary slot mounted last takes
    // the desk under plain last-writer-wins and the fallback hands it back on
    // close. What an ordinary slot CANNOT survive is the canvas re-registering
    // — and the canvas re-renders on every poll, so without the borrow this
    // modal would lose the desk within a second of opening and show the
    // "open elsewhere" placeholder at the user instead of a desk.
    setup()
    const n = agent('eta')
    const view = await mountView(scene(n, false), (el) => el)
    t.after(() => view.unmount())
    await flush()
    await view.render(scene(n, true))
    await flush()
    assert.equal(borrowed(view.el), true, 'the modal did not take the desk')
    // the canvas re-renders beneath it, repeatedly, exactly as polling does
    for (const compactAt of [0.4, 0.5, 0.6]) {
      await view.render(scene(n, true, noop, { compactAt }))
      await flush()
      assert.equal(borrowed(view.el), true,
        `the canvas took the desk back on a re-render (compactAt ${compactAt}) `
        + '— the modal is now showing a placeholder instead of a desk')
      assert.ok(modal(), 'the modal vanished')
    }
    // and it still goes home afterwards
    await view.render(scene(n, false, noop, { compactAt: 0.6 }))
    await flush()
    assert.equal(borrowed(view.el), false, 'the desk did not come back')
  })

test('§2c THE DESK IS MOVED, NOT REMOUNTED — so a half-typed draft survives',
  async (t: TestContext) => {
    // ⚠ THE PROPERTY EVERYTHING ELSE RESTS ON, and the one I promised to prove
    // rather than assert in a comment. `DeskHost` renders exactly one
    // `OwnedDeskChat` per agent and a borrow changes only which anchor it is
    // placed into, so the React element is never unmounted and its DOM node is
    // MOVED (appendChild relocates a node, it does not clone it). If that ever
    // became a remount, the user's unsent message would vanish when they
    // glanced at the desk — silently, and only for people mid-sentence.
    setup()
    const n = agent('theta')
    const view = await mountView(scene(n, false), (el) => el)
    t.after(() => view.unmount())
    await flush()
    const box = document.querySelector('textarea') as HTMLTextAreaElement | null
    assert.ok(box, 'the desk rendered no composer to type into')
    // identity of a live node inside the desk, captured before the borrow
    const before = box!
    // the composer is CONTROLLED, so the value has to go in through the native
    // setter or React's own state never hears about it and re-renders the box
    // back to empty — which is what my first version of this test measured
    // (deskhistory.test.tsx uses the same idiom for the same reason)
    await inAct(() => {
      Object.getOwnPropertyDescriptor(W.HTMLTextAreaElement.prototype, 'value')!
        .set!.call(before, 'half a sentence')
      before.dispatchEvent(new W.Event('input', { bubbles: true }))
    })
    await flush()
    await view.render(scene(n, true))
    await flush()
    const during = document.querySelector('textarea') as HTMLTextAreaElement | null
    assert.ok(during, 'the borrowed desk has no composer')
    assert.equal(during, before,
      'the composer is a DIFFERENT element inside the modal — the desk was '
      + 'remounted rather than moved, so anything unsent is gone')
    assert.equal(during!.value, 'half a sentence', 'the draft did not survive the borrow')
    await view.render(scene(n, false))
    await flush()
    const after = document.querySelector('textarea') as HTMLTextAreaElement | null
    assert.equal(after, before, 'the desk was remounted on the way back')
    assert.equal(after!.value, 'half a sentence',
      'the draft did not survive the return')
  })

test('§3 Escape dismisses it, through the shared escape stack',
  async (t: TestContext) => {
    setup()
    const n = agent('gamma')
    let closed = 0
    const view = await mountView(scene(n, true, () => { closed++ }), (el) => el)
    t.after(() => view.unmount())
    await flush()
    await inAct(() => {
      W.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()
    assert.equal(closed, 1, 'Escape did not dismiss the temporary desk')
  })

test('§4 the BACKDROP dismisses it and the panel does not', async (t: TestContext) => {
    setup()
    const n = agent('delta')
    let closed = 0
    const view = await mountView(scene(n, true, () => { closed++ }), (el) => el)
    t.after(() => view.unmount())
    await flush()
    const press = (el: Element) => inAct(() => {
      el.dispatchEvent(new W.MouseEvent('pointerdown',
        { bubbles: true, cancelable: true, button: 0 }))
    })
    await press(modal()!)
    await flush()
    assert.equal(closed, 0, 'a press INSIDE the panel dismissed it')
    await press(backdrop()!)
    await flush()
    assert.equal(closed, 1, 'a press on the backdrop did not dismiss it')
  })

test('§5 the close button dismisses it', async (t: TestContext) => {
    setup()
    const n = agent('epsilon')
    let closed = 0
    const view = await mountView(scene(n, true, () => { closed++ }), (el) => el)
    t.after(() => view.unmount())
    await flush()
    const btn = document.querySelector('.tempdesk-close') as HTMLElement
    assert.ok(btn, 'there is no close control')
    await inAct(() => { btn.click() })
    assert.equal(closed, 1)
  })

test('§6 focus goes into the panel, and comes back to the opener',
  async (t: TestContext) => {
    // "closing puts everything back" includes the keyboard: leaving the user on
    // document.body sends their next keystroke nowhere.
    setup()
    const n = agent('zeta')
    const opener = document.createElement('button')
    opener.id = 'opener'
    document.body.appendChild(opener)
    t.after(() => opener.remove())
    const view = await mountView(scene(n, false), (el) => el)
    t.after(() => view.unmount())
    await flush()
    await inAct(() => { opener.focus() })
    assert.equal(document.activeElement, opener)
    await view.render(scene(n, true))
    await flush()
    assert.ok(modal()!.contains(document.activeElement),
      'focus stayed outside the modal — a keyboard user is not in it')
    await view.render(scene(n, false))
    await flush()
    assert.equal(document.activeElement, opener,
      'focus did not return to the control that opened the modal')
  })

/* ─── and what it must NOT do, through the real canvas ────────────────────── */

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

test('§7 picking the entry changes no focus, pins nothing and opens no window',
  async (t: TestContext) => {
    // ⚠ THE THREE THINGS THE FEATURE EXISTS TO AVOID, checked through the real
    // canvas rather than through my handler in isolation: the camera must not
    // move, no pinned window may appear, and no native surface may be opened.
    t.after(stubPointerCapture())
    useFakeClock()
    t.after(realClock)
    setup()
    const v = await mountView(
      <OrgCanvas tree={tree([mkNode('worker')])} slug="mine"
        op={() => Promise.resolve({})} toast={noop} mailEvt={null}
        onOpenAgentGallery={noop} />, (h) => h)
    t.after(() => v.unmount())
    await flush(); await advance(400, 50); await flush()
    const space = () => (v.el.querySelector('.space') as HTMLElement).style.transform
    const cameraBefore = space()
    const surfacesBefore = openSurfaces().length
    const card = v.el.querySelector('[data-copy-agent-name="worker"]')
      ?? v.el.querySelector('.sq')
    assert.ok(card, 'no agent card to open the menu on')
    await inAct(() => {
      card!.dispatchEvent(new W.MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 }))
    })
    await flush(2)
    const entry = [...document.querySelectorAll('button, [role="menuitem"]')]
      .find((b) => /Open desk temporarily/.test(b.textContent ?? ''))
    assert.ok(entry, 'the agent menu does not offer "Open desk temporarily"')
    await inAct(() => { (entry as HTMLElement).click() })
    await flush(2)
    assert.ok(modal(), 'picking the entry did not open the temporary desk')
    // …and none of the three things happened
    assert.equal(space(), cameraBefore,
      'the camera moved — a glance is not supposed to walk the tree')
    assert.equal(openSurfaces().length, surfacesBefore,
      'a native window was opened')
    assert.equal(v.el.querySelector('.pinwin'), null,
      'a pinned desk window appeared')
  })
