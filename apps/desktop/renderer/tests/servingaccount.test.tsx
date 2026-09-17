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

test('idle Codex card identifies the configured account', async (t: TestContext) => {
  // ⚠ WHAT THIS ASSERTS CHANGED WITH THE 2026-09-17 TOOLTIP CUT. It used to
  // require the words "configured account" (and their absence for a live
  // turn) in the detail panel, because the panel had a heading that named
  // which of the two the card was. The panel is gone and the tooltip is the
  // id and the email only, so `active` is no longer read at all — the card is
  // still present and still names the account, which is the half of this test
  // the user's requirement actually rested on.
  const account = serving({ id: 'openai-1', provider: 'openai', active: false })
  const view = await card(agent({
    busy: false, tier: 'luna', model_id: 'luna', account: 'openai-1',
    serving_account: account,
  }), 'norm')
  t.after(() => view.unmount())
  await flush()
  const badge = onCard(view.el)
  assert.ok(badge, 'no configured-account card on an idle Codex node')
  assert.equal(badge!.textContent, 'openai-1')
  assert.equal(badge!.getAttribute('title'), 'openai-1 · second@example.test')
  assert.equal(badge!.getAttribute('aria-label'), 'openai-1 · second@example.test')
})

test('Codex cards render exact default, secondary, and API-key display tokens',
  async (t: TestContext) => {
    const defaultView = await card(agent({
      busy: false, tier: 'luna', model_id: 'luna', account: 'openai/primary',
      serving_account: serving({id: 'openai/primary', provider: 'openai',
        display: 'default', active: false}),
    }), 'norm')
    t.after(() => defaultView.unmount())
    await flush()
    const defaultBadge = onCard(defaultView.el)!
    assert.equal(defaultBadge.textContent, 'default')
    assert.doesNotMatch(defaultBadge.textContent ?? '', /openai\/|primary/)
    // the tooltip carries the DISPLAY token too, never the qualified id — the
    // detail panel used to be the place this could leak, and now the `title`
    // is, so the assertion moved with it rather than being dropped
    assert.doesNotMatch(defaultBadge.getAttribute('title') ?? '', /openai\/|primary/)
    assert.doesNotMatch(defaultBadge.getAttribute('aria-label') ?? '', /openai\/|primary/)

    const keyView = await card(agent({
      busy: true, tier: 'luna', model_id: 'luna',
      serving_account: serving({id: 'ak123', provider: 'openai',
        display: 'sk-live-', active: true}),
    }), 'norm')
    t.after(() => keyView.unmount())
    await flush()
    const keyBadge = onCard(keyView.el)!
    assert.equal(keyBadge.textContent, 'sk-live-')
    assert.doesNotMatch(keyView.el.textContent ?? '', /openai\/|primary/)
  })

test('a busy Codex agent wears its card BESIDE the reserve badge, and a busy '
  + 'Claude agent keeps its own in the same org', async (t: TestContext) => {
  // ⚠ THE REOPENED REGRESSION (user report 2026-09-14). In the installed
  // 2.1.4 the user saw account cards on every claude agent and none on any
  // codex agent. The renderer was never the cause — it is provider-blind,
  // and that is exactly what this pins: given the field, BOTH providers wear
  // it, mid-turn, in the same org, and the codex card sits beside the route
  // badge rather than in place of it. The backend half of the same
  // regression — the codex leg capturing `ran_as` at all, without which a
  // busy codex node is composed as null and there is nothing to render — is
  // in tests/test_serving_account.py.
  const route = {
    route: 'reserve', pool: 'reserve', model: 'gpt-5.6', requested: 'gpt-5.6',
    reason: 'preference', selection: 'preflight', prefer: 'reserve',
    outcome: null, reported_model: null, live: true, at: null,
    // `on_reserve` is the backend's lane answer and the reserve card's one
    // gate (user ruling 2026-09-16); true here because this fixture is a
    // genuine reserve turn and the point of the test is that the account
    // card sits BESIDE the reserve token rather than replacing it
    on_reserve: true, label: 'reserve',
  } as CanvasNode['codex_route']
  const codex = await card(agent({
    id: 'luna-worker', busy: true, tier: 'luna', model_id: 'luna',
    codex_route: route,
    serving_account: serving({ id: 'openai-1', provider: 'openai',
      display: 'openai-1', label: 'openai-0', active: true }),
  }), 'norm')
  t.after(() => codex.unmount())
  await flush()
  const codexBadge = onCard(codex.el)
  assert.ok(codexBadge, 'the busy Codex agent wore no account card')
  assert.equal(codexBadge!.textContent, 'openai-1')
  assert.ok(codex.el.querySelector('.badge.route-reserve'),
    'the account card displaced the reserve badge')

  const claude = await card(agent({
    id: 'opus-worker', busy: true,
    serving_account: serving({ display: 'claude-4', active: true }),
  }), 'norm')
  t.after(() => claude.unmount())
  await flush()
  assert.equal(onCard(claude.el)!.textContent, 'claude-4',
    'restoring the Codex card cost the Claude one')
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

test('the Desk header keeps the idle configured-account card', async (t: TestContext) => {
  installFetch(new FakeServer())
  const view = await mountView(desk(agent({
    busy: false, tier: 'luna', model_id: 'luna', account: 'openai-1',
    serving_account: serving({ id: 'openai-1', provider: 'openai', active: false }),
  })), (el) => el)
  t.after(() => view.unmount())
  await flush()
  const badge = onDesk(view.el)
  assert.ok(badge, 'no configured-account card in the idle Desk header')
  // the heading that said which of the two it was went with the detail panel
  // (2026-09-17); the card's PRESENCE while idle is what this test is for
  assert.equal(badge!.getAttribute('aria-label'), 'openai-1 · second@example.test')
})

/* ─── hover detail, and what must never be in it ─────────────────────────── */

test('§2i the detail is a plain title carrying the id and the email, and nothing else',
  async (t: TestContext) => {
    // ⚠ THIS TEST WAS INVERTED ON 2026-09-17, BY THE USER, DELIBERATELY. It
    // used to require the OPPOSITE: a real `.serving-account-tip` element
    // revealed by CSS on `:hover` and `:focus-visible`, listing account,
    // provider, label, email, sign-in and standing, and it asserted that the
    // badge carried NO `title` at all. The user saw that six-row panel in the
    // zoom view, said "remove everything else", and asked for an ordinary
    // hover tooltip with the bare minimum — the id and the email. So the
    // panel is gone and the assertions are its mirror image: there must be no
    // detail element, there must be a `title`, and it must be exactly two
    // fields. The keyboard half the panel existed to serve is now carried by
    // `aria-label`, which is why it is asserted to be the same short string.
    const view = await mountView(
      <ServingAccountBadge account={serving()} />, (el) => el)
    t.after(() => view.unmount())
    await flush()
    const badge = view.el.querySelector<HTMLButtonElement>('.badge.serving-account')!
    assert.equal(view.el.querySelector('.serving-account-tip'), null,
      'the custom detail panel is back')
    assert.equal(view.el.querySelector('.serving-account-wrap'), null,
      'the panel is gone but its positioning wrapper was left behind')

    // EXACTLY THE ID AND THE EMAIL — asserted as equality, not a match, so a
    // seventh field creeping back in fails rather than passing on a substring
    assert.equal(badge.getAttribute('title'), 'claude-4 · second@example.test')
    assert.equal(badge.getAttribute('aria-label'), 'claude-4 · second@example.test')
    for (const gone of ['provider', 'claude-0', 'sign-in', 'authenticated',
      'standing', 'serving this turn', 'configured account']) {
      assert.doesNotMatch(badge.getAttribute('title') ?? '', new RegExp(gone),
        `the tooltip still carries "${gone}"`)
    }

    // FOCUS STILL LANDS ON IT. A native tooltip is mouse-only, so the tab stop
    // is what keeps the `aria-label` reachable at all for a keyboard reader.
    assert.equal(badge.tagName, 'BUTTON')
    assert.equal(badge.type, 'button', 'a bare button submits enclosing forms')
    badge.focus()
    assert.equal(view.el.ownerDocument.activeElement, badge,
      'the card cannot take keyboard focus at all')

    // ⚠ AND THE STYLESHEET NO LONGER REVEALS ANYTHING. jsdom computes neither
    // :hover nor :focus-visible, so the shipped file is the only place the
    // panel's removal can be proven; a rule left behind would be dead CSS
    // waiting for the element to come back.
    const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
    const rule = css.match(/([^}]*)\{\s*opacity:\s*1;?\s*\}/g)
      ?.find((r) => r.includes('.serving-account-tip'))
    assert.equal(rule, undefined, 'the reveal rule outlived the element')
    assert.doesNotMatch(css, /^\.serving-account-wrap\b/m,
      'the wrapper rule outlived the element')
  })

test('§2j absent details are omitted, never rendered as a guess', async (t: TestContext) => {
  const view = await mountView(
    <ServingAccountBadge account={serving({ label: null, email: null,
      auth: 'unobserved', state: 'limited' })} />, (el) => el)
  t.after(() => view.unmount())
  await flush()
  const badge = view.el.querySelector<HTMLButtonElement>('.badge.serving-account')!
  // ⚠ NO EMAIL MEANS THE ID ALONE — not "claude-4 · ", not "unknown". The
  // separator is part of the email's half of the string, so an absent address
  // takes it with it. `label`, `sign-in` and `standing` are no longer shown
  // anywhere (2026-09-17), so this only has the one field left to check.
  assert.equal(badge.getAttribute('title'), 'claude-4')
  assert.equal(badge.getAttribute('aria-label'), 'claude-4')
  assert.doesNotMatch(badge.getAttribute('title') ?? '', /·|undefined|null|unknown/)
  // `unobserved` MEANS NOBODY HAS LOOKED and a LIMITED ACCOUNT STILL SERVES —
  // both are still rendered, as the CLASS they always chose, which is what
  // colours the badge. That half of the contract did not move.
  assert.ok(badge.classList.contains('auth-unobserved'))
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
  // ⚠ THE WHOLE RENDERED SUBTREE, not just the button's text — the `title`
  // and `aria-label` attributes are where a whitelist mistake would land now
  // that the sibling detail panel is gone (2026-09-17), and `innerHTML`
  // carries attributes as well as text.
  const all = view.el.innerHTML
  assert.ok(all.includes('claude-4'), 'the fixture rendered nothing to inspect')
  assert.ok(all.includes('title='), 'the tooltip is not in the subtree read')
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
  // the HOVER TOOLTIP must agree too, not just the label — it replaced the
  // detail panel this line used to compare (2026-09-17)
  assert.equal(a.getAttribute('title'), b.getAttribute('title'))
  assert.equal(a.getAttribute('title'), 'openai-1 · codex@example.test')
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
      at: '2026-09-13T12:00:00Z', on_reserve: true, label: 'reserve' },
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
