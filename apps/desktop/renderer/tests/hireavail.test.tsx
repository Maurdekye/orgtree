// D-199 — a hire surface offers only the harnesses this machine has.
//
// The user's report (2026-08-30): "if a user has codex cli set up but *not*
// claude code, will they only see codex hire tokens? ... i want them to only
// see the hire buttons for the agent harnesses they actually have set up."
// They saw both: Claude's `hire_enabled` was hard-coded true and no hire
// surface ever consulted it, so four live Claude buttons rendered on a machine
// with no Claude.
//
// THE RULE (`familyOffer`, shared.ts): not installed HIDES, installed-but-
// signed-out DISABLES with its reason, and an UNKNOWN payload OFFERS — both
// of the restrictive answers need positive knowledge, and the server gate is
// what makes offering safe. One rule, every surface — the surfaces below used
// to disagree with each other, which is why each is asserted separately rather
// than one standing in for the rest.

import { installFetch, FakeServer, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { codexTierOffer, familyOffer, LEGACY_CODEX_TIERS } from '../src/canvas/shared'
import type { HireState } from '../src/canvas/shared'

const noop = () => {}

// ------------------------------------------------------------- §1 the rule
// The whole feature funnels through this one function, so it is worth pinning
// directly: every surface below is that rule plus markup.

test('familyOffer: not installed HIDES', () => {
  assert.equal(familyOffer(
    { enabled: false, installed: false, reason: 'not installed' }), 'hide')
})

test('familyOffer: installed but signed out DISABLES', () => {
  assert.equal(familyOffer(
    { enabled: false, installed: true, reason: 'not signed in' }), 'disable')
})

test('familyOffer: enabled OFFERS', () => {
  assert.equal(familyOffer(
    { enabled: true, installed: true, reason: null }), 'offer')
})

test('familyOffer: UNKNOWN offers — it never hides, and never disables', () => {
  // hiding and disabling both need POSITIVE knowledge. getProviders swallows
  // its own failure, so an unresolved payload is null FOREVER — "disable"
  // there is not a flicker, it is a permanently dead hire strip. The server
  // gate is what makes offering safe: an unavailable click is refused at the
  // door with the same reason the chip would have shown.
  assert.equal(familyOffer(null), 'offer')
  assert.equal(familyOffer(undefined), 'offer')
})

test('familyOffer: hiding is reserved for a POSITIVELY absent CLI', () => {
  // the anti-vacuity leg. If this returned 'hide' for everything unavailable,
  // every §2/§3 "is hidden" assertion below would still pass while the
  // signed-out case silently lost its remedy.
  const signedOut: HireState =
    { enabled: false, installed: true, reason: 'run `codex login`' }
  assert.notEqual(familyOffer(signedOut), 'hide')
})

// gpt-reserve is a LEGACY token (user ruling 2026-09-04, item 12): reserve is
// the pool a `luna` hire spends first, not a tier to pick. `codexTierOffer`
// answers 'hide' for it under EVERY provider state — offered, signed out,
// absent, no payload — so no hire surface can render it, greyed or lit.

test('a legacy token is hidden whatever the Codex family is doing', () => {
  assert.ok(LEGACY_CODEX_TIERS.includes('gpt-reserve'), 'the legacy set names it')
  const states: (HireState | null)[] = [
    null,
    { enabled: true, installed: true, reason: null },
    { enabled: true, installed: true, reason: null, offeredTiers: ['gpt-reserve', 'luna'] },
    { enabled: false, installed: true, reason: 'not signed in' },
    { enabled: false, installed: false, reason: 'not installed' },
  ]
  for (const h of states) {
    assert.equal(codexTierOffer(h, 'gpt-reserve'), 'hide', JSON.stringify(h))
  }
})

test('…and never takes luna with it — the leg that must hold', () => {
  assert.equal(codexTierOffer({ enabled: true, installed: true, reason: null }, 'luna'), 'offer')
  assert.equal(codexTierOffer({ enabled: false, installed: true, reason: 'x' }, 'luna'), 'disable')
  assert.equal(codexTierOffer(null, 'luna'), 'offer')
})

// --------------------------------------------------------- §2 the surfaces

test('conditional Codex tiers fail closed while stable tiers keep compatibility', () => {
  assert.equal(codexTierOffer(null, 'astra'), 'hide',
    'an unresolved provider payload must never light a rollout tier')
  assert.equal(codexTierOffer(null, 'sol'), 'offer',
    'the established family keeps its older-backend compatibility behavior')
  assert.equal(codexTierOffer(
    { enabled: true, installed: true, reason: null, offeredTiers: ['sol'] },
    'astra'), 'hide')
  assert.equal(codexTierOffer(
    { enabled: true, installed: true, reason: null, offeredTiers: ['astra'] },
    'astra'), 'offer')
})

const state = (o: Partial<HireState>): HireState =>
  ({ enabled: false, installed: false, reason: null, ...o })

const ON = state({ enabled: true, installed: true })
const SIGNED_OUT = state({ installed: true, reason: 'not signed in — run x' })
const ABSENT = state({ reason: 'not installed — npm i -g y' })

const CLAUDE = ['haiku', 'sonnet', 'opus', 'fable']
const CODEX = ['luna', 'terra', 'sol']
const ASTRA = 'astra'
const ANTIGRAVITY = ['flash', 'pro']

/** every hire token rendered, keyed by tier, with its disabled state */
function tokens(el: HTMLElement, sel: string): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const b of el.querySelectorAll<HTMLButtonElement>(`${sel} button`)) {
    const t = [...CLAUDE, ...CODEX, ASTRA, ...ANTIGRAVITY]
      .find((x) => b.className.split(/\s+/).includes('t-' + x))
    if (t) out[t] = b.disabled
  }
  return out
}

type Hires = { claudeHire: HireState; codexHire: HireState
               antigravityHire: HireState }

function surfaceTest(name: string,
                     body: (mount: (h: Hires) => Promise<HTMLElement>)
                       => Promise<void>): void {
  test(name, async (t: TestContext) => {
    installFetch(new FakeServer())
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => { for (const v of open) await v.unmount() })
    await body(async (h) => {
      const { NodeSquare } = await import('../src/canvas/cards')
      const node = {
        id: 'agent', title: 'agent', state: 'live', tier: 'haiku',
        model_id: 'haiku', parent: '@user', children: [], seat: 1, grant: 5,
        free: 5, scope: { permission_mode: 'acceptEdits', add_dirs: [],
          tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
          org_visibility: 'team' },
        charter: '', team_charter: '', turns: [], audiences_held: [],
        lineage: [],
      } as unknown as Parameters<typeof NodeSquare>[0]['node']
      const v = await mountView(
        <NodeSquare node={node} pos={{ x: 0, y: 0 }} lod="norm" focused={false}
          dragging={false} isDrop={false}
          seats={{ haiku: 1, sonnet: 2, opus: 5, fable: 10,
                   'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, astra: 10,
                   flash: 1, pro: 2 }}
          map={new Map()} op={() => Promise.resolve({} as never)} slug="org"
          toast={noop} pxc={1} zoom={1}
          onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop}
          onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop}
          onRecenter={noop} onJump={noop} pub={false} cascadeAlloc
          maxTop={100} onMailLink={noop} kioskRemaining={null}
          onDragStart={noop} onDragMove={noop} onDragEnd={noop}
          onDragCancel={noop}
          claudeHire={h.claudeHire} codexHire={h.codexHire}
          antigravityHire={h.antigravityHire} onNoHarness={noop} />,
        (el) => el,
      )
      open.push(v)
      return v.el
    })
  })
}

surfaceTest('THE REPORT: codex set up, claude not — only codex tokens appear',
  async (mount) => {
    const el = await mount({ claudeHire: ABSENT, codexHire: ON,
                             antigravityHire: ABSENT })
    const got = tokens(el, '.hsof')
    for (const t of CLAUDE) {
      assert.equal(got[t], undefined,
        `${t} must not render: Claude Code is not installed here`)
    }
    for (const t of ANTIGRAVITY) assert.equal(got[t], undefined)
    for (const t of CODEX) {
      assert.equal(got[t], false, `${t} is set up and must be offered`)
    }
  })

surfaceTest('Astra token stays absent until the provider payload offers it',
  async (mount) => {
    const dark = await mount({ claudeHire: ABSENT,
      codexHire: state({ enabled: true, installed: true,
        offeredTiers: [...CODEX] }), antigravityHire: ABSENT })
    assert.equal(tokens(dark, '.hsof')[ASTRA], undefined)

    const lit = await mount({ claudeHire: ABSENT,
      codexHire: state({ enabled: true, installed: true,
        offeredTiers: [...CODEX, ASTRA] }), antigravityHire: ABSENT })
    // Enough Codex tiers can trigger the far-zoom compact tray; open it
    // (when it rendered) before checking the actual token rather than
    // mistaking the tray for a missing offer. With the legacy reserve
    // token gone (item 12) four Codex tiers may fit without a tray.
    const { act } = await import('react')
    const expand = lit.querySelector<HTMLButtonElement>('.hsof:not(.side) .hire-expand')
    if (expand) await act(async () => expand.click())
    assert.equal(tokens(lit, '.hsof:not(.side)')[ASTRA], false)
  })

surfaceTest('gpt-reserve is REMOVED from the chips whatever the family says '
  + '(legacy token, item 12) — its siblings keep hiring', async (mount) => {
  // User ruling 2026-09-02: "dont just grey out the reserve token. remove it
  // entirely." Item 12 (2026-09-04) went further: it is not a tier at all.
  // A luna hire spends reserve first by itself. The chip never renders.
  const el = await mount({
    claudeHire: ABSENT, antigravityHire: ABSENT,
    codexHire: state({ enabled: true, installed: true,
                       offeredTiers: ['gpt-reserve', 'luna', 'terra', 'sol'] }),
  })
  const got = tokens(el, '.hsof')
  assert.equal(got['gpt-reserve'], undefined,
    'the reserve token must not render at all — not even disabled')
  assert.equal(
    [...el.querySelectorAll<HTMLButtonElement>('.hsof button')]
      .filter((b) => b.className.split(/\s+/).includes('t-gpt-reserve')).length,
    0, 'no element may carry the reserve chip class either')
  // THE LEG THAT MUST HOLD: removing the tier must not take the row with it
  for (const t of ['luna', 'terra', 'sol']) {
    assert.equal(got[t], false, `${t} bills per-token and must stay offered`)
  }
})

surfaceTest('…but a Codex family that is itself unavailable still shows its '
  + 'three live tiers, disabled — the ruling removes a token, not a harness',
  async (mount) => {
    const el = await mount({
      claudeHire: ABSENT, antigravityHire: ABSENT,
      codexHire: state({ installed: true, reason: 'not signed in — run x' }),
    })
    const got = tokens(el, '.hsof')
    for (const t of CODEX) {
      assert.equal(got[t], true, `${t} stays visible-but-disabled here`)
    }
    assert.equal(got['gpt-reserve'], undefined, 'the legacy token is absent here too')
  })

surfaceTest('the mirror: claude set up, codex not', async (mount) => {
  const el = await mount({ claudeHire: ON, codexHire: ABSENT,
                           antigravityHire: ABSENT })
  const got = tokens(el, '.hsof')
  for (const t of CLAUDE) assert.equal(got[t], false)
  for (const t of [...CODEX, ...ANTIGRAVITY]) assert.equal(got[t], undefined)
})

surfaceTest('installed but SIGNED OUT stays visible, disabled, with its reason',
  async (mount) => {
    const el = await mount({ claudeHire: ON, codexHire: SIGNED_OUT,
                             antigravityHire: ABSENT })
    const got = tokens(el, '.hsof')
    for (const t of CODEX) {
      assert.equal(got[t], true, `${t} is installed — show it, disabled`)
    }
    const btn = [...el.querySelectorAll<HTMLButtonElement>('.hsof button')]
      .find((b) => b.className.split(/\s+/).includes('t-sol'))!
    assert.match(btn.title, /not signed in/,
      'a disabled family must carry the remedy, not just be dimmed')
    for (const t of ANTIGRAVITY) assert.equal(got[t], undefined)
  })

surfaceTest('EVERY STRIP AGREES — the divergence that shipped', async (mount) => {
  // codex/antigravity used to be a disabled preview on the subordinate strip and
  // HIDDEN on the side/top strips, so one provider was visible on one edge of
  // a card and absent from another. All four strips render here.
  const el = await mount({ claudeHire: ON, codexHire: SIGNED_OUT,
                           antigravityHire: ABSENT })
  const strips = [...el.querySelectorAll<HTMLElement>('.hsof')]
  assert.ok(strips.length >= 2, `expected several strips, saw ${strips.length}`)
  // each strip's own token map, computed from that strip alone
  const perStrip = strips.map((s) => {
    const out: Record<string, boolean> = {}
    for (const b of s.querySelectorAll<HTMLButtonElement>('button')) {
      const t = [...CLAUDE, ...CODEX, ...ANTIGRAVITY]
        .find((x) => b.className.split(/\s+/).includes('t-' + x))
      if (t) out[t] = b.disabled
    }
    return out
  })
  for (const got of perStrip) {
    for (const t of CODEX) {
      assert.equal(got[t], true, 'codex is signed out — disabled on EVERY strip')
    }
    for (const t of ANTIGRAVITY) {
      assert.equal(got[t], undefined, 'antigravity is absent — hidden on EVERY strip')
    }
  }
})

surfaceTest('NO HARNESS AT ALL says so, and is not an empty strip',
  async (mount) => {
    // the state a brand-new user on a fresh machine hits first
    const el = await mount({ claudeHire: ABSENT, codexHire: ABSENT,
                             antigravityHire: ABSENT })
    assert.deepEqual(tokens(el, '.hsof'), {}, 'no tier token may render')
    const none = el.querySelector<HTMLButtonElement>('.hsof button.hs-none')
    assert.ok(none, 'an empty strip is indistinguishable from a broken one')
    assert.match(none.textContent ?? '', /no harness/)
    assert.match(none.title, /install or sign in/)
    assert.equal(none.disabled, false, 'it routes to the accounts panel')
  })

surfaceTest('while the payload is UNKNOWN the strip behaves as it always did',
  async (mount) => {
    // the regression guard for the cautious-looking wrong answer: a payload
    // that never resolves must not leave the user unable to hire anything
    const el = await mount({ claudeHire: null as unknown as HireState,
                             codexHire: null as unknown as HireState,
                             antigravityHire: null as unknown as HireState })
    const got = tokens(el, '.hsof')
    for (const t of [...CLAUDE, ...CODEX, ...ANTIGRAVITY]) {
      assert.equal(got[t], false, `${t} must stay hireable while unknown`)
    }
    assert.equal(el.querySelector('.hsof button.hs-none'), null,
      'unknown is not the no-harness state')
  })
