// deskowner.test.tsx — WHICH SLOT OWNS THE ONE LIVE DESK.
//
// The desk registry allows several slots to register for one agent and keeps
// exactly one `OwnedDeskChat` between them; every other slot draws the
// canonical "X's desk is open elsewhere · Show desk" placeholder. So the
// placeholder IS the witness: the slot that does not have it is the owner.
// These tests read ownership that way rather than reaching into the registry,
// because the placeholder is what the user actually sees.
//
// WHY THE RULE EXISTS. The Attention view (add-an-attention-view) mounts a
// canonical desk panel of its own, so for the first time two slots for one
// agent are routinely alive at once — one on the canvas, one in the Attention
// stage. Without a rule, whichever rendered last took the desk, and the
// Attention panel would take it away from a pinned window the user had
// deliberately placed. The user ruled (via coordinator-sol, 2026-09-21) that a
// VISIBLE pin keeps its desk and Attention shows the canonical controls, while
// a HIDDEN embedded owner relinquishes.
//
// ⚠ AND THE RULE IS DELIBERATELY NARROW, WHICH IS WHAT §4 BELOW GUARDS. An
// earlier design protected any "placed" owner from any claim, which rewrote pin
// ownership in general — it changed today's behaviour for an agent that is
// pinned AND open in an eye/switchboard panel, where the panel currently takes
// the desk. multi-window-design ruled that the user ruled on Attention and not
// on that, and refused the proposed patch of labelling the eye panel "placed"
// because it would make the field mean something false. So the deciding fact is
// the CLAIM (`claim: 'automatic'`, set only by the Attention stage) and §4 is
// the control proving the eye-panel case still behaves as it did BEFORE this
// change — not as the withdrawn design would have had it.
import './harness'
import { FakeServer, flush, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { resetConvos } from '../src/convo'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

const agent = (id: string): CanvasNode => ({
  id, tier: 'opus', state: 'live', generation: 0, parent: null, children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: { mcp: [] }, add_dirs: [] },
} as unknown as CanvasNode)

/** two slots for ONE agent, each in a labelled box so the placeholder can be
 *  attributed to the slot that drew it. `which` names the boxes. */
function twoSlots(node: CanvasNode, a: Record<string, unknown>, b: Record<string, unknown>) {
  const map = new Map([[node.id, node]])
  return (
    <DeskHosts map={map} slug="org">
      <div data-which="A">
        <DeskSlot node={node} map={map} op={op} slug="org" toast={noop} pub={false}
          bare {...a} />
      </div>
      <div data-which="B">
        <DeskSlot node={node} map={map} op={op} slug="org" toast={noop} pub={false}
          bare {...b} />
      </div>
    </DeskHosts>
  )
}

/** the slot that is NOT the owner — read off the canonical placeholder */
const elsewhere = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('[data-which]')]
    .filter((box) => /desk is open elsewhere/.test(box.textContent ?? ''))
    .map((box) => box.getAttribute('data-which')!)

/** every slot renders its host; exactly one of them holds the real desk */
const owner = (el: HTMLElement): string => {
  const off = elsewhere(el)
  const all = [...el.querySelectorAll('[data-which]')].map((b) => b.getAttribute('data-which')!)
  const own = all.filter((w) => !off.includes(w))
  assert.equal(own.length, 1,
    `expected exactly ONE owning slot, found ${own.length} (${own.join()}) — `
    + 'a second live composer is the failure this registry exists to prevent')
  return own[0]
}

const setup = () => { resetConvos(); installFetch(new FakeServer()) }

test('§1 LEGACY: with no new fields, the last slot to register wins',
  async (t: TestContext) => {
    // ⚠ THIS IS THE BEHAVIOUR THE WHOLE CHANGE HAD TO PRESERVE, and the reason
    // an earlier draft of the picker was wrong. `put` fires on registration AND
    // on every prop update, so the live rule is "last writer wins", not "first
    // registration wins". A picker that preferred the incumbent globally would
    // pass every Attention test and silently change this.
    setup()
    const n = agent('alpha')
    const view = await mountView(twoSlots(n, {}, {}), (el) => el)
    t.after(() => view.unmount())
    await flush()
    assert.equal(owner(view.el), 'B', 'the later-registering slot should own it')
  })

test('§2 an AUTOMATIC claim does not take the desk from a visible owner',
  async (t: TestContext) => {
    // A registers first and is eligible (a visible pinned window). B is the
    // Attention stage mounting. Under the plain last-writer-wins rule of §1, B
    // would take it; the automatic claim must defer instead.
    setup()
    const n = agent('beta')
    const view = await mountView(
      twoSlots(n, {}, { claim: 'automatic' }), (el) => el)
    t.after(() => view.unmount())
    await flush()
    assert.equal(owner(view.el), 'A',
      'the automatic claim took the desk from a visible owner')
    assert.deepEqual(elsewhere(view.el), ['B'],
      'the Attention slot should show the canonical open-elsewhere controls')
  })

test('§2b …and it still does not take it after repeated re-renders',
  async (t: TestContext) => {
    // ⚠ THE ACTUAL BUG THE SECOND DESIGN HAD. Deferring only at MOUNT is not
    // enough: `put` runs again on every prop change, so a picker that checked
    // the incoming slot before the incumbent lost the pin on the next render
    // rather than the first. Re-render with changed props several times.
    setup()
    const n = agent('gamma')
    const view = await mountView(
      twoSlots(n, {}, { claim: 'automatic' }), (el) => el)
    t.after(() => view.unmount())
    await flush()
    assert.equal(owner(view.el), 'A', 'lost the pin at mount')
    // Re-render the SAME root with a changed prop on the claiming slot. That is
    // the real path: RegisteredSlot's registration effect depends on `props`,
    // so every one of these calls `put` again with the automatic slot as the
    // incoming one — which is precisely where the previous design handed the
    // desk over.
    for (const compactAt of [0.4, 0.5, 0.6]) {
      await view.render(twoSlots(n, {}, { claim: 'automatic', compactAt }))
      await flush()
      assert.equal(owner(view.el), 'A',
        `the pin lost the desk on a re-render (compactAt ${compactAt}), not at mount`)
    }
  })

test('§3 THE COUNTEREXAMPLE THAT MUST YIELD: a HIDDEN owner relinquishes',
  async (t: TestContext) => {
    // The other half of the ruling. If step 2 held unconditionally it would
    // park the desk in a destination nobody can see — so this is the control
    // that proves the deferral is not over-broad. A is the canvas slot behind a
    // presented Attention stage, so it is not eligible.
    setup()
    const n = agent('delta')
    const view = await mountView(
      twoSlots(n, { eligible: false }, { claim: 'automatic' }), (el) => el)
    t.after(() => view.unmount())
    await flush()
    assert.equal(owner(view.el), 'B',
      'a hidden embedded owner kept the desk instead of relinquishing it')
  })

test('§4 THE NARROWING CONTROL: an ordinary claim still wins, eye-panel case',
  async (t: TestContext) => {
    // ⚠ THIS MUST PASS AS TODAY, NOT AS THE WITHDRAWN DESIGN. An agent can be
    // pinned and simultaneously open in an eye/switchboard panel, and the panel
    // takes the desk today because a pin is not `detached` and `put` promotes
    // every registration. The withdrawn `placed` design changed that. The user
    // ruled on Attention only, so B here — an ordinary eligible claim with NO
    // `claim` field, exactly what the eye panel passes — must still take it.
    setup()
    const n = agent('epsilon')
    const view = await mountView(twoSlots(n, {}, { eligible: true }), (el) => el)
    t.after(() => view.unmount())
    await flush()
    assert.equal(owner(view.el), 'B',
      'the eye-panel case changed behaviour — the narrowing failed and this is '
      + 'a general pin-ownership rewrite, which is what the ruling forbade')
  })

test('§5 an automatic claim DOES take an unowned desk', async (t: TestContext) => {
    // Deferral is to a visible OWNER, not to the mere existence of another
    // slot: with nothing else registered the Attention stage must simply get
    // the desk, or the panel would never show one.
    setup()
    const n = agent('zeta')
    const map = new Map([[n.id, n]])
    const view = await mountView(
      <DeskHosts map={map} slug="org">
        <div data-which="A">
          <DeskSlot node={n} map={map} op={op} slug="org" toast={noop} pub={false}
            bare claim="automatic" />
        </div>
      </DeskHosts>, (el) => el)
    t.after(() => view.unmount())
    await flush()
    assert.equal(elsewhere(view.el).length, 0,
      'the only slot there showed an open-elsewhere placeholder pointing at nothing')
  })

test('§6 NEVER HOMELESS: an all-ineligible registry still has exactly one owner',
  async (t: TestContext) => {
    // Eligibility reorders preference; it must never leave a desk with no host.
    // If this regressed, a mode switch that marked everything ineligible for
    // one commit would drop the live composer.
    setup()
    const n = agent('eta')
    const view = await mountView(
      twoSlots(n, { eligible: false }, { eligible: false }), (el) => el)
    t.after(() => view.unmount())
    await flush()
    // `owner` itself asserts exactly one; the point here is that it does not throw
    assert.ok(owner(view.el), 'an all-ineligible registry left the desk homeless')
  })
