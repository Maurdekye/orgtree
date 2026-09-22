// orgslot.test.tsx — the org host's render slot, and putting the canvas away.
//
// The Attention view needs to draw beside the canvas while sharing the canvas's
// desk registry, map and routes. Hoisting those into App was rejected: the
// registry must stay single or two live composers become possible. So the host
// exposes a slot, and the shell says which of the two is presented.
//
// ⚠ THE TWO PLACEMENT FACTS THIS FILE EXISTS TO PIN, both of which are easy to
// break later and neither of which is visible from reading the JSX:
//
//   1. THE SLOT IS A SIBLING OF `.viewport`, NOT A CHILD. Inside it, the slot
//      would inherit the pan/zoom transform. It is still inside `DeskHosts`, so
//      a desk it mounts registers in the ONE registry.
//   2. THE WORLD WRAPPER IS NOT `.viewport`. `adoptPinLayer` appends the pin
//      layer as a real DOM child of the viewport, so hiding the viewport takes
//      every pinned window with it — which is exactly what the ruling forbids.
//      The world children are wrapped; the pin layer is their sibling.
//
// The browser-only half of the hiding rule — that inherited `visibility` really
// stops painting, that a portaled pin stays visible and focusable, that the
// geometry survives, and that `.mailbtn.has` would otherwise leak — is measured
// in canvashide-probe.tsx, because jsdom implements neither `inert` nor
// `display: contents` nor hit testing. What is asserted HERE is the structure
// that probe is measuring: the class, the attribute, and what is inside what.
import './harness'
import {
  FakeServer, advance, flush, inAct, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import { resetConvos } from '../src/convo'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import type { OrgSlotContext } from '../src/canvas/OrgCanvas'
import type { TreePayload } from '../src/canvas/shared'

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

interface Mounted {
  el: HTMLElement
  ctx: () => OrgSlotContext | null
  render: (next: { hidden?: boolean; slot?: boolean }) => Promise<void>
}

async function mountCanvas(t: TestContext,
  opts: { hidden?: boolean; slot?: boolean } = {}): Promise<Mounted> {
  t.after(stubPointerCapture())
  // the canvas settles its springs on timers, so `advance` needs the mocked
  // clock; restored per test so a failure here cannot poison the next file
  useFakeClock()
  t.after(realClock)
  resetConvos()
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  let seen: OrgSlotContext | null = null
  const roots = [mkNode('alpha', { children: [mkNode('beta')] })]
  const node = (o: { hidden?: boolean; slot?: boolean }) => (
    <OrgCanvas tree={tree(roots)} slug="mine"
      op={() => Promise.resolve({})}
      toast={() => {}} mailEvt={null} onOpenAgentGallery={() => {}}
      canvasContent={o.hidden ? 'hidden' : 'shown'}
      renderOrgSlot={o.slot === false ? undefined : (ctx) => {
        seen = ctx
        return <div data-testid="slot-body">attention stage</div>
      }} />
  )
  const v = await mountView(node(opts), (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(400, 50); await flush()
  return {
    el: v.el,
    ctx: () => seen,
    render: async (next) => { await v.render(node(next)); await flush() },
  }
}

const world = (el: HTMLElement) => el.querySelector('.canvas-world') as HTMLElement | null
const viewport = (el: HTMLElement) => el.querySelector('.viewport') as HTMLElement | null
const slot = (el: HTMLElement) => el.querySelector('.org-slot') as HTMLElement | null

test('§1 the slot is a SIBLING of the viewport, not a child of it',
  async (t: TestContext) => {
    const m = await mountCanvas(t)
    const s = slot(m.el), vp = viewport(m.el)
    assert.ok(s, 'the slot did not render')
    assert.ok(vp, 'the viewport did not render')
    assert.equal(vp!.contains(s!), false,
      'the slot is INSIDE the viewport — it would inherit the pan/zoom transform')
    assert.equal(s!.parentElement, vp!.parentElement,
      'the slot and the viewport should share a parent (both inside DeskHosts)')
    assert.ok(m.el.querySelector('[data-testid="slot-body"]'),
      'the slot rendered but its content did not')
  })

test('§2 the context carries the live map, the real layout, and the desk routes',
  async (t: TestContext) => {
    const m = await mountCanvas(t)
    const ctx = m.ctx()
    assert.ok(ctx, 'renderOrgSlot was never called')
    assert.equal(ctx!.slug, 'mine')
    assert.ok(ctx!.map.has('alpha') && ctx!.map.has('beta'),
      'the map is not the host\'s own flattened map')
    // posOf must answer for a laid-out agent. It reads springs ?? layout
    // target, so it answers before the camera settles — which is what makes
    // "leftmost top-level" right on the first frame rather than after a settle.
    const p = ctx!.posOf('alpha')
    assert.ok(p && typeof p.x === 'number' && typeof p.y === 'number',
      `posOf('alpha') returned ${JSON.stringify(p)} — the view cannot order by layout`)
    assert.equal(ctx!.posOf('nobody-here'), undefined,
      'posOf invented a position for an agent that is not laid out')
    // the canonical desk routes, passed through rather than restated
    for (const k of ['onMailLink', 'onWorkLink', 'onOpenDoc', 'onJump'] as const) {
      assert.equal(typeof ctx!.deskExtras[k], 'function',
        `deskExtras.${k} is missing — the slot's desk would have to invent it`)
    }
    assert.equal(ctx!.deskExtras.maxTop, 1000, 'deskExtras lost the org grant cap')
  })

test('§3 with no renderOrgSlot there is no slot node at all',
  async (t: TestContext) => {
    // the default path: every existing caller passes neither prop, and must get
    // exactly the DOM it got before.
    const m = await mountCanvas(t, { slot: false })
    assert.equal(slot(m.el), null, 'an empty slot container was rendered anyway')
    assert.equal(m.ctx(), null, 'renderOrgSlot was called despite being absent')
  })

test('§4 shown by default: the world wrapper carries no hidden class or inert',
  async (t: TestContext) => {
    const m = await mountCanvas(t)
    const w = world(m.el)
    assert.ok(w, 'the world wrapper did not render')
    assert.equal(w!.classList.contains('canvas-world-hidden'), false)
    assert.equal(w!.hasAttribute('inert'), false,
      'the SHOWN canvas is inert — this is the React 18 `inert={false}` trap, '
      + 'where the attribute is present with the string "false" and still applies')
    assert.equal(w!.hasAttribute('aria-hidden'), false)
  })

test('§5 hidden: the wrapper is marked, and the VIEWPORT and PIN LAYER are not',
  async (t: TestContext) => {
    const m = await mountCanvas(t, { hidden: true })
    const w = world(m.el), vp = viewport(m.el)
    assert.ok(w!.classList.contains('canvas-world-hidden'), 'the world was not hidden')
    assert.ok(w!.hasAttribute('inert'), 'the hidden world still accepts focus')
    assert.equal(w!.getAttribute('aria-hidden'), 'true')
    // ⚠ THE CONSTRAINT THE WHOLE DESIGN TURNS ON
    assert.equal(vp!.classList.contains('canvas-world-hidden'), false,
      'the VIEWPORT was marked hidden — that takes the pin layer with it')
    assert.equal(vp!.hasAttribute('inert'), false,
      'the viewport was made inert — pinned windows live inside it')
    // the world really does contain the canvas, so the mark reaches it
    assert.ok(w!.querySelector('.space'), 'the world wrapper does not contain .space')
    // …and the adopted pin layer is a sibling of the wrapper, not inside it.
    // adoptPinLayer appends it to the viewport outside React, so if it is ever
    // moved inside the wrapper this fails rather than silently hiding pins.
    const layer = vp!.querySelector('.pin-layer')
    if (layer) {
      assert.equal(w!.contains(layer), false,
        'the pin layer is INSIDE the hidden wrapper — every pinned window would vanish')
    }
  })

test('§6 hiding moves focus out of the world before it goes inert',
  async (t: TestContext) => {
    // `inert` does not blur what is already focused, and a blurred body
    // swallows the next keystroke — so focus is handed to the slot container,
    // which is why that container is focusable at all.
    const m = await mountCanvas(t)
    const w = world(m.el)!
    const focusable = w.querySelector('button') as HTMLElement | null
    assert.ok(focusable, 'no focusable control in the canvas world to test with')
    await inAct(() => { focusable!.focus() })
    assert.equal(document.activeElement, focusable, 'could not focus inside the world')
    await m.render({ hidden: true })
    assert.notEqual(document.activeElement, focusable,
      'focus was left inside a subtree that is now inert')
    assert.equal(w.contains(document.activeElement), false,
      'focus is still somewhere inside the hidden world')
  })

test('§7 a drag on the hidden canvas does not pan it', async (t: TestContext) => {
    // `.viewport` is never hidden — it cannot be — so a press on its background
    // still reaches its handlers. Without the guard, a drag on the presented
    // view's backdrop would move a camera nobody can see, and the move would
    // only be discovered on coming back.
    const m = await mountCanvas(t, { hidden: true });
    const vp = viewport(m.el)!
    const space = m.el.querySelector('.space') as HTMLElement
    const before = space.style.transform
    const press = (type: string, x: number, y: number) =>
      new W.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
    await inAct(() => {
      vp.dispatchEvent(press('pointerdown', 100, 100))
      vp.dispatchEvent(press('pointermove', 260, 240))
    })
    await flush()
    assert.equal((m.el.querySelector('.space') as HTMLElement).style.transform, before,
      'the hidden canvas panned under a drag on the presented view')
  })
