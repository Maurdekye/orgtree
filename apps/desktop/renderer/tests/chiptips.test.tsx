// chiptips.test.tsx — the three hire-badge tooltips, as a FAMILY.
//
// User request 2026-08-28: "update the badge tooltip texts to all bear a
// similar resemblance to one another, and make them more concise; just 3-5
// words at most per tooltip", scoped moments later to "for subordinate,
// superior, and coworker".
//
// The deliverable is consistency, so consistency is what these check — not
// three separate spellings. Asserting the exact strings would pin today's
// wording and say nothing about whether the three still match each other; the
// next person to reword one would sail past a green suite having broken the
// only property the user actually asked for. So the checks are relational:
// same length, same shape, differing in exactly one word.
//
// Read out of the rendered DOM rather than out of cards.tsx, because a
// source-text check pins a spelling rather than behaviour — it cannot tell a
// tooltip that changed from one that moved, and this repo has already been
// bitten by a guard that matched a string instead of a state.
//
// Run:  cd frontend && node tests/run.mjs chiptips

import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { TreePayload } from '../src/types'

const noop = () => {}
const asTree = (v: unknown) => v as TreePayload

function tree(nodeIds: string[]): TreePayload {
  const mk = (id: string) => ({
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  })
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    // the payload's tier table IS the backend's — the server seeds it from
    // ledger.TIERS, so a fixture inventing its own prices tests a UI wired to
    // an org that cannot exist
    tiers: SEATS, audiences: [],
    roots: nodeIds.map(mk), cost_usd_total: 0,
    audit: { live_nodes: nodeIds.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

function uiTest(name: string,
  body: (k: { mount: (el: React.ReactElement)
    => Promise<{ el: HTMLElement }> }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      realClock()
    })
    await body({
      mount: async (el) => {
        const v = await mountView(el, (host) => host)
        open.push(v)
        return { el: v.el }
      },
    })
  })
}

/** The tier seat costs, READ OUT OF THE BACKEND that charges them.
 *
 *  ⚠ This was a constant copied into the test, and it was WRONG: it said
 *  sonnet 3, the value retired by a user ruling on 2026-08-12 when sonnet
 *  dropped to 2. Nothing caught it, because the fixture supplied that number
 *  AND the assertion expected it — a closed loop that agrees with itself and
 *  with nothing else. It cost a false report of `hire a sonnet (-3)`, a price
 *  the product has never charged.
 *
 *  So the number now comes from `ledger.TIERS`, the table the backend seeds
 *  into every org doc and that `seat_cost()` reads when it actually charges a
 *  hire. If that table moves, this test moves with it or fails loudly; it can
 *  no longer quietly agree with a stale copy of itself. */
declare const __SRC_DIR__: string
const LEDGER = path.join(__SRC_DIR__, '..', '..', 'backend', 'orgtree', 'ledger.py')

function backendSeats(): Record<string, number> {
  const src = readFileSync(LEDGER, 'utf8')
  // `int` OR `float`: seats went fractional below $1/M on 2026-09-03 (the
  // static tiers in this table all stayed whole, but the annotation widened
  // so the dynamic OpenRouter half can join it). The VALUE pattern accepts a
  // decimal for the same reason — a favorite at $0.20 seats at 0.2.
  const m = /^TIERS:\s*Final\[dict\[str,\s*(?:int|float)\]\]\s*=\s*\{([^}]*)\}/m.exec(src)
  assert.ok(m, `could not read TIERS out of ${LEDGER} — this test must not `
    + 'fall back to a guess, because a guess is the bug it exists to prevent')
  const out: Record<string, number> = {}
  for (const [, k, v] of m![1]!.matchAll(/["']?([\w-]+)["']?\s*:\s*(\d+(?:\.\d+)?)/g)) {
    out[k!] = Number(v)
  }
  assert.ok(Object.keys(out).length >= 3,
    `parsed only ${JSON.stringify(out)} from the backend TIERS table`)
  return out
}
const SEATS = backendSeats()

/** the enabled tooltip for one tier, off each of the three badge sets.
 *  Costs here are affordable on this fixture, so none of these is the
 *  can't-afford variant — that string is deliberately long (it carries the
 *  remedy) and is not one of the three the user scoped. */
async function tips(mount: (el: React.ReactElement) => Promise<{ el: HTMLElement }>,
  tier = 'haiku') {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const { el } = await mount(
    <OrgCanvas tree={tree(['ceo', 'cto'])} op={() => Promise.resolve({} as never)}
      slug="mine" toast={noop} mailEvt={null} />)
  await flush()
  // ⚠ `.sq:not(.user)` is load-bearing. The eye's own hire badges are also
  // `.hsof:not(.side)` — it has no side or top sets — and the eye renders
  // FIRST, so a bare selector silently returned the OVERSEER's tooltip as if
  // it were an agent's. That was harmless only while the two strings were
  // identical; the moment the eye dropped its role word it started comparing
  // the overseer against itself. The ambiguity was always there — the change
  // merely exposed it, which is why this is scoped rather than reordered.
  const pick = (sel: string) => {
    const b = el.querySelector(
      `.sq:not(.user) ${sel} button.t-${tier}`) as HTMLElement | null
    assert.ok(b, `no ${tier} badge rendered on an agent card for ${sel}`)
    const t = b!.getAttribute('title')
    assert.ok(t, `the ${sel} badge carries no tooltip at all`)
    return t!
  }
  return {
    subordinate: pick('.hsof:not(.side)'),
    coworker: pick('.hsof.side-l'),
    superior: pick('.hsof.side-t'),
  }
}

/** split a tooltip into its PHRASE and its COST SUFFIX.
 *
 *  The user set a 3-5 word ceiling and then, asked directly, added a cost
 *  badge in their own notation — `hire a haiku coworker (-1)`. So the suffix
 *  rides along and is deliberately NOT counted as a word; the phrase carries
 *  the ceiling, the suffix carries the price. Splitting them here keeps that
 *  distinction explicit instead of letting a looser word-count quietly absorb
 *  it, which is how "3-5 words" would rot into "about five-ish words". */
function parts(s: string): { phrase: string; cost: number | null } {
  // `-[\d.]+`: a seat may be fractional below $1/M (2026-09-03). An
  // integer-only pattern does not merely mis-parse "(-0.2)" — it fails to
  // match at all and reports `cost: null`, which reads as "no cost badge"
  const m = /^(.*?)\s*\((-[\d.]+)\)$/.exec(s.trim())
  if (!m) return { phrase: s.trim(), cost: null }
  return { phrase: m[1]!, cost: Number(m[2]) }
}

const words = (s: string) => s.trim().split(/\s+/)

uiTest('§1 every badge tooltip is within the user’s 3-5 word ceiling',
  async ({ mount }) => {
    const t = await tips(mount)
    for (const [role, s] of Object.entries(t)) {
      const n = words(parts(s).phrase).length
      assert.ok(n >= 3 && n <= 5,
        `the ${role} tooltip's phrase is ${n} words ("${s}") — the user set a `
        + 'hard ceiling of 3-5 words, not a target to approach. The (-N) cost '
        + 'suffix is exempt by their own later instruction; the WORDS are not, '
        + 'and must not creep to make room for it')
    }
  })

uiTest('§2 the three read as one family — same shape, one word apart',
  async ({ mount }) => {
    const t = await tips(mount)
    const [a, b, c] = [words(parts(t.subordinate).phrase),
      words(parts(t.coworker).phrase), words(parts(t.superior).phrase)]

    assert.equal(a.length, b.length,
      `subordinate ("${t.subordinate}") and coworker ("${t.coworker}") are `
      + 'different lengths — they do the same kind of thing and should read alike')
    assert.equal(a.length, c.length,
      `subordinate ("${t.subordinate}") and superior ("${t.superior}") are `
      + 'different lengths')

    // exactly ONE position may differ across the three, and it must be the one
    // carrying the role — that is the only thing that differs in meaning
    const differing = a.map((_, i) =>
      (a[i] === b[i] && a[i] === c[i]) ? null : i).filter((i) => i !== null)
    assert.deepEqual(differing, [a.length - 1],
      `the three tooltips differ at word position(s) ${JSON.stringify(differing)} `
      + `— they must differ in exactly one word, the role.\n`
      + `  subordinate: "${t.subordinate}"\n  coworker:    "${t.coworker}"\n`
      + `  superior:    "${t.superior}"`)

    assert.deepEqual(
      [a[a.length - 1], b[b.length - 1], c[c.length - 1]],
      ['subordinate', 'coworker', 'superior'],
      'the differing word must actually name the role being hired')

    // ...and the cost suffix is part of the family too: three badges hiring
    // the SAME tier cost the same, so all three suffixes must agree. Checked
    // here rather than folded into the word comparison, because the suffix
    // varies across tiers where the phrase does not — that is exactly the
    // distinction that would have been lost by relaxing the word check.
    const costs = [parts(t.subordinate).cost, parts(t.coworker).cost,
      parts(t.superior).cost]
    assert.ok(costs.every((c2) => c2 !== null),
      `every tooltip must carry the cost badge — got `
      + `${JSON.stringify([t.subordinate, t.coworker, t.superior])}`)
    assert.equal(new Set(costs).size, 1,
      `the three badges hire the same tier and must quote the same cost, got `
      + `${JSON.stringify(costs)}`)
  })

uiTest('§3 one voice — imperative, verb first, matching the card’s other controls',
  async ({ mount }) => {
    const t = await tips(mount)
    for (const [role, s] of Object.entries(t)) {
      assert.equal(words(s)[0], 'hire',
        `the ${role} tooltip opens with "${words(s)[0]}" ("${s}") — every badge `
        + 'here performs a hire, and mixing "insert"/"hire" is what made the '
        + 'old set read as three unrelated strings')
      assert.doesNotMatch(s, /[A-Z]/,
        `the ${role} tooltip shouts ("${s}") — the card's other control `
        + 'tooltips are lowercase ("retire — …", "dissolve — …")')
      // the cost is a MINUS BADGE in the user's own notation — `(-1)`, which
      // reads as what it costs you. Not `(seat 1)`, which read as a label, and
      // not a tidied `· -1` or a typographic minus: they wrote the example.
      assert.doesNotMatch(s, /\(seat/,
        `the ${role} tooltip uses the old "(seat N)" label ("${s}") — the user `
        + 'asked for a minus badge, "(-1)", which reads as a price')
      assert.match(s, /\s\(-\d+\)$/,
        `the ${role} tooltip does not end in a "(-N)" cost badge ("${s}")`)
    }
  })

uiTest('§4 the article still agrees with the tier it names',
  async ({ mount }) => {
    // `an opus`, not `a opus` — the trim must not have dropped the a/an test
    const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
    const { el } = await mount(
      <OrgCanvas tree={tree(['ceo'])} op={() => Promise.resolve({} as never)}
        slug="mine" toast={noop} mailEvt={null} />)
    await flush()
    const got: Record<string, string> = {}
    for (const b of [...el.querySelectorAll('.hsof.side-l button')] as HTMLElement[]) {
      const t = b.getAttribute('title') ?? ''
      const m = /^hire (an?) (\w+)/.exec(t)
      if (m) got[m[2]!] = m[1]!
    }
    assert.ok(Object.keys(got).length >= 2,
      `expected several tier badges, saw ${JSON.stringify(got)}`)
    for (const [tier, art] of Object.entries(got)) {
      assert.equal(art, /^[aeiou]/.test(tier) ? 'an' : 'a',
        `"${art} ${tier}" — the article does not agree with the tier name`)
    }
  })

// ===================================================================== §5
// The cost badge must quote each tier's REAL price, not a plausible one.
//
// This is the leg that the old word-count check could never have carried, and
// the reason the family invariant had to get harder rather than looser when
// the suffix arrived: within one tier the three tooltips are identical bar the
// role, but ACROSS tiers the suffix is the thing that must vary. A badge that
// said `(-1)` on every tier would satisfy every other check in this file and
// would be lying about the price of an opus.

uiTest('§5 the cost badge is the tier’s actual seat price, per tier',
  async ({ mount }) => {
    const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
    const { el } = await mount(
      <OrgCanvas tree={tree(['ceo'])} op={() => Promise.resolve({} as never)}
        slug="mine" toast={noop} mailEvt={null} />)
    await flush()
    const seen: Record<string, number> = {}
    for (const b of [...el.querySelectorAll('.hsof.side-l button')] as HTMLElement[]) {
      const title = b.getAttribute('title') ?? ''
      const tier = /^hire an? ([\w-]+)/.exec(title)?.[1]
      if (!tier) continue
      const { cost } = parts(title)
      assert.ok(cost !== null,
        `the ${tier} badge carries no cost badge ("${title}")`)
      seen[tier] = cost!
    }
    assert.ok(Object.keys(seen).length >= 3,
      `expected a badge per tier, saw ${JSON.stringify(seen)}`)
    for (const [tier, cost] of Object.entries(seen)) {
      const want = SEATS[tier]
      assert.ok(want !== undefined,
        `the fixture declares no seat cost for "${tier}" — this check cannot `
        + 'say whether the badge is right, so it must not pretend to')
      assert.equal(cost, -want,
        `the ${tier} badge quotes ${cost} but a ${tier} seat costs ${want} — `
        + 'the badge must be a real price, negated, not a decoration')
    }
    // and the prices really do differ, or this section proves nothing
    assert.ok(new Set(Object.values(seen)).size > 1,
      `every tier quoted the same cost ${JSON.stringify(seen)} — either the `
      + 'fixture stopped varying seat costs or the badge is not reading them')
  })

// ===================================================================== §6
// THE SECOND FAMILY: the overseer's lone badge.
//
// User 2026-08-28: "under the overseer badge, where only the subordinate hire
// badges appear, make the text just say 'hire a haiku (-1)', with no
// subordinate / coworker / superior language". The role word separates three
// badges sitting side by side; the eye carries only the bottom set, so there
// is no choice to get wrong and the word is noise.
//
// So there are now two families, and the cost rule is shared rather than
// duplicated — that is the invariant a "just drop some words" edit is most
// likely to break, and dropping the role word is exactly such an edit.

uiTest('§6 the overseer’s lone badge drops the role word and keeps the cost',
  async ({ mount }) => {
    const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
    const { el } = await mount(
      <OrgCanvas tree={tree(['ceo'])} op={() => Promise.resolve({} as never)}
        slug="mine" toast={noop} mailEvt={null} />)
    await flush()
    const btns = [...el.querySelectorAll('.sq.user .hsof button')] as HTMLElement[]
    assert.ok(btns.length >= 3,
      `expected the eye's hire badges, saw ${btns.length}`)

    const seen: Record<string, number> = {}
    for (const b of btns) {
      const s = b.getAttribute('title') ?? ''
      const m = /^hire an? ([\w-]+)/.exec(s)
      if (!m) continue
      const tier = m[1]!
      // the role word is gone...
      assert.doesNotMatch(s, /\b(subordinate|coworker|superior)\b/,
        `the overseer badge still names a role ("${s}") — under the eye there `
        + 'is only one hire badge, so the word distinguishes nothing')
      // ...and nothing else went with it: shape is `hire <a|an> <tier> (-N)`,
      // where N may be FRACTIONAL — a sub-$1/M tier costs a fraction of a
      // credit (gpt-reserve and luna are 0.2 since 2026-09-03), and the badge
      // shows the real price rather than rounding it to something the ledger
      // does not charge
      assert.match(s, /^hire an? [\w-]+ \(-[\d.]+\)$/,
        `the overseer badge is not "hire <a|an> <tier> (-N)" ("${s}")`)
      const { phrase, cost } = parts(s)
      assert.equal(words(phrase).length, 3,
        `the overseer phrase is ${words(phrase).length} words ("${s}") — `
        + 'dropping the role should leave exactly "hire a <tier>"')
      assert.ok(cost !== null, `no cost badge on the overseer tooltip ("${s}")`)
      seen[tier] = cost!
    }

    // SHARED COST RULE — the same one §5 applies to the three-badge family.
    // This is the half most at risk from an edit that only meant to remove a
    // word, so it is asserted here rather than assumed to have survived.
    assert.ok(Object.keys(seen).length >= 3,
      `expected a badge per tier on the eye, saw ${JSON.stringify(seen)}`)
    for (const [tier, cost] of Object.entries(seen)) {
      const want = SEATS[tier]
      assert.ok(want !== undefined,
        `the fixture declares no seat cost for "${tier}"`)
      assert.equal(cost, -want,
        `the overseer's ${tier} badge quotes ${cost} but a ${tier} seat costs `
        + `${want} — the cost must survive the role word being dropped`)
    }
    assert.ok(new Set(Object.values(seen)).size > 1,
      `every tier quoted the same cost ${JSON.stringify(seen)} — this section `
      + 'is not actually reading per-tier prices')
  })

// ===================================================================== §7
// The two families must not bleed into each other: dropping the role word on
// the eye must not drop it anywhere else. An agent card still shows three
// badges and still needs all three words.

// ===================================================================== §8
// THE SECOND COPY — AND WHY THERE ISN'T ONE ANY MORE. Everything above proves
// the UI renders whatever tier table it is handed. The server hands it one —
// but `OrgCanvas` also needs an answer for a payload that arrives without
// `tiers`, and until 2026-09-04 that answer was a literal:
//
//     const seats = tree.tiers ?? { haiku: 1, sonnet: 2, opus: 5, fable: 10,
//       'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, flash: 1, pro: 2 }
//
// That was a genuine second price table living in the frontend, and it went
// stale exactly as this comment used to warn it would: `astra` was added to
// `ledger.TIERS` in c5049fa and to `CODEX_TIER_SEAT` in shared.ts, and this
// literal was never touched. This check caught it — and it was the ONLY
// thing that did.
//
// The fix was not a twelfth number. The fallback now READS the family tables
// (`ALL_TIER_SEAT` = TIER_SEAT + CODEX_TIER_SEAT + ANTIGRAVITY_TIER_SEAT), so
// there is no second table left to drift, and §8b already holds those three
// against `ledger.TIERS`. So this section changed job: it no longer compares
// two literals, it holds the DERIVATION in place.
//
// TWO HALVES, each of which can fail on its own:
//   (a) VALUE — the merged table really is the backend's table. Catches a
//       merge that drops a family (e.g. spreading two of the three), which
//       §8b cannot see because §8b reads the three sources, not the merge.
//   (b) SOURCE — OrgCanvas's fallback is the identifier, not a table. Catches
//       someone re-inlining prices here, which is the original defect.
//
// ⚠ WHAT THIS DOES NOT CHECK, said plainly: not a render. A behavioural check
// through the hire badges would be VACUOUS — every downstream reader of
// `seats` (cards.tsx `fam(...)`, the HireSheet `seatOf`) falls back through
// its own family table with `seats[t] ?? CODEX_TIER_SEAT[t] ?? 0`, so a
// fallback that was `{}` would still render every correct price. The readers
// that use `seats` RAW are the kiosk cap and the draft credit bar
// (cards.tsx `seats[draft.tier] ?? 0`), and reaching those needs a fixture
// that is mostly fixture. The agreement is a property of the code, so the
// code is what gets read.

test('§8 the frontend’s fallback tier table matches the backend’s', async () => {
  // (a) the VALUE actually handed to `seats` when a payload omits `tiers`
  const { ALL_TIER_SEAT } = await import('../src/canvas/shared')
  assert.deepEqual({ ...ALL_TIER_SEAT }, SEATS,
    'shared.ts ALL_TIER_SEAT — the fallback OrgCanvas hands to every card when '
    + 'the payload carries no `tiers` — disagrees with ledger.TIERS.\n'
    + `  frontend fallback: ${JSON.stringify(ALL_TIER_SEAT)}\n`
    + `  backend charges:   ${JSON.stringify(SEATS)}\n`
    + 'If the three family tables are each right (see §8b), the merge itself '
    + 'is dropping or overriding one.')

  // (b) and OrgCanvas still READS it rather than spelling prices out again
  const src = readFileSync(
    path.join(__SRC_DIR__, 'canvas', 'OrgCanvas.tsx'), 'utf8')
  const m = /tree\.tiers\s*\?\?\s*([^\n]*)/.exec(src)
  assert.ok(m, 'OrgCanvas no longer has a `tree.tiers ?? …` fallback — if it '
    + 'was removed, delete this check with it; if it moved, update the pattern')
  assert.equal(m![1]!.trim(), 'ALL_TIER_SEAT',
    `OrgCanvas's tier fallback is \`${m![1]!.trim()}\`, not the shared `
    + 'ALL_TIER_SEAT table. A literal here is a second price table: that is '
    + 'exactly how `astra` came to be missing from it on 2026-09-04, and '
    + 'nothing but this check noticed. Add the tier to the family table in '
    + 'shared.ts instead — every surface reads it from there.')
})

// ===================================================================== §8b
// THE ONLY REMAINING COPIES — and now the whole frontend's source of truth.
// `shared.ts` carries three family tables: TIER_SEAT, CODEX_TIER_SEAT and
// ANTIGRAVITY_TIER_SEAT. They are not dead code: `anyTierSeat` falls back
// through all three, the desk, the cards and the hire surfaces all price
// through it, and since 2026-09-04 `ALL_TIER_SEAT` merges them into the
// fallback §8 guards. So a stale entry here is a price quoted at a seat the
// ledger does not charge — on every surface at once.
//
// Found the hard way (2026-09-03): the sub-$1 repricing moved gpt-reserve and
// luna to 0.2 in the backend, §8 went green because it only read OrgCanvas,
// and CODEX_TIER_SEAT sat at the old 1 until a rehire panel rendered
// "seat 1" in a test that happened to assert the number. That was precisely
// the drift §8's own comment warned about, in the table §8 did not read.
// Parsed as SOURCE: these are literals, the agreement with `ledger.TIERS` is
// a property of the text, and importing them would prove only that the
// module loads. (§8 imports the MERGE for a different reason — a merge that
// silently drops a family is a value bug, not a text one.)

test('§8b every static seat table in shared.ts matches the backend’s', () => {
  const src = readFileSync(path.join(__SRC_DIR__, 'canvas', 'shared.ts'), 'utf8')
  const table = (name: string): Record<string, number> => {
    // ⚠ ANCHORED ON `export const`, not on the bare name: `TIER_SEAT` is a
    // SUBSTRING of `CODEX_TIER_SEAT`, `ANTIGRAVITY_TIER_SEAT` and
    // `ALL_TIER_SEAT`, so an unanchored pattern reads whichever declaration
    // happens to come first in the file and would start silently measuring a
    // different table the day these are reordered.
    const m = new RegExp(
      `export const ${name}:\\s*Record<string,\\s*number>\\s*=\\s*\\{([^}]*)\\}`)
      .exec(src)
    assert.ok(m, `shared.ts no longer declares ${name} as a literal record — `
      + 'if it moved or was derived, update this check; do not delete it '
      + 'without replacing the guarantee')
    const out: Record<string, number> = {}
    // `[\d.]+`, as in §8: a seat may be fractional below $1/M
    for (const [, k, v] of m![1]!.matchAll(/["']?([\w-]+)["']?\s*:\s*([\d.]+)/g)) {
      out[k!] = Number(v)
    }
    return out
  }
  const merged = {
    ...table('TIER_SEAT'),
    ...table('CODEX_TIER_SEAT'),
    ...table('ANTIGRAVITY_TIER_SEAT'),
  }
  assert.deepEqual(merged, SEATS,
    'the seat tables in src/canvas/shared.ts disagree with ledger.TIERS.\n'
    + `  frontend tables: ${JSON.stringify(merged)}\n`
    + `  backend charges: ${JSON.stringify(SEATS)}\n`
    + '`anyTierSeat` prices the desk, the cards and the hire chips through '
    + 'these three, so a stale row quotes a seat nobody is charged.')
})

uiTest('§7 an ordinary agent card keeps its role words',
  async ({ mount }) => {
    const t = await tips(mount)          // reads off a normal agent, not the eye
    assert.match(t.subordinate, /\bsubordinate\b/,
      `an agent card's bottom badge lost its role word ("${t.subordinate}") — `
      + 'only the overseer, which shows one badge, drops it')
    assert.match(t.coworker, /\bcoworker\b/, `("${t.coworker}")`)
    assert.match(t.superior, /\bsuperior\b/, `("${t.superior}")`)
  })

