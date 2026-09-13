// servingaccount.test.tsx — WHICH ACCOUNT IS SERVING THE INFERENCE RUNNING
// RIGHT NOW (user requirement 2026-09-13, docket
// `show-the-active-inference-account`).
//
// THE PROBLEM. With several accounts signed in on one provider, nothing in
// the interface said which of them an agent's current turn was actually
// running on. The agent's stored account preference was visible; the account
// the turn SPAWNED under was not, and those two differ exactly when it
// matters — a fallback, a rebind mid-flight, an account switch.
//
// ⚠ WHERE THE RULE LIVES, AND WHY THESE TESTS LOOK THE WAY THEY DO. Every
// gate is applied SERVER-SIDE, where the registry is: is the node busy, is
// the account authoritative, does this provider even have a second signed-in
// account, is the viewer a kiosk visitor. The renderer's whole contract is
// "render `serving_account` if it is there". So the tests split in two:
//
//   §1  the BACKEND gates — backend/tests/test_serving_account.py
//   §2  these: the two surfaces render the field, they render it IDENTICALLY,
//       and the far-zoom presentations do not render it at all.
//
// Asserting the gates again here against a hand-made field would only be
// asserting that a fixture is a fixture.

import './harness'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DeskChat, ServingAccountBadge } from '../src/canvas/desk'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, ServingAccount } from '../src/types'

declare const __SRC_DIR__: string

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5 }

/** the shape `api.annotate` serves — every field registry metadata, no
 *  credential of any kind (backend/tests/test_serving_account.py pins that) */
function serving(extra: Partial<ServingAccount> = {}): ServingAccount {
  return {
    id: 'claude-4', provider: 'claude', label: 'claude-0',
    email: 'second@example.test', auth: 'authenticated', state: 'ready',
    ...extra,
  }
}

function agent(extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'worker', state: 'live', tier: 'opus', model_id: 'opus',
    children: [], parent: 'superior', seat: 5, grant: 0, free: 0,
    scope: { tools: { mcp: [] }, add_dirs: [] }, audiences_held: [],
    ...extra,
  } as unknown as CanvasNode
}

/* ─── the near-zoom node ─────────────────────────────────────────────────── */

function card(n: CanvasNode, lod: 'mini' | 'norm', mapMode = false) {
  return mountView(
    <NodeSquare node={n} pos={{ x: 0, y: 0 }} lod={lod} focused={false}
      dragging={false} isDrop={false} seats={seats}
      map={new Map([[n.id, n]])} op={op} slug="org" toast={noop}
      pxc={1} zoom={lod === 'mini' ? 0.4 : 1} compactAt={0.8} pub={false}
      maxTop={0} kioskRemaining={null} cascadeAlloc mapMode={mapMode}
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
      onInbox={noop} onLineage={noop} onOpenDoc={noop}
      onRecenter={noop} onJump={noop} onMailLink={noop} onWorkLink={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />,
    (el) => el)
}

const onCard = (el: HTMLElement) =>
  el.querySelector<HTMLElement>('.sq-badges .badge.serving-account')

test('§2a the near-zoom node wears the SERVING account id while inference runs',
  async (t: TestContext) => {
    const view = await card(agent({ busy: true, serving_account: serving() }), 'norm')
    t.after(() => view.unmount())
    await flush()
    const badge = onCard(view.el)
    assert.ok(badge, 'no serving-account card on the near-zoom node')
    // THE CANONICAL ACCOUNT ID IS THE VISIBLE TEXT, on its own — the card is a
    // glance answer to "which account is this turn on"
    assert.equal(badge!.textContent, 'claude-4')
    assert.equal(badge!.getAttribute('data-serving-account'), 'claude-4')
  })

test('§2b it is the RUNTIME account, not the agent\'s stored preference',
  async (t: TestContext) => {
    // ⚠ THE WHOLE POINT OF THE TICKET. This node is BOUND to claude-1 and its
    // turn is actually running on claude-9. A card that read the stored
    // preference would say claude-1 and be confidently wrong precisely when a
    // reader needs it — a fallback, or a rebind that has not taken effect yet.
    const view = await card(agent({
      busy: true,
      account: 'claude-1', account_label: 'claude-1',
      serving_account: serving({ id: 'claude-9', email: 'ninth@example.test' }),
    }), 'norm')
    t.after(() => view.unmount())
    await flush()
    const badge = onCard(view.el)!
    assert.equal(badge.textContent, 'claude-9', 'the card showed the BOUND account')
    assert.doesNotMatch(badge.title, /claude-1\b/,
      'the stored preference leaked into the serving card')
  })

test('§2c no field, no card — idle, single-account and unattributable alike',
  async (t: TestContext) => {
    // The backend answers null for every one of those cases, so the renderer
    // has ONE rule and this asserts it. An idle node that still carries a
    // stale `ran_as` is the case worth naming: `ran_as` outlives its turn, so
    // if liveness were read here instead of server-side, an idle agent would
    // keep wearing the account that served it an hour ago.
    for (const n of [
      agent({ busy: false, ran_as: 'claude-4', serving_account: null }),
      agent({ busy: true, serving_account: null }),
      agent({ busy: true }),
    ]) {
      const view = await card(n, 'norm')
      await flush()
      assert.equal(onCard(view.el), null,
        'a card appeared with no serving_account field')
      await view.unmount()
    }
  })

/* ─── the far-zoom exclusions ────────────────────────────────────────────── */

test('§2d FAR ZOOM RENDERS NO ACCOUNT CARD, even mid-inference', async (t: TestContext) => {
  // ⚠ A SEPARATE USER RULE THIS FEATURE MUST NOT ERODE, and it belongs to
  // someone else's change: `FarZoomStateIcon` (landed 7753e55) makes the far
  // node EXACTLY ONE enlarged state icon and nothing else. This card is
  // additive, so it must be absent there — asserted rather than left to the
  // badge row's `lod !== 'mini'` gate happening to stay where it is.
  //
  // The node below is `busy`, so its far-zoom icon is the ACTIVE one — i.e.
  // this is the exact overlap: the one state where both features have
  // something to say about the same node, and only one of them may speak.
  const view = await card(agent({ busy: true, serving_account: serving() }), 'mini')
  t.after(() => view.unmount())
  await flush()
  assert.equal(onCard(view.el), null, 'the account card leaked into far zoom')
  assert.equal(view.el.querySelector('.badge.serving-account'), null,
    'the account card leaked into far zoom outside the badge row')
  assert.equal(view.el.querySelector('[data-serving-account]'), null)
  // …and the far-zoom rule still holds WITH this feature present: one icon,
  // and no badge row for the card to have been added to
  assert.equal(view.el.querySelectorAll('.sq-far-icon').length, 1,
    'far zoom must show exactly one state icon')
  assert.equal(view.el.querySelector('.sq-badges'), null,
    'the badge row reappeared at far zoom')
})

test('§2e the compact map locator renders no account card either', async (t: TestContext) => {
  // the other far-scale presentation: a locator, not a work surface
  const view = await card(agent({ busy: true, serving_account: serving() }), 'norm', true)
  t.after(() => view.unmount())
  await flush()
  assert.equal(view.el.querySelector('[data-serving-account]'), null,
    'the account card leaked into the compact map locator')
})

test('§2f the same node at norm DOES show it — so §2d/§2e prove exclusion, not absence',
  async (t: TestContext) => {
    // ⚠ WITHOUT THIS CONTROL the two tests above would pass on a fixture that
    // never renders a card at any zoom, which is the classic way an exclusion
    // test proves nothing at all.
    const n = agent({ busy: true, serving_account: serving() })
    const view = await card(n, 'norm')
    t.after(() => view.unmount())
    await flush()
    assert.ok(onCard(view.el), 'the shared fixture renders no card at ANY zoom')
  })

/* ─── the Desk header ────────────────────────────────────────────────────── */

function desk(n: CanvasNode) {
  const superior: CanvasNode = {
    id: 'superior', state: 'live', tier: 'sonnet', model_id: 'sonnet',
    children: [n], seat: 2, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  } as unknown as CanvasNode
  return <DeskChat node={n} map={new Map([[n.id, n], ['superior', superior]])}
    op={op} slug="org" toast={noop} pub={false} bare onJump={noop} />
}

const onDesk = (el: HTMLElement) =>
  el.querySelector<HTMLElement>('.cc-head .badge.serving-account')

test('§2g the Desk header wears the same card, in its metadata row',
  async (t: TestContext) => {
    installFetch(new FakeServer())
    const view = await mountView(
      desk(agent({ busy: true, serving_account: serving() })), (el) => el)
    t.after(() => view.unmount())
    await flush()
    const badge = onDesk(view.el)
    assert.ok(badge, 'no serving-account card in the desk header')
    assert.equal(badge!.textContent, 'claude-4')
  })

test('§2h the desk drops the card the moment inference ends', async (t: TestContext) => {
  // THE TRANSITION, ON THE SAME ROOT — the turn finishes, the backend stops
  // composing the field, and the card must go with it rather than linger as a
  // description of a turn that is over.
  installFetch(new FakeServer())
  const view = await mountView(
    desk(agent({ busy: true, serving_account: serving() })), (el) => el)
  t.after(() => view.unmount())
  await flush()
  assert.ok(onDesk(view.el), 'no card while the turn was running')
  await view.render(desk(agent({ busy: false, ran_as: 'claude-4', serving_account: null })))
  await flush()
  assert.equal(onDesk(view.el), null, 'the card outlived the inference it described')
})

/* ─── hover / focus detail, and what must never be in it ─────────────────── */

test('§2i the detail is a REAL element revealed on hover AND keyboard focus',
  async (t: TestContext) => {
    // ⚠ WHY NOT `title`. A native tooltip is rendered by the browser on MOUSE
    // HOVER ONLY — no engine shows one for a keyboard-focused element — so a
    // `title` satisfies exactly half of "on hover or keyboard focus" while
    // looking like it satisfies both. That was the first cut of this card and
    // it is the defect this test exists to keep out.
    const view = await mountView(
      <ServingAccountBadge account={serving()} />, (el) => el)
    t.after(() => view.unmount())
    await flush()
    const badge = view.el.querySelector<HTMLButtonElement>('.badge.serving-account')!
    const tip = view.el.querySelector<HTMLElement>('.serving-account-tip')!
    assert.ok(tip, 'no visible detail surface — a title attribute is not one')
    assert.equal(badge.hasAttribute('title'), false,
      'a native title would be a second, mouse-only tooltip beside the real one')

    // THE DETAIL IS IN THE DOM, as text, not in an attribute
    const shown = tip.textContent ?? ''
    assert.match(shown, /serving this turn/)
    assert.match(shown, /account claude-4/)
    assert.match(shown, /provider claude/)
    assert.match(shown, /label claude-0/)
    assert.match(shown, /second@example\.test/)
    assert.match(shown, /sign-in authenticated/)
    assert.match(shown, /standing ready/)

    // FOCUS REALLY LANDS ON IT — a <span> takes no tab stop, so a
    // focus-revealed tip on one would be unreachable by keyboard
    assert.equal(badge.tagName, 'BUTTON')
    assert.equal(badge.type, 'button', 'a bare button submits enclosing forms')
    badge.focus()
    assert.equal(view.el.ownerDocument.activeElement, badge,
      'the card cannot take keyboard focus at all')
    // …and the tip is the focused element's own sibling, which is what makes
    // the `:focus-visible ~` selector below able to reach it
    assert.equal(tip.previousElementSibling, badge)

    // ⚠ THE REVEAL ITSELF IS CSS, AND JSDOM COMPUTES NEITHER :hover NOR
    // :focus-visible — so the shipped stylesheet is the only place this can
    // be proven. Both halves are required: hover alone was the original bug.
    const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
    const rule = css.match(/([^}]*)\{\s*opacity:\s*1;?\s*\}/g)
      ?.find((r) => r.includes('.serving-account-tip'))
    assert.ok(rule, 'nothing in the stylesheet ever reveals the detail surface')
    assert.match(rule!, /:hover[^{]*\.serving-account-tip/,
      'the detail never appears on hover')
    assert.match(rule!, /:focus-visible\s*~\s*\.serving-account-tip/,
      'the detail never appears on KEYBOARD FOCUS — the half a title cannot do')

    // the accessible label still carries the whole detail for assistive users,
    // and the visible tip is hidden from them so it is not announced twice
    assert.match(badge.getAttribute('aria-label') ?? '', /serving this turn/)
    assert.match(badge.getAttribute('aria-label') ?? '', /second@example\.test/)
    assert.equal(tip.getAttribute('aria-hidden'), 'true')
  })

test('§2j absent details are omitted, never rendered as a guess', async (t: TestContext) => {
  const view = await mountView(
    <ServingAccountBadge account={serving({ label: null, email: null,
      auth: 'unobserved', state: 'limited' })} />, (el) => el)
  t.after(() => view.unmount())
  await flush()
  const badge = view.el.querySelector<HTMLButtonElement>('.badge.serving-account')!
  const shown = view.el.querySelector<HTMLElement>('.serving-account-tip')!.textContent ?? ''
  assert.doesNotMatch(shown, /label/, 'an absent label was rendered anyway')
  assert.doesNotMatch(shown, /undefined|null|unknown/)
  // `unobserved` MEANS NOBODY HAS LOOKED, not that the account is gone — it
  // still counts as available, and it must render as itself, never as ready
  assert.match(shown, /sign-in unobserved/)
  // A LIMITED ACCOUNT STILL SERVES — it is out of room this window, not gone.
  // The card stays; the standing is a note on it.
  assert.match(shown, /standing limited/)
  assert.ok(badge.classList.contains('state-limited'))
  assert.equal(badge.textContent, 'claude-4')
})

test('§2k nothing credential-shaped can reach the card', async (t: TestContext) => {
  // ⚠ A RENDERER-SIDE BACKSTOP, not the real guarantee — the backend never
  // composes such a field (pinned in test_serving_account.py). This asserts
  // that even handed one, the card renders only the fields it declares, so a
  // future field added to the payload cannot leak through this component.
  const hostile = {
    ...serving(),
    token: 'sk-ant-SECRET', credential: { path: 'C:/profiles/x', token_ref: 'tok' },
    api_key: 'AKIA-NOPE',
  } as unknown as ServingAccount
  const view = await mountView(<ServingAccountBadge account={hostile} />, (el) => el)
  t.after(() => view.unmount())
  await flush()
  // ⚠ THE WHOLE RENDERED SUBTREE, not just the button — the detail surface is
  // a SIBLING of it, so reading `badge.outerHTML` would miss exactly the
  // element the secrets would most likely land in.
  const all = view.el.innerHTML
  assert.ok(all.includes('claude-4'), 'the fixture rendered nothing to inspect')
  assert.ok(all.includes('serving-account-tip'), 'the tip is not in the subtree read')
  for (const secret of ['sk-ant-SECRET', 'AKIA-NOPE', 'tok', 'C:/profiles/x']) {
    assert.equal(all.includes(secret), false, `${secret} reached the DOM`)
  }
})

/* ─── the two surfaces cannot drift ──────────────────────────────────────── */

test('§2l card and desk render the SAME text and the SAME detail', async (t: TestContext) => {
  // One component serves both, exactly as RouteBadge does — this is what
  // stops the node and the desk wording the same fact two ways.
  installFetch(new FakeServer())
  const account = serving({ id: 'openai-1', provider: 'openai',
    label: 'openai-0', email: 'codex@example.test', state: 'limited' })
  const c = await card(agent({ busy: true, serving_account: account }), 'norm')
  t.after(() => c.unmount())
  await flush()
  const d = await mountView(desk(agent({ busy: true, serving_account: account })), (el) => el)
  t.after(() => d.unmount())
  await flush()
  const a = onCard(c.el)!, b = onDesk(d.el)!
  assert.equal(a.textContent, b.textContent)
  assert.equal(a.className, b.className)
  assert.equal(a.getAttribute('aria-label'), b.getAttribute('aria-label'))
  // the VISIBLE detail surface must agree too, not just the label
  const tipOf = (el: Element) =>
    el.parentElement!.querySelector('.serving-account-tip')!.textContent
  assert.equal(tipOf(a), tipOf(b))
})

/* ─── the cards it must not displace ─────────────────────────────────────── */

test('§2m the existing badges are all still there beside it', async (t: TestContext) => {
  // "Preserve all existing provider/model, state, usage, reserve, generation,
  // limit and timing cards outside this additive condition." This is additive
  // or it is wrong.
  const n = agent({
    busy: true, serving_account: serving(),
    limit_locked: true,
    pending_switch: { tier: 'sonnet', at: '2026-09-13T12:00:00Z' },
    codex_route: { route: 'reserve', pool: 'reserve', model: 'gpt-reserve',
      requested: 'luna', reason: 'granted', selection: 'preflight',
      prefer: 'reserve', outcome: null, reported_model: null, live: true,
      at: '2026-09-13T12:00:00Z', label: 'reserve' },
  })
  const view = await card(n, 'norm')
  t.after(() => view.unmount())
  await flush()
  const badges = view.el.querySelector('.sq-badges')!
  assert.ok(badges.querySelector('.badge.serving-account'), 'the new card is missing')
  assert.ok(badges.querySelector('[class*="route-"]'), 'the reserve token was displaced')
  assert.ok(badges.querySelector('.badge.queued'), 'the queued-switch chip was displaced')
  assert.ok(badges.querySelector('.badge.dim'), 'the limit chip was displaced')
})

test('§2n the card does not swallow the press that focuses the agent',
  async (t: TestContext) => {
    // ⚠ THE LESSON `ActionBadge` IS BUILT ON. A control in the badge row has
    // to stop its own pointerdown to survive the viewport's pointer capture —
    // and doing so ALSO starves the drag-start→focus path the user relies on
    // to click anywhere on a card and open it. So this card stops the event
    // at itself and the card body must still receive its own presses.
    const downs: string[] = []
    const n = agent({ busy: true, serving_account: serving() })
    const view = await mountView(
      <NodeSquare node={n} pos={{ x: 0, y: 0 }} lod="norm" focused={false}
        dragging={false} isDrop={false} seats={seats}
        map={new Map([[n.id, n]])} op={op} slug="org" toast={noop}
        pxc={1} zoom={1} compactAt={0.8} pub={false}
        maxTop={0} kioskRemaining={null} cascadeAlloc
        onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
        onInbox={noop} onLineage={noop} onOpenDoc={noop}
        onRecenter={noop} onJump={noop} onMailLink={noop} onWorkLink={noop}
        onDragStart={(_e, id) => downs.push(id)}
        onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)
    t.after(() => view.unmount())
    await flush()
    const badge = onCard(view.el)!
    await inAct(async () => {
      badge.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
      await flush(2)
    })
    assert.deepEqual(downs, [], 'the press on the card reached the drag handler')
    // …and the card itself still does
    const body = view.el.querySelector('.sq')!
    await inAct(async () => {
      body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
      await flush(2)
    })
    assert.deepEqual(downs, ['worker'], 'the card stopped receiving its own presses')
  })
