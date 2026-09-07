// clickable-docket-references-across-text-surfaces — a canonical reference
// decided: ready, pending, absent, foreign or elsewhere.
//
// THE DEFECT THIS EXISTS TO CATCH IS NOT "the link does not work". It is a
// reference that reports the WRONG ONE OF THE FIVE — most of all the three
// that look alike from the outside:
//
//   · `foreign` silently resolved as local. Two orgs can hold the same item
//     slug, so this does not fail visibly. It opens a different, unrelated
//     object and looks like it worked. Nothing downstream can detect it.
//   · `pending` reported as `absent`. "Not loaded yet" rendered as "does not
//     exist" is a false statement that appears exactly while the page is
//     loading, which is when it will be read.
//   · `elsewhere` reported as `absent`. "This panel has no reader for it" and
//     "it does not exist" are the same picture unless you keep them apart —
//     and the second is a claim about the DATA made because of a limit of the
//     PANEL.
//
// Both are ASSERTED ON THE OUTCOME, not on whether a chip happens to be
// clickable — `foreign` and `absent` are both inert, so an is-it-a-button
// check would pass with the two swapped.
//
// Run: cd frontend && node tests/run.mjs reflinks

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { linkifyRefs } from '../src/canvas/refmd'
import { RefChip, RefProse, TypedRefText, refToken, resolveRef, splitTypedRefs }
  from '../src/canvas/reflinks'
import type { RefWorld } from '../src/canvas/reflinks'
import { REF_TOKEN_RE, buildMentionIndex, parseRef }
  from '../src/canvas/workrefs'
import type { WorkItem } from '../src/types'

const HERE = 'orgtree'
const world = (o: Partial<RefWorld> = {}): RefWorld => ({ org: HERE, ...o })

/** decide one token end to end, the way a surface does */
const decide = (token: string, w: RefWorld) => {
  const p = parseRef(token)
  assert.ok(p, `fixture token does not parse: ${token}`)
  return resolveRef(p!, w)
}

// ------------------------------------------------------------- the four outcomes

test('§1 with no authoritative index the ref is ready and the destination '
  + 'adjudicates', () => {
  // a surface that holds no list of items must NOT invent a verdict. The
  // canvas has no docket loaded; the docket does. Judging from absence of
  // knowledge would mark every real item "unavailable" on the canvas.
  const r = decide(`@item:${HERE}/git-review-workspace`, world())
  assert.equal(r.outcome, 'ready')
  assert.equal(r.label, 'git-review-workspace')
})

test('§2 an index that has arrived and lacks the target says ABSENT, in words',
  () => {
    const r = decide(`@item:${HERE}/no-such-item`,
      world({ items: new Map([['git-review-workspace', 'git-review-workspace']]) }))
    assert.equal(r.outcome, 'absent')
    // ⚠ the WORDS matter: this is the case Astra rejected being rendered as
    // ordinary prose. It has to state that the target is not here.
    assert.match(r.why, /no docket item named no-such-item in this org/)
  })

test('§3 an index still loading says PENDING, and pending is not absent', () => {
  const r = decide(`@item:${HERE}/git-review-workspace`,
    world({ items: 'loading' }))
  assert.equal(r.outcome, 'pending')
  assert.doesNotMatch(r.why, /no docket item/)
  // CONTROL: the SAME token against an arrived-and-empty index must differ.
  // If these two ever agree, the loading/absent distinction has collapsed —
  // and an empty Map is the shape a naive "index ?? new Map()" produces.
  const arrived = decide(`@item:${HERE}/git-review-workspace`,
    world({ items: new Map() }))
  assert.equal(arrived.outcome, 'absent')
  assert.notEqual(r.outcome, arrived.outcome)
})

test("§4 CONTROL — the same slug in two orgs: the foreign one is never "
  + 'resolved against what is on screen', () => {
    const items = new Map([['git-review-workspace', 'git-review-workspace']])
    // present locally, and named by BOTH tokens. The only difference is the
    // org segment, which is the whole point.
    const mine = decide(`@item:${HERE}/git-review-workspace`, world({ items }))
    const theirs = decide('@item:resonite/git-review-workspace', world({ items }))
    assert.equal(mine.outcome, 'ready')
    assert.equal(theirs.outcome, 'foreign')
    // it must not merely be inert — it must say WHOSE it is
    assert.match(theirs.why, /belongs to the org “resonite”/)
  })

test('§4b the org check runs BEFORE the index, so a foreign ref is foreign '
  + 'even when the local index is still loading', () => {
    // ordering control: judged index-first, this would report `pending` and
    // then, once the index arrived, quietly become `ready` — the silent
    // cross-org resolution, arriving late.
    const r = decide('@item:resonite/git-review-workspace',
      world({ items: 'loading' }))
    assert.equal(r.outcome, 'foreign')
  })

// ----------------------------------------------------------------------- mail

test('§5 a mailbox this side cannot address is unavailable, and names no '
  + 'subject or body', () => {
    // §2 of the corrections: no silent mailbox open, and an explicit
    // unavailable outcome that discloses NOTHING about the message.
    const w = world({ mail: (r) => (r.box === 'node' && r.node === 'ghost'
      ? 'absent' : 'ready') })
    const ok = decide(`@mail:${HERE}/node/codex-checklist/m1`, w)
    const no = decide(`@mail:${HERE}/node/ghost/m1`, w)
    assert.equal(ok.outcome, 'ready')
    assert.equal(no.outcome, 'absent')
    for (const r of [ok, no]) {
      assert.doesNotMatch(r.label + ' ' + r.why, /subject|body/i)
      // the id is the address, not content — but it must not be presented as
      // a readable label either
      assert.match(r.label, /^mail in /)
    }
  })

test('§5b a bearer generation survives the round trip — a node id is not a '
  + 'slug', () => {
    // truncating at the @ would address the LIVE agent instead of the bearer:
    // a wrong-target failure that looks like a success.
    const r = decide(`@agent:${HERE}/codex-checklist@4`, world())
    assert.equal(r.ref.id, 'codex-checklist@4')
    assert.equal(refToken(r.ref), `@agent:${HERE}/codex-checklist@4`)
    const m = decide(`@mail:${HERE}/node/codex-checklist@4/m1`, world())
    assert.equal(m.ref.node, 'codex-checklist@4')
    assert.equal(refToken(m.ref), `@mail:${HERE}/node/codex-checklist@4/m1`)
  })

// ------------------------------------------------------------------ splitting

test('§6 splitting is lossless and a token that does not parse stays text',
  () => {
    const text = `see @item:${HERE}/alpha and mail me at bob@example.com, `
      + 'also @item:not a token'
    const runs = splitTypedRefs(text, world())
    assert.equal(runs.map((r) => r.text).join(''), text,
      'concatenating the runs must reproduce the input exactly')
    const linked = runs.filter((r) => r.ref)
    assert.equal(linked.length, 1)
    assert.equal(linked[0]!.text, `@item:${HERE}/alpha`)
  })

test('§6b repeated splits of the same text give the same answer', () => {
  // A REGRESSION PIN, NOT A MUTATION-VERIFIED CONTROL, and labelled as one.
  // I wrote this believing a shared /g regex would drop tokens on the second
  // render; the harness survived that mutant, because `exec` resets
  // `lastIndex` when a scan runs out of matches. The check still earns its
  // place — it would catch statefulness introduced later — but nothing in the
  // code today can make it fail, and calling it a control would be the
  // vacuous pass this suite exists to avoid.
  const text = `@item:${HERE}/a and @doc:${HERE}/d1 and @agent:${HERE}/bot`
  const once = splitTypedRefs(text, world()).filter((r) => r.ref).length
  const twice = splitTypedRefs(text, world()).filter((r) => r.ref).length
  const thrice = splitTypedRefs(text, world()).filter((r) => r.ref).length
  assert.equal(once, 3)
  assert.deepEqual([twice, thrice], [3, 3])
})

// --------------------------------------------------- §6d whole-token boundaries
//
// ⚠ THE WORST FAILURE THIS FILE GUARDS, and it was live until Astra's
// counterexamples found it: a malformed token did not fail, it TRUNCATED, and
// the surviving prefix was a valid reference to something ELSE. A reader saw
// an ordinary working link that opened the wrong agent or the wrong item.
//
// The renderer is checked here, not only the parser: `splitTypedRefs` builds
// its own scan from the shared source, so a grammar that refuses a malformed
// token can still be rendered by a splitter that does not use it.

test('§6d a malformed token is refused by the SPLITTER, not truncated into '
  + 'a link to something else', () => {
  for (const [text, why] of [
    [`@agent:${HERE}/alpha@bad`, 'truncated to agent alpha'],
    [`@agent:${HERE}/alpha@12x`, 'truncated to bearer alpha@12'],
    [`@item:${HERE}/alpha/extra`, 'truncated to item alpha'],
    [`@mail:${HERE}/user/ab12cd34/extra`, 'truncated to a user-box mail'],
  ] as [string, string][]) {
    const runs = splitTypedRefs(text, world())
    assert.equal(runs.filter((r) => r.ref).length, 0, `${text}: ${why}`)
    assert.equal(runs.map((r) => r.text).join(''), text,
      'and the prose is still all there, character for character')
  }
})

test('§6e CONTROL — the two things that must NOT be refused by that rule',
  () => {
    // a real knowledge bearer: `@<digits>` IS part of a node id
    const bearer = splitTypedRefs(`@agent:${HERE}/alpha@12`, world())
      .filter((r) => r.ref)
    assert.equal(bearer.length, 1, 'a bearer is a real, addressable agent')
    assert.equal(bearer[0]!.ref!.ref.id, 'alpha@12')
    // two canonical tokens with NOTHING between them: the second one's `@`
    // is a continuation of the first only if you are not reading it properly
    const pair = splitTypedRefs(`@agent:${HERE}/alpha@item:${HERE}/beta`, world())
      .filter((r) => r.ref)
    assert.deepEqual(pair.map((r) => r.ref!.ref.id), ['alpha', 'beta'])
  })

test('§6f a refused token does not swallow a good one later in the line', () => {
  const runs = splitTypedRefs(
    `@item:${HERE}/alpha/extra then @item:${HERE}/beta`, world())
  const linked = runs.filter((r) => r.ref)
  assert.equal(linked.length, 1, 'the good token was lost with the bad one')
  assert.equal(linked[0]!.ref!.ref.id, 'beta')
})

test('§6c CONTROL — every token the scanner finds also PARSES, which is what '
  + 'keeps the non-parse branch dead', () => {
  // `splitTypedRefs` has an `if (!parsed) continue` that cannot fire, because
  // `parseRef` anchors the same pattern the scanner uses. That is fine — it is
  // the narrowing TypeScript wants — but only while the two stay identical.
  // Let them drift and the branch wakes up and starts SWALLOWING TEXT, which
  // is invisible: prose simply comes out shorter than it went in.
  //
  // So the invariant is checked here rather than the dead branch being
  // "tested" somewhere it can never run. The bearer generation is the segment
  // most likely to be dropped from one side and not the other.
  const probes = [
    `@item:${HERE}/a-b-c`,
    `@doc:${HERE}/d1.`,
    `@agent:${HERE}/codex-checklist@4`,
    `@mail:${HERE}/user/m1`,
    `@mail:${HERE}/org/m2`,
    `@mail:${HERE}/node/codex-checklist@4/m3`,
    `see @agent:${HERE}/bot@2@item:${HERE}/c then stop`,
  ]
  let found = 0
  for (const p of probes) {
    for (const m of p.matchAll(new RegExp(REF_TOKEN_RE.source, 'g'))) {
      found++
      assert.ok(parseRef(m[0]),
        `the scanner found ${m[0]} but parseRef refuses it — the patterns have `
        + 'drifted and splitTypedRefs will now drop that text silently')
    }
  }
  // ⚠ the loop above passes trivially if nothing matched at all
  assert.ok(found >= probes.length, `expected a match per probe, got ${found}`)
})

test('§7 a trustworthy label replaces the id, and only when we have one',
  () => {
    const docs = new Map([['d1', 'The migration contract']])
    assert.equal(decide(`@doc:${HERE}/d1`, world({ docs })).label,
      'The migration contract')
    // no index, no label to borrow — the id, never something invented
    assert.equal(decide(`@doc:${HERE}/d1`, world()).label, 'd1')
  })

// -------------------------------------------------------------------- rendered

test('§8 the rendered chip: ready is a button, the other three are inert and '
  + 'show the whole token', async () => {
    const opened: string[] = []
    const items = new Map([['alpha', 'alpha']])
    const view = await mountView(
      <TypedRefText world={world({ items })} onOpen={(r) => opened.push(r.token)}
        text={`ready @item:${HERE}/alpha absent @item:${HERE}/beta `
          + 'foreign @item:resonite/alpha'} />, (el) => el)
    await flush()
    const btns = view.el.querySelectorAll('button.ref-chip')
    assert.equal(btns.length, 1, 'only the resolvable one is clickable')
    assert.equal(btns[0]!.textContent, 'alpha')

    const absent = view.el.querySelector('.ref-chip.ref-absent')
    const foreign = view.el.querySelector('.ref-chip.ref-foreign')
    assert.ok(absent && foreign, 'both failures are rendered, not dropped')
    // ⚠ the FAILED chips show the literal token — whoever fixes the reference
    // needs to see what was written, and on a foreign ref the org segment IS
    // the explanation.
    assert.match(absent!.textContent!, new RegExp(`@item:${HERE}/beta`))
    assert.match(foreign!.textContent!, /@item:resonite\/alpha/)
    assert.ok(absent!.tagName !== 'BUTTON' && foreign!.tagName !== 'BUTTON')

    await inAct(() => (btns[0] as HTMLElement).click())
    assert.deepEqual(opened, [`@item:${HERE}/alpha`])
    await view.unmount()
  })

test('§8b CONTROL — with no onOpen nothing is clickable, and the prose is '
  + 'still all there', async () => {
    const view = await mountView(
      <TypedRefText world={world()} text={`before @item:${HERE}/alpha after`} />,
      (el) => el)
    await flush()
    assert.equal(view.el.querySelectorAll('button.ref-chip').length, 0)
    assert.match(view.el.textContent!, /before/)
    assert.match(view.el.textContent!, /after/)
    await view.unmount()
  })

test('§9 CONTROL — a chip re-rendered after its index arrives changes its '
  + 'answer', async () => {
    // tokens present BEFORE the index arrives (§8 of the corrections). The
    // first render must not be a permanent verdict.
    const text = `@item:${HERE}/alpha`
    const view = await mountView(
      <TypedRefText world={world({ items: 'loading' })} onOpen={() => {}}
        text={text} />, (el) => el)
    await flush()
    assert.ok(view.el.querySelector('.ref-chip.ref-pending'),
      'before the index: pending')
    assert.equal(view.el.querySelectorAll('button.ref-chip').length, 0)

    await view.render(
      <TypedRefText world={world({ items: new Map([['alpha', 'alpha']]) })}
        onOpen={() => {}} text={text} />)
    await flush()
    assert.ok(!view.el.querySelector('.ref-chip.ref-pending'),
      'after the index: no longer pending')
    assert.equal(view.el.querySelectorAll('button.ref-chip').length, 1,
      'the same token, now resolvable, became clickable')
    await view.unmount()
  })

test('§10 RefChip renders each outcome under its own class', async () => {
  for (const [w, cls] of [
    [world(), 'ref-ready'],
    [world({ items: 'loading' }), 'ref-pending'],
    [world({ items: new Map() }), 'ref-absent'],
  ] as [RefWorld, string][]) {
    const r = decide(`@item:${HERE}/alpha`, w)
    const view = await mountView(<RefChip r={r} onOpen={() => {}} />, (el) => el)
    await flush()
    assert.ok(view.el.querySelector('.' + cls), `expected ${cls}`)
    await view.unmount()
  }
})

test('§10b a chip\'s only element child is its LAST one', async () => {
  // ⚠ NOT COSMETIC, AND MEASURED ONE PANEL OVER. A container that punctuates
  // its children with a generated `::after` paints that separator BETWEEN a
  // component's own parts — checklist-evidence hit exactly this in the
  // turn-mail header on 2026-09-05, where `AgentName`'s two spans got a `·`
  // painted between the model chip and the name it belongs to. A RefChip is
  // immune only as long as its verdict span is the last element inside it,
  // which is a structural fact, so it is asserted rather than left to a page
  // that happens not to punctuate. (refchip_probe measures the rendered half
  // in a real browser; this is the half that needs no Edge.)
  for (const w of [world({ items: new Map() }), world({ items: 'loading' }),
    world()] as RefWorld[]) {
    const r = decide(`@item:${HERE}/alpha`, w)
    const view = await mountView(<RefChip r={r} onOpen={() => {}} />, (el) => el)
    await flush()
    const chip = view.el.querySelector('.ref-chip') as HTMLElement
    assert.ok(chip.children.length <= 1,
      `${r.outcome}: ${chip.children.length} element children`)
    if (chip.children.length === 1) {
      assert.ok(chip.lastElementChild!.classList.contains('ref-why'),
        `${r.outcome}: the element inside the chip is not the verdict`)
    }
    await view.unmount()
  }
})

test('§11 CONTROL — a kind this panel cannot open is "elsewhere", and that is '
  + 'a different claim from "absent"', () => {
  // The docket owns no document reader. If "I cannot open this" were folded
  // into "this does not exist", the panel would state — in words the user
  // reads — that a perfectly real document is missing, because of a limit of
  // the panel rather than anything about the data.
  const handles = new Set<'item'>(['item'])
  // note the docs index is present AND EMPTY: judged by the index this would
  // be `absent`, so the two answers are genuinely distinguishable here.
  const shut = decide(`@doc:${HERE}/d1`,
    world({ docs: new Map(), handles }))
  const open = decide(`@doc:${HERE}/d1`, world({ docs: new Map() }))
  assert.equal(shut.outcome, 'elsewhere')
  assert.equal(open.outcome, 'absent')
  assert.notEqual(shut.outcome, open.outcome)
  assert.doesNotMatch(shut.why, /no document named/)
  assert.match(shut.why, /not opened from this panel/)
  // and a kind it DOES handle is unaffected by the restriction
  assert.equal(decide(`@item:${HERE}/a`, world({ handles })).outcome, 'ready')
})

test('§11b the handles check runs before the index, so a kind this panel '
  + 'cannot open never reports a data verdict while loading', () => {
  const r = decide(`@doc:${HERE}/d1`,
    world({ docs: 'loading', handles: new Set<'item'>(['item']) }))
  assert.equal(r.outcome, 'elsewhere')
})

// --------------------------------- §12: prose requires explicit references

test('§12 bare agent names stay plain, bare items link, explicit refs remain links', async () => {
  const LIVE = 'live-agent'
  const RETIRED = 'retired-agent'
  const ITEM = 'checklist-evidence'
  const index = buildMentionIndex(
    [{ slug: ITEM } as WorkItem], [[LIVE, 'opus'], [RETIRED, 'haiku']])
  const prose = `@agent:${HERE}/${LIVE} then ${LIVE}, ${RETIRED}, and ${ITEM}`

  const opened: string[] = []
  const view = await mountView(
    <RefProse text={prose} world={world({
      agents: new Map([[LIVE, LIVE], [RETIRED, RETIRED]]),
      tierOf: () => 'opus',
    })} onOpen={(r) => opened.push(r.ref.kind)} index={index}
      onPick={() => {}} onFocusAgent={() => {}} />,
    (el) => el)
  await flush()

  const agent = view.el.querySelector('button.ref-chip.ref-agent')
  assert.ok(agent, 'the explicit token rendered as an agent reference')
  // ⚠ AND IT IS WHOLE. A bare match inside the token would have split it,
  // leaving a stray `@agent:orgtree/` beside a separate item link.
  assert.ok(!view.el.textContent!.includes(`@agent:${HERE}/`),
    'the token was consumed as one unit, not cut in half')

  await inAct(() => (agent as HTMLElement).click())
  assert.deepEqual(opened, ['agent'], 'clicking it opens the AGENT')

  // CONTROL: both bare live and retired agent names remain ordinary text,
  // while the bare item link is preserved for docket navigation.
  const bare = view.el.querySelectorAll('button.docket-ref')
  assert.equal(bare.length, 1, 'the bare item link was lost or an agent linked')
  assert.equal(bare[0]!.textContent, ITEM)
  assert.match(view.el.textContent ?? '', new RegExp(
    `${LIVE}, ${RETIRED}, and ${ITEM}`))
  await view.unmount()
})

// ───────────────────────────────── §11 identity on the REACT chip
//
// The DOM chip and this one are two renderings of one decision, and Astra
// found both rendering a bare label: an agent reference carried none of the
// identity an agent NAME carries everywhere else. Checked on both sides,
// because one of them being right is how this comes back.

const agentWorld = (o: Partial<RefWorld> = {}): RefWorld => world({
  agents: new Map([['peer-one', 'peer-one'], ['me', 'me']]),
  tierOf: (id: string) => (id === 'peer-one' ? 'opus' : 'sonnet'),
  ...o,
})

test('§11 an agent reference wears its current model and still navigates',
async () => {
  const r = decide(`@agent:${HERE}/peer-one`, agentWorld())
  assert.equal(r.tier, 'opus', 'the resolver did not carry the model through')
  const view = await mountView(<RefChip r={r} onOpen={() => {}} />, (el) => el)
  await flush()
  const chip = view.el.querySelector('.ref-chip') as HTMLElement
  assert.equal(chip.tagName, 'BUTTON')
  assert.ok(chip.querySelector('.tier.t-opus'), 'no model icon on the chip')
  assert.match(chip.textContent ?? '', /peer-one/)
  await view.unmount()
})

test('§11b an unknown model leaves the identity intact', async () => {
  const r = decide(`@agent:${HERE}/peer-one`, agentWorld({ tierOf: () => null }))
  const view = await mountView(<RefChip r={r} onOpen={() => {}} />, (el) => el)
  await flush()
  const chip = view.el.querySelector('.ref-chip') as HTMLElement
  assert.equal(chip.tagName, 'BUTTON', 'an unknown model is not an unknown agent')
  assert.equal(chip.querySelectorAll('.tier').length, 0, 'and nothing is guessed')
  await view.unmount()
})

test('§11c at its own focused desk it is identity without a control', async () => {
  const r = decide(`@agent:${HERE}/me`, agentWorld({ destination: 'me' }))
  assert.equal(r.atDestination, true)
  let opened = 0
  const view = await mountView(
    <RefChip r={r} onOpen={() => { opened += 1 }} />, (el) => el)
  await flush()
  const chip = view.el.querySelector('.ref-chip') as HTMLElement
  assert.equal(chip.tagName, 'SPAN', 'somewhere you already are is not a route')
  assert.ok(chip.querySelector('.tier'), 'but the identity is still drawn')
  assert.ok(chip.className.includes('ref-here'))
  await inAct(() => { chip.click() })
  assert.equal(opened, 0)
  await view.unmount()
})

test('§11d CONTROL — the same name on a surface that is not its desk navigates',
async () => {
  for (const destination of [null, 'someone-else']) {
    const r = decide(`@agent:${HERE}/me`, agentWorld({ destination }))
    assert.equal(r.atDestination, false,
      `destination ${String(destination)}: a pinned window and a switchboard `
      + 'panel both still navigate')
    const view = await mountView(<RefChip r={r} onOpen={() => {}} />, (el) => el)
    await flush()
    assert.equal((view.el.querySelector('.ref-chip') as HTMLElement).tagName,
      'BUTTON')
    await view.unmount()
  }
})

test('§11e the model is only claimed for a reference that resolves', async () => {
  // an agent this org does not have gets no icon: an identity drawn beside a
  // name that does not exist is an invention, and the tier resolver would
  // happily answer for anything
  const r = decide(`@agent:${HERE}/nobody`, agentWorld({
    agents: new Map([['peer-one', 'peer-one']]), tierOf: () => 'opus',
  }))
  assert.equal(r.outcome, 'absent')
  assert.equal(r.tier, null, 'a model was claimed for an agent that is not here')
  const view = await mountView(<RefChip r={r} onOpen={() => {}} />, (el) => el)
  await flush()
  assert.equal(view.el.querySelectorAll('.tier').length, 0)
  await view.unmount()
})

test('§11f the two renderers agree — same facts, same structure', async () => {
  // ⚠ THE PIN BETWEEN THE REACT CHIP AND THE DOM CHIP. They are two renderings
  // of one decision and they drifted once already (both rendered a bare label
  // while the resolver was carrying identity).
  const r = decide(`@agent:${HERE}/peer-one`, agentWorld())
  const view = await mountView(<RefChip r={r} onOpen={() => {}} />, (el) => el)
  await flush()
  const react = view.el.querySelector('.ref-chip') as HTMLElement
  const host = document.createElement('div')
  host.innerHTML = `<p>ask @agent:${HERE}/peer-one about it</p>`
  linkifyRefs(host, agentWorld())
  const dom = host.querySelector('.ref-chip') as HTMLElement
  assert.ok(dom, 'the DOM walk produced no chip to compare against')
  assert.equal(dom.tagName, react.tagName)
  assert.equal(dom.title, react.title)
  assert.equal(dom.textContent, react.textContent)
  assert.equal(dom.querySelector('.tier')?.className,
    react.querySelector('.tier')?.className)
  await view.unmount()
})

test('§11g the destination rule waits for the reference to resolve', async () => {
  // ⚠ "you are already there" is a claim about a REAL agent. An org that does
  // not hold this name must still say so — deciding `atDestination` before the
  // lookup would turn a broken reference into a calm "this is its own desk".
  const r = decide(`@agent:${HERE}/ghost`, agentWorld({
    agents: new Map([['peer-one', 'peer-one']]), destination: 'ghost',
  }))
  assert.equal(r.outcome, 'absent')
  assert.equal(r.atDestination, false,
    'a name this org does not have was reported as somewhere you already are')
  const view = await mountView(<RefChip r={r} onOpen={() => {}} />, (el) => el)
  await flush()
  const chip = view.el.querySelector('.ref-chip') as HTMLElement
  assert.ok(chip.className.includes('ref-absent'))
  assert.match(chip.textContent ?? '', /unavailable/)
  await view.unmount()
})

test('§6g a token embedded in a word is not a reference, in the SPLITTER',
  () => {
    // ⚠ ASTRA'S RULING: matching the right target does not make arbitrary
    // embedded text an intentional reference. Checked in the renderer, not
    // only the parser — they share one scanner precisely so this cannot be
    // true in one and false in the other.
    const runs = splitTypedRefs(`not-a-token@item:${HERE}/alpha here`, world())
    assert.equal(runs.filter((r) => r.ref).length, 0)
    assert.equal(runs.map((r) => r.text).join(''),
      `not-a-token@item:${HERE}/alpha here`)
    // CONTROL: the same token with a space before it IS a reference
    const ok = splitTypedRefs(`not a token @item:${HERE}/alpha here`, world())
    assert.equal(ok.filter((r) => r.ref).length, 1)
    // CONTROL: and two adjacent tokens both survive, where the second one
    // starts immediately after an id character
    const pair = splitTypedRefs(`@agent:${HERE}/alpha@2@item:${HERE}/beta`, world())
      .filter((r) => r.ref)
    assert.deepEqual(pair.map((r) => r.ref!.ref.id), ['alpha@2', 'beta'])
  })
