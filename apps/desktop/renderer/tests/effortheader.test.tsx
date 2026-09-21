// effortheader.test.tsx — SHOW A NON-DEFAULT THINKING EFFORT ON BOTH AGENT
// HEADERS (docket `show-non-default-effort-level-on-agent-headers`).
//
// THE PROBLEM. An agent's configured reasoning effort was invisible on the
// zoomed-out canvas card and in the desk header, so an agent deliberately
// pinned above or below the org default looked like every other agent. The
// fix is one compact header card, in the same `.badge` language as the MCP,
// cache-readiness, cost and account indicators beside it, shown ONLY when the
// agent is non-default — and rendered from ONE shared component so the two
// surfaces cannot disagree.
//
// ⚠ WHAT "DEFAULT" MEANS HERE IS NOT THIS SUITE'S INVENTION, and these tests
// are written so that it cannot quietly become one. `ledger.Org
// .effective_effort` resolves a turn's effort as `scope.effort ||
// org.default_effort || ""`, clamped to EFFORTS else `Org.DEFAULT_EFFORT`.
// Both halves of that fallback ship in the tree payload (`default_effort`,
// `effort_default`). So §1d below pins the case that a hardcoded "high" would
// get exactly backwards: an org whose default is `low`.
//
//   §1  the rule, as a table — the whole appear/disappear decision
//   §2  the canvas card
//   §3  the desk header
//   §4  the two surfaces agree, and keep agreeing when the value changes
//   §5  the far-scale presentations, which this card must not erode

import './harness'
import { FakeServer, flush, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DeskChat } from '../src/canvas/desk'
import { NodeSquare } from '../src/canvas/cards'
import { EFFORT_LEVELS, EffortLevelBadge, OrgDefaultEffort, nonDefaultEffort, resolveOrgDefault } from '../src/canvas/effort'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

declare const __SRC_DIR__: string

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5 }

/** what `Org.DEFAULT_EFFORT` resolves to today — used ONLY as a fixture value,
 *  never as a fallback inside the renderer (that is the point of §1d) */
const ORG_DEFAULT = 'high'

/** An agent card/desk node. `effort_effective` is the server-derived
 *  `Org.effective_effort` — the field the renderer displays — and `scope
 *  .effort` is the agent's own setting, the field that answers "was this
 *  pinned by a human at all". The two are set together here exactly as the
 *  backend composes them. */
function agent(own: string, effective: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'worker', state: 'live', tier: 'opus', model_id: 'opus',
    children: [], parent: 'superior', seat: 5, grant: 0, free: 0,
    scope: { tools: { mcp: [] }, add_dirs: [], ...(own ? { effort: own } : {}) },
    effort_effective: effective,
    audiences_held: [],
    ...extra,
  } as unknown as CanvasNode
}

/* ─── §1 the rule ────────────────────────────────────────────────────────── */

test('§1a an agent with NO effort of its own reports nothing', () => {
  // it follows the org default live (user ruling 2026-08-01, visible inherit),
  // so there is no configured level to show — whatever the default happens to
  // be, and even though `effort_effective` is never empty.
  assert.equal(nonDefaultEffort(agent('', ORG_DEFAULT), ORG_DEFAULT), null)
  assert.equal(nonDefaultEffort(agent('', 'low'), 'low'), null)
})

test('§1b an agent pinned AT the ordinary default reports nothing either', () => {
  // ⚠ THE CASE THE TICKET NAMES EXPLICITLY. `scope.effort` is set, so the
  // agent was configured — but it was configured to the same level everyone
  // else already runs at, which is not news and gets no card.
  assert.equal(nonDefaultEffort(agent(ORG_DEFAULT, ORG_DEFAULT), ORG_DEFAULT), null)
})

test('§1c a pinned agent ABOVE or BELOW the default reports its level', () => {
  assert.equal(nonDefaultEffort(agent('xhigh', 'xhigh'), ORG_DEFAULT), 'xhigh')
  assert.equal(nonDefaultEffort(agent('max', 'max'), ORG_DEFAULT), 'max')
  assert.equal(nonDefaultEffort(agent('low', 'low'), ORG_DEFAULT), 'low')
  assert.equal(nonDefaultEffort(agent('medium', 'medium'), ORG_DEFAULT), 'medium')
})

test('§1d THE ORG DEFAULT IS THE ORG\'S, not a constant in the renderer',
  () => {
    // ⚠ THE TEST A HARDCODED "high" FAILS, and it fails INVERTED rather than
    // merely missing a card: in an org whose `default_effort` is `low`, every
    // untouched agent runs at low and the one interesting agent is the one
    // pinned at high. A renderer that believed the default were always high
    // would badge every ordinary agent and stay silent about the unusual one.
    assert.equal(nonDefaultEffort(agent('high', 'high'), 'low'), 'high')
    assert.equal(nonDefaultEffort(agent('low', 'low'), 'low'), null)
    // …and the same agent, read against the other org, flips back
    assert.equal(nonDefaultEffort(agent('low', 'low'), 'high'), 'low')
  })

test('§1e an UNSUPPORTED stored level is not a configuration and is not shown',
  () => {
    // the easy half: in an org at the plain default, a junk `scope.effort`
    // clamps to that same default and there is nothing to say
    assert.equal(nonDefaultEffort(agent('ludicrous', ORG_DEFAULT), ORG_DEFAULT), null)

    // ⚠ THE HALF THAT IS NOT THE SAME STATEMENT (multi-window-design,
    // 2026-09-21). `effective_effort` clamps an unsupported value to
    // `Org.DEFAULT_EFFORT` — NOT to `org.default_effort`. So in an org whose
    // default is `low`, an agent carrying junk really does run at `high`, and
    // a card that read only the effective value would badge it "Effort high,
    // set on this agent" for a level nobody chose. The configured value is
    // validated against the supported list FIRST, so this is silent.
    assert.equal(nonDefaultEffort(agent('ludicrous', 'high'), 'low'), null,
      'a junk stored level was advertised as a deliberate configuration')
    // and the control that proves the fixture is not simply inert: the same
    // org, the same clamped-to level, but genuinely configured, DOES show
    assert.equal(nonDefaultEffort(agent('high', 'high'), 'low'), 'high')

    // ⚠ READ THIS ONE CAREFULLY — IT IS NOT "A JUNK ORG DEFAULT MEANS
    // SILENCE", AND IT USED TO BE. In the first candidate this line was
    // commented as "an org-level junk value leaves this render with no default
    // to compare against", and that reading was the defect: the reviewer's
    // finding f4 was partly that this assertion pinned the wrong answer and
    // would outlive the ticket. See §1x for what a junk ORG default actually
    // does — it falls through to `effort_default` and the card still appears.
    //
    // What survives here is narrower and different: `nonDefaultEffort` takes
    // the ALREADY-RESOLVED default, so an unsupported value reaching it means
    // a CALL SITE skipped `resolveOrgDefault`. That is a programming error,
    // and going quiet is the safe response to it — never a statement about
    // how orgs with odd configuration are rendered.
    assert.equal(nonDefaultEffort(agent('xhigh', 'xhigh'), 'ludicrous'), null,
      'an unresolved default was compared against as if it were a level')
    // and the same agent, with that same org resolved PROPERLY, does show —
    // so the line above can never again be mistaken for the org-default rule
    assert.equal(
      nonDefaultEffort(agent('xhigh', 'xhigh'), resolveOrgDefault('ludicrous', 'high')),
      'xhigh')
  })

test('§1f with no org default in hand, nothing is claimed', () => {
  // "non-default" is a comparison. A render that was never told the default
  // cannot make it, and must not fall back to a level of its own.
  assert.equal(nonDefaultEffort(agent('xhigh', 'xhigh'), ''), null)
  assert.equal(nonDefaultEffort(agent('xhigh', 'xhigh'), null), null)
  assert.equal(nonDefaultEffort(agent('xhigh', 'xhigh'), undefined), null)
})

/* ─── §1x the org-default resolver ───────────────────────────────────────── */
//
// ⚠ THIS SECTION EXISTS BECAUSE THE FIRST CANDIDATE (0dbede2) GOT IT WRONG.
// The provider read `tree.default_effort || tree.effort_default || ''`, and
// `||` cannot tell "unset" from "unsupported": a truthy junk override
// short-circuited it and took the authoritative fallback with it, so the
// resolver had nothing left and EVERY agent in the org went silent — including
// validly configured ones. The backend does the opposite there, clamping to
// DEFAULT_EFFORT, which is exactly the fallback that was discarded.

test('§1x1 resolveOrgDefault mirrors effective_effort\'s chain', () => {
  // a supported override wins outright
  assert.equal(resolveOrgDefault('low', 'high'), 'low')
  // no override at all falls through to what "" resolves to
  assert.equal(resolveOrgDefault('', 'high'), 'high')
  assert.equal(resolveOrgDefault(null, 'high'), 'high')
  assert.equal(resolveOrgDefault(undefined, 'high'), 'high')
  // ⚠ THE REGRESSION: an UNSUPPORTED override must fall through too, exactly
  // as the backend clamps it, and must NOT swallow the fallback
  assert.equal(resolveOrgDefault('ludicrous', 'high'), 'high',
    'an unsupported org override swallowed the authoritative fallback')
  // only when NEITHER field names a level is there nothing to compare against
  assert.equal(resolveOrgDefault('ludicrous', 'nonsense'), '')
  assert.equal(resolveOrgDefault('ludicrous', ''), '')
  assert.equal(resolveOrgDefault(null, null), '')
})

test('§1x2 an unsupported ORG override is NOT the same rule as an unsupported '
  + 'AGENT setting', () => {
  // the distinction the fix must preserve. On the ORG it means "fall through",
  // because the default is a fact about what everyone else runs at. On the
  // AGENT it means "no configured level to report", and the silence is
  // deliberate — the backend clamps that agent to DEFAULT_EFFORT, so there is
  // no chosen level for a card to name.
  const org = resolveOrgDefault('ludicrous', 'high')
  assert.equal(org, 'high', 'the org override did not fall through')
  assert.equal(nonDefaultEffort(agent('xhigh', 'xhigh'), org), 'xhigh',
    'a validly configured agent went silent under a junk ORG override')
  assert.equal(nonDefaultEffort(agent('ludicrous', 'high'), org), null,
    'a junk AGENT setting was advertised as a deliberate configuration')
})

test('§1x3 the resolved default is what silence is measured against', () => {
  // an agent sitting at the level the org REALLY defaults to stays quiet, even
  // though the org's own field is junk and only the fallback names that level
  const org = resolveOrgDefault('ludicrous', 'high')
  assert.equal(nonDefaultEffort(agent('high', 'high'), org), null,
    'an agent at the resolved ordinary default was badged as non-default')
})

test('§1g the level list is the composer control\'s list, in order', () => {
  // one list, so the card and the five-dot effort switch can never offer or
  // describe different levels
  assert.deepEqual([...EFFORT_LEVELS], ['low', 'medium', 'high', 'xhigh', 'max'])
})

/* ─── §2 the canvas card ─────────────────────────────────────────────────── */

function card(n: CanvasNode, lod: 'mini' | 'norm', orgDefault = ORG_DEFAULT, mapMode = false) {
  return mountView(
    <OrgDefaultEffort.Provider value={orgDefault}>
      <NodeSquare node={n} pos={{ x: 0, y: 0 }} lod={lod} focused={false}
        dragging={false} isDrop={false} seats={seats}
        map={new Map([[n.id, n]])} op={op} slug="org" toast={noop}
        pxc={1} zoom={lod === 'mini' ? 0.4 : 1} compactAt={0.8} pub={false}
        maxTop={0} kioskRemaining={null} cascadeAlloc mapMode={mapMode}
        onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
        onInbox={noop} onLineage={noop} onOpenDoc={noop}
        onRecenter={noop} onJump={noop} onMailLink={noop} onWorkLink={noop}
        onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
    </OrgDefaultEffort.Provider>,
    (el) => el)
}

const onCard = (el: HTMLElement) =>
  el.querySelector<HTMLElement>('.sq-badges .badge.effort-level')

test('§2a the zoomed-out card shows the configured level when it is non-default',
  async (t: TestContext) => {
    const view = await card(agent('xhigh', 'xhigh'), 'norm')
    t.after(() => view.unmount())
    await flush()
    const badge = onCard(view.el)
    assert.ok(badge, 'no effort card on the zoomed-out node')
    // the LEVEL is legible, and legible enough to tell the five apart
    assert.equal(badge!.getAttribute('data-effort-level'), 'xhigh')
    assert.match(badge!.textContent ?? '', /\bxhigh\b/)
    assert.match(badge!.textContent ?? '', /Effort/)
  })

test('§2b default and unset agents get NO card and NO empty placeholder',
  async (t: TestContext) => {
    for (const [label, n] of [
      ['pinned at the default', agent(ORG_DEFAULT, ORG_DEFAULT)],
      ['never configured', agent('', ORG_DEFAULT)],
    ] as const) {
      const view = await card(n, 'norm')
      await flush()
      assert.equal(onCard(view.el), null, `an effort card appeared (${label})`)
      // ⚠ "no placeholder" IS A SEPARATE ASSERTION from "no card". An empty
      // chip, or a chip whose text is blank, would satisfy the first and
      // break the requirement — so nothing bearing the class or the data
      // attribute may exist anywhere in the card at all.
      assert.equal(view.el.querySelector('.effort-level'), null,
        `an empty effort element was left behind (${label})`)
      assert.equal(view.el.querySelector('[data-effort-level]'), null,
        `an effort placeholder was left behind (${label})`)
      await view.unmount()
    }
  })

test('§2c it wears the compact header-card language of its neighbours',
  async (t: TestContext) => {
    // the ticket asks for the styling the MCP, cache, cost and account
    // indicators already use. On the card that vocabulary is `.badge` inside
    // `.sq-badges` — the row that sizes every chip in it to 9.5px — so the
    // assertion is that this card is one of them rather than a bespoke
    // element placed near them.
    const view = await card(agent('max', 'max'), 'norm')
    t.after(() => view.unmount())
    await flush()
    const badge = onCard(view.el)!
    assert.ok(badge.classList.contains('badge'),
      'the effort card is not a .badge and so does not share the chip styling')
    assert.equal(badge.closest('.sq-badges')?.tagName, 'DIV',
      'the effort card is not in the badge row')
    // a SIGN, not an action — a zoomed-out card is a thing you aim at to open
    // a desk, and a control here would swallow the press that focuses it
    assert.equal(badge.tagName, 'SPAN')

    // …and the stylesheet actually carries the rule, so the class is not
    // decorative. jsdom does not cascade the app's stylesheet, so the shipped
    // file is the only place this can be proven.
    const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
    assert.match(css, /^\.badge\.effort-level\b/m,
      'no .badge.effort-level rule in the shipped stylesheet')
  })

/* ─── §3 the desk header ─────────────────────────────────────────────────── */

function desk(n: CanvasNode, orgDefault = ORG_DEFAULT) {
  const superior: CanvasNode = {
    id: 'superior', state: 'live', tier: 'sonnet', model_id: 'sonnet',
    children: [n], seat: 2, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  } as unknown as CanvasNode
  return (
    <OrgDefaultEffort.Provider value={orgDefault}>
      <DeskChat node={n} map={new Map([[n.id, n], ['superior', superior]])}
        op={op} slug="org" toast={noop} pub={false} bare onJump={noop} />
    </OrgDefaultEffort.Provider>
  )
}

const onDesk = (el: HTMLElement) =>
  el.querySelector<HTMLElement>('.cc-head .badge.effort-level')

test('§3a the desk header shows the same non-default level',
  async (t: TestContext) => {
    installFetch(new FakeServer())
    const view = await mountView(desk(agent('xhigh', 'xhigh')), (el) => el)
    t.after(() => view.unmount())
    await flush()
    const badge = onDesk(view.el)
    assert.ok(badge, 'no effort card in the desk header')
    assert.equal(badge!.getAttribute('data-effort-level'), 'xhigh')
    assert.equal(badge!.closest('.cc-head-meta')?.tagName, 'DIV',
      'the effort card is not in the header metadata row beside MCP/cache/cost/account')
  })

test('§3b the desk shows no card and no placeholder at default or unset',
  async (t: TestContext) => {
    installFetch(new FakeServer())
    for (const [label, n] of [
      ['pinned at the default', agent(ORG_DEFAULT, ORG_DEFAULT)],
      ['never configured', agent('', ORG_DEFAULT)],
    ] as const) {
      const view = await mountView(desk(n), (el) => el)
      await flush()
      assert.equal(onDesk(view.el), null, `an effort card appeared (${label})`)
      assert.equal(view.el.querySelector('[data-effort-level]'), null,
        `an effort placeholder was left behind (${label})`)
      await view.unmount()
    }
  })

/* ─── §4 one source of truth, and it stays live ──────────────────────────── */

test('§4a both surfaces say the SAME thing about the same agent',
  async (t: TestContext) => {
    // the parity that matters is not "both show something" but "both show the
    // same level and the same detail", which is what a shared component buys.
    const n = agent('low', 'low')
    installFetch(new FakeServer())
    const c = await card(n, 'norm')
    t.after(() => c.unmount())
    const d = await mountView(desk(n), (el) => el)
    t.after(() => d.unmount())
    await flush()
    const onC = onCard(c.el)!, onD = onDesk(d.el)!
    assert.equal(onC.getAttribute('data-effort-level'), onD.getAttribute('data-effort-level'))
    assert.equal(onC.textContent, onD.textContent)
    assert.equal(onC.getAttribute('title'), onD.getAttribute('title'))
    // the detail names the level and stops. It used to also say which side of
    // the org default this was and what that default was; the user removed
    // that on 2026-09-21 ("no just the effort name no need for extra info"),
    // so this is an EXACT equality rather than a match — an assertion that
    // fails if anything at all creeps back into the detail.
    assert.equal(onD.getAttribute('title'), 'thinking effort — low')
  })

test('§4b changing the agent\'s effort changes BOTH surfaces, live',
  async (t: TestContext) => {
    // ⚠ THE ACCEPTANCE CONDITION ABOUT UPDATING. The org default is unchanged
    // throughout; only the agent moves — default → non-default → a different
    // non-default → back to default — and each surface must follow on the
    // SAME root rather than only being right when freshly mounted.
    installFetch(new FakeServer())
    const c = await card(agent(ORG_DEFAULT, ORG_DEFAULT), 'norm')
    t.after(() => c.unmount())
    const d = await mountView(desk(agent(ORG_DEFAULT, ORG_DEFAULT)), (el) => el)
    t.after(() => d.unmount())
    await flush()
    assert.equal(onCard(c.el), null, 'the card badged an agent at the default')
    assert.equal(onDesk(d.el), null, 'the desk badged an agent at the default')

    const bumped = agent('max', 'max')
    await c.render(
      <OrgDefaultEffort.Provider value={ORG_DEFAULT}>
        <NodeSquare node={bumped} pos={{ x: 0, y: 0 }} lod="norm" focused={false}
          dragging={false} isDrop={false} seats={seats}
          map={new Map([[bumped.id, bumped]])} op={op} slug="org" toast={noop}
          pxc={1} zoom={1} compactAt={0.8} pub={false}
          maxTop={0} kioskRemaining={null} cascadeAlloc
          onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
          onInbox={noop} onLineage={noop} onOpenDoc={noop}
          onRecenter={noop} onJump={noop} onMailLink={noop} onWorkLink={noop}
          onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
      </OrgDefaultEffort.Provider>)
    await d.render(desk(bumped))
    await flush()
    assert.equal(onCard(c.el)?.getAttribute('data-effort-level'), 'max',
      'the card kept describing the old effort')
    assert.equal(onDesk(d.el)?.getAttribute('data-effort-level'), 'max',
      'the desk kept describing the old effort')

    // …and back to the default: the card must GO, not linger describing a
    // configuration that no longer exists
    await d.render(desk(agent('', ORG_DEFAULT)))
    await flush()
    assert.equal(onDesk(d.el), null, 'the effort card outlived the setting it described')
    assert.equal(d.el.querySelector('[data-effort-level]'), null)
  })

test('§4c changing the INHERITED org default changes both surfaces too',
  async (t: TestContext) => {
    // the other half of the same fact, and the one a per-node feed would miss:
    // the agent is untouched at `high` throughout. While the org default is
    // high it is ordinary and silent; raise the org default to xhigh and the
    // very same agent is now BELOW the default and says so — on BOTH surfaces,
    // in the same render pass, because both read the one context. This is the
    // live-inherit behaviour the composer's effort control already has
    // (user ruling 2026-08-01), carried onto the headers.
    installFetch(new FakeServer())
    const n = agent('high', 'high')
    const d = await mountView(desk(n, 'high'), (el) => el)
    t.after(() => d.unmount())
    const c = await card(n, 'norm', 'high')
    t.after(() => c.unmount())
    await flush()
    assert.equal(onDesk(d.el), null, 'the desk badged an agent sitting at the org default')
    assert.equal(onCard(c.el), null, 'the card badged an agent sitting at the org default')

    await d.render(desk(n, 'xhigh'))
    await c.render(
      <OrgDefaultEffort.Provider value="xhigh">
        <NodeSquare node={n} pos={{ x: 0, y: 0 }} lod="norm" focused={false}
          dragging={false} isDrop={false} seats={seats}
          map={new Map([[n.id, n]])} op={op} slug="org" toast={noop}
          pxc={1} zoom={1} compactAt={0.8} pub={false}
          maxTop={0} kioskRemaining={null} cascadeAlloc
          onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
          onInbox={noop} onLineage={noop} onOpenDoc={noop}
          onRecenter={noop} onJump={noop} onMailLink={noop} onWorkLink={noop}
          onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
      </OrgDefaultEffort.Provider>)
    await flush()
    const onD = onDesk(d.el), onC = onCard(c.el)
    assert.ok(onD, 'the org default moved and the desk stayed silent about it')
    assert.ok(onC, 'the org default moved and the card stayed silent about it')
    assert.equal(onD!.getAttribute('data-effort-level'), 'high')
    assert.equal(onC!.getAttribute('data-effort-level'), 'high')
    assert.equal(onC!.getAttribute('title'), onD!.getAttribute('title'),
      'the two surfaces disagreed about the new default')
    // The PROOF that both surfaces followed the org default to its new value
    // is that they now render at all and name `high` (asserted just above) —
    // this agent was silent while the default was still high. The detail no
    // longer names the default, so it is not the carrier of that evidence.
    assert.equal(onD!.getAttribute('title'), 'thinking effort — high')
  })

test('§4d an unsupported ORG override blanks NEITHER surface — the regression, '
  + 'rendered', async (t: TestContext) => {
    // ⚠ THE BEHAVIOURAL FORM OF §1x, through the real components rather than
    // the rule alone. In candidate 0dbede2 both of these rendered nothing at
    // all: the provider's `||` discarded `effort_default`, so the context
    // carried an unsupported value and every card in the org disappeared.
    // Here the org's own field is junk and only `effort_default` names the
    // real ordinary default (high), and a validly configured xhigh agent must
    // still be described — on the card AND in the desk header.
    const orgDefault = resolveOrgDefault('ludicrous', 'high')
    installFetch(new FakeServer())
    const n = agent('xhigh', 'xhigh')
    const c = await card(n, 'norm', orgDefault)
    t.after(() => c.unmount())
    const d = await mountView(desk(n, orgDefault), (el) => el)
    t.after(() => d.unmount())
    await flush()
    const onC = onCard(c.el), onD = onDesk(d.el)
    assert.ok(onC, 'the canvas card went blank under a junk org override')
    assert.ok(onD, 'the desk header went blank under a junk org override')
    assert.equal(onC!.getAttribute('data-effort-level'), 'xhigh')
    assert.equal(onD!.getAttribute('data-effort-level'), 'xhigh')
    // Both measure against the RESOLVED default — which is what the f4
    // regression was about — and the evidence for that is that they RENDER
    // here at all: an unresolved '' default makes nonDefaultEffort return null
    // and both surfaces go silent, which is exactly what 0dbede2 did. The
    // detail itself names only the level (user ruling 2026-09-21).
    assert.equal(onC!.getAttribute('title'), onD!.getAttribute('title'))
    assert.equal(onD!.getAttribute('title'), 'thinking effort — xhigh')
  })

test('§4e …and an agent AT the resolved default is still silent on both',
  async (t: TestContext) => {
    // the control for §4d: falling through to the fallback must not turn into
    // "badge everything". The same junk override, an agent sitting at the real
    // ordinary default, and both surfaces say nothing.
    const orgDefault = resolveOrgDefault('ludicrous', 'high')
    installFetch(new FakeServer())
    const n = agent('high', 'high')
    const c = await card(n, 'norm', orgDefault)
    t.after(() => c.unmount())
    const d = await mountView(desk(n, orgDefault), (el) => el)
    t.after(() => d.unmount())
    await flush()
    assert.equal(onCard(c.el), null, 'the card badged an agent at the real default')
    assert.equal(onDesk(d.el), null, 'the desk badged an agent at the real default')
    assert.equal(c.el.querySelector('[data-effort-level]'), null)
    assert.equal(d.el.querySelector('[data-effort-level]'), null)
  })

test('§4f the provider RESOLVES rather than falling back with ||', () => {
  // ⚠ A SOURCE GUARD, and it earns its keep: the defect lived in OrgCanvas.tsx
  // — a file this ticket may only touch for the import and the provider — and
  // it was invisible to every component test, because those mount the context
  // directly and never exercise the expression that fills it. jsdom cannot
  // reach it either, so the shipped source is the only place it can be pinned.
  const src = readFileSync(
    path.join(__SRC_DIR__, 'canvas', 'OrgCanvas.tsx'), 'utf8')
  assert.match(src,
    /value=\{resolveOrgDefault\(tree\.default_effort,\s*tree\.effort_default\)\}/,
    'the org-default provider no longer calls resolveOrgDefault with both fields')
  assert.doesNotMatch(src, /OrgDefaultEffort\.Provider[\s\S]{0,120}\|\|/,
    'a || fallback chain crept back into the org-default provider')
})

/* ─── §5 the far-scale presentations ─────────────────────────────────────── */

test('§5a far zoom renders no effort card', async (t: TestContext) => {
  // a separate standing user rule this additive card must not erode: at far
  // zoom the node is a model token and one enlarged state icon, and there is
  // no badge row at all. Asserted here rather than left to the `lod !== 'mini'`
  // gate happening to stay where it is.
  const view = await card(agent('xhigh', 'xhigh'), 'mini')
  t.after(() => view.unmount())
  await flush()
  assert.equal(view.el.querySelector('[data-effort-level]'), null,
    'the effort card leaked into far zoom')
  assert.equal(view.el.querySelector('.sq-badges'), null,
    'the badge row reappeared at far zoom')
})

test('§5b the compact map locator renders no effort card', async (t: TestContext) => {
  const view = await card(agent('xhigh', 'xhigh'), 'norm', ORG_DEFAULT, true)
  t.after(() => view.unmount())
  await flush()
  assert.equal(view.el.querySelector('[data-effort-level]'), null,
    'the effort card leaked into the compact map locator')
})

test('§5c the same fixture DOES badge at norm — so §5a/§5b prove exclusion',
  async (t: TestContext) => {
    // without this control the two above would pass on a fixture that renders
    // no card at any zoom, which is how an exclusion test proves nothing
    const view = await card(agent('xhigh', 'xhigh'), 'norm')
    t.after(() => view.unmount())
    await flush()
    assert.ok(onCard(view.el), 'the shared fixture renders no card at ANY zoom')
  })

/* ─── the component in isolation ─────────────────────────────────────────── */

test('the badge renders nothing at all — not an empty span — when silent',
  async (t: TestContext) => {
    const view = await mountView(
      <OrgDefaultEffort.Provider value={ORG_DEFAULT}>
        <EffortLevelBadge node={agent('', ORG_DEFAULT)} />
      </OrgDefaultEffort.Provider>, (el) => el)
    t.after(() => view.unmount())
    await flush()
    assert.equal(view.el.innerHTML, '', 'the silent badge still emitted markup')
  })

test('THE NAME AND NOTHING ELSE: no direction cue, either side of the default',
  async (t: TestContext) => {
    // ⚠ THIS TEST USED TO ASSERT THE OPPOSITE. The first landed candidate
    // carried the DIRECTION as well as the level — an `above`/`below` class
    // colouring the chip, and "(above the org default, medium)" in the detail
    // — reasoning from the ticket's problem statement, "difficult to tell when
    // an agent is running above or below the default". The user ruled it out
    // directly on the item (2026-09-21): "no just the effort name no need for
    // extra info". So the assertion is inverted rather than deleted: the cue's
    // ABSENCE is now the requirement, and a well-meaning future reader who
    // re-derives the old reasoning from the problem statement fails here.
    //
    // `max` is above ORG_DEFAULT and `low` is below it, so if any direction
    // signal existed in the class list, the text, or the detail, these two
    // would differ in it. They must differ ONLY in the level they name.
    const hi = await mountView(
      <OrgDefaultEffort.Provider value={ORG_DEFAULT}>
        <EffortLevelBadge node={agent('max', 'max')} />
      </OrgDefaultEffort.Provider>, (el) => el)
    t.after(() => hi.unmount())
    const lo = await mountView(
      <OrgDefaultEffort.Provider value={ORG_DEFAULT}>
        <EffortLevelBadge node={agent('low', 'low')} />
      </OrgDefaultEffort.Provider>, (el) => el)
    t.after(() => lo.unmount())
    await flush()
    const above = hi.el.querySelector('.badge.effort-level')!
    const below = lo.el.querySelector('.badge.effort-level')!
    assert.ok(above, 'the above-default agent lost its card entirely')
    assert.ok(below, 'the below-default agent lost its card entirely')
    // identical class lists: no `.above`, no `.below`, and no replacement
    assert.equal(above.className, below.className)
    assert.equal(above.className, 'badge effort-level')
    // the visible text and the detail name the level and stop. In particular
    // the detail no longer names the org default — the card reports what this
    // agent is, not what it is measured against.
    assert.equal(above.textContent, 'Effort max')
    assert.equal(below.textContent, 'Effort low')
    assert.equal(above.getAttribute('title'), 'thinking effort — max')
    assert.equal(below.getAttribute('title'), 'thinking effort — low')
    assert.equal(above.getAttribute('aria-label'), 'thinking effort — max')
    assert.equal(below.getAttribute('aria-label'), 'thinking effort — low')
    for (const el of [above, below]) {
      const all = el.outerHTML
      for (const word of ['above', 'below', ORG_DEFAULT]) {
        assert.equal(all.includes(word), false,
          `the card still leaks "${word}" somewhere in its markup`)
      }
    }
  })
