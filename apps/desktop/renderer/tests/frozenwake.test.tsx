// frozenwake.test.tsx — a frozen agent's badge shows its REAL wake estimate,
// and says whose clock it is (user report 2026-09-12, uploads/image-84.png
// and image-86.png).
//
// The two screenshots, side by side:
//
//   badge  ❄ usage limit · capacity available — ▶ to resume
//   Usage  fable limited until 9/12/2026, 3:30:00 PM (inferred)
//
// One agent, one freeze, two readings — and the badge's was the wrong one
// twice over. The estimate came back with the backend fix (tests/
// test_frozen_wake_estimate.py owns that half); this suite owns what the
// payload is then WORTH, which turned out to be less than it looked:
//
//   · `ledger.tree()` rebuilds `frozen` key by key and drops what it does not
//     name. `provenance` was not named, so `TreeFrozen.provenance` — declared
//     in types.ts, read by cards.tsx — was permanently `undefined`. The
//     "(inferred)" marker was DEAD CODE that type-checked, rendered nothing,
//     and could not be seen to be missing.
//   · the desk badge never had the marker at all, so the two surfaces
//     disagreed with each other as well as with Usage.
//
// ⚠ ANTI-VACUITY IS THE WHOLE DESIGN HERE. A marker that never renders passes
// every "it is absent when observed" test ever written. So each § asserts the
// inferred case AND the observed case with the same query, and §5 pins the
// one thing that cannot be faked: the desk and the compact card, rendered
// from ONE fixture, agreeing.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs frozenwake

import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10 }

/** 3:30pm, as `supervisor._reset_label` writes it — a localtime TOKEN, not a
 *  clock spelling. The renderer re-renders it in the USER's zone; a test that
 *  pinned "3:30pm" would be pinning the server's. */
const WAKE = new Date(Date.now() + 37 * 60 * 1000)
const LABEL = `capacity recheck ⟦t:${WAKE.toISOString()}|clock⟧`

interface Fix {
  provenance?: string | null
  limitLocked?: boolean
  until?: string | null
  untilTs?: number | null
}

function node(f: Fix = {}): CanvasNode {
  return {
    id: 'sleepy', state: 'live', tier: 'fable', model_id: 'fable',
    children: [], seat: 10, grant: 0, free: 0, generation: 0,
    scope: { tools: {}, add_dirs: [] },
    limit_locked: f.limitLocked ?? false,
    account: 'claude-0',
    frozen: {
      at: '2026-09-12T12:00:00Z',
      limit: true,
      error: 'usage limit reached',
      account: 'claude-0',
      provenance: f.provenance ?? null,
      until: f.until === undefined ? LABEL : f.until,
      until_ts: f.untilTs === undefined ? WAKE.getTime() / 1000 : f.untilTs,
    },
  } as unknown as CanvasNode
}

function view(nd: CanvasNode, focused: boolean) {
  return mountView(
    <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod="norm" focused={focused}
      dragging={false} isDrop={false} seats={seats}
      map={new Map([[nd.id, nd]])} op={op} slug="org" toast={noop}
      pxc={1} zoom={1} compactAt={0.8} pub={false}
      maxTop={0} kioskRemaining={null} cascadeAlloc
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
      onInbox={noop} onLineage={noop} onOpenDoc={noop}
      onRecenter={noop} onJump={noop} onMailLink={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />,
    (el) => el)
}

/** the freeze chip's words. `focused` picks the surface: the compact card's
 *  badge (cards.tsx) or the desk header's (desk.tsx). */
async function badge(t: { after: (fn: () => void) => void },
  f: Fix, focused: boolean): Promise<string> {
  const v = await view(node(f), focused)
  t.after(() => { void v.unmount() })
  const el = v.el.querySelector<HTMLElement>('.badge.frozen')
  assert.ok(el, `no freeze chip rendered at all (focused=${focused}) — a `
    + 'fixture fault, not a marker fault')
  return (el.textContent ?? '').trim()
}

// --------------------------------------------------- §1 the retired copy
test('§1 neither surface offers manual resume any more', async (t) => {
  for (const focused of [false, true]) {
    const text = await badge(t, { provenance: 'inferred' }, focused)
    assert.ok(!text.includes('▶'),
      `the retired ▶ copy is back (focused=${focused}): ${text}`)
    assert.ok(!/to resume/i.test(text),
      `the badge still instructs a manual resume (focused=${focused}): ${text}`)
    assert.ok(!/capacity available/i.test(text),
      `the badge still claims capacity (focused=${focused}): ${text}`)
  }
})

// ------------------------------------------------------ §2 the estimate
test('§2 the desk badge renders the estimate, in the reader\'s own zone',
  async (t) => {
    const text = await badge(t, { provenance: 'observed' }, true)
    assert.ok(!text.includes('⟦t:'),
      `the localtime token reached the screen raw: ${text}`)
    assert.ok(/\d/.test(text),
      `the badge shows no time at all — the estimate was dropped: ${text}`)
    assert.ok(text.startsWith('usage limit'),
      `the freeze kind stopped being named: ${text}`)
  })

test('§2b …and with NO estimate it says so, rather than inventing one',
  async (t) => {
    const text = await badge(t,
      { provenance: null, until: 'reset time unknown', untilTs: null }, true)
    assert.match(text, /reset time unknown/)
    assert.ok(!text.includes('▶'), text)
  })

// ----------------------------------------------------- §3 the provenance
// THE PAIR. Either assertion alone passes against a marker that never
// renders — which is exactly the state cards.tsx shipped in.
test('§3 the compact card marks an INFERRED park and leaves an observed one '
  + 'unqualified', async (t) => {
  const inferred = await badge(t, { provenance: 'inferred' }, false)
  const observed = await badge(t, { provenance: 'observed' }, false)
  assert.match(inferred, /\(inferred\)/,
    'the compact card cannot say what the Usage modal says — this is the '
    + 'marker that was dead code because ledger.tree() dropped the field')
  assert.doesNotMatch(observed, /\(inferred\)/,
    'a MEASURED deadline must not be qualified as a guess')
})

test('§4 …and so does the desk badge, which never had the marker', async (t) => {
  const inferred = await badge(t, { provenance: 'inferred' }, true)
  const observed = await badge(t, { provenance: 'observed' }, true)
  assert.match(inferred, /\(inferred\)/,
    'the desk badge still renders a ride-along guess in the words a '
    + 'provider-stated time uses')
  assert.doesNotMatch(observed, /\(inferred\)/)
})

test('§4b a record with no provenance at all is not qualified either — an '
  + 'old freeze predates the field and must not read as a guess', async (t) => {
  assert.doesNotMatch(await badge(t, { provenance: null }, true), /\(inferred\)/)
  assert.doesNotMatch(await badge(t, { provenance: null }, false), /\(inferred\)/)
})

// -------------------------------------------------- §5 the two surfaces
test('§5 the desk and the compact card agree — one freeze, one reading',
  async (t) => {
    const desk = await badge(t, { provenance: 'inferred' }, true)
    const card = await badge(t, { provenance: 'inferred' }, false)
    assert.equal(/\(inferred\)/.test(desk), /\(inferred\)/.test(card),
      `desk says "${desk}", card says "${card}" — the two surfaces disagree `
      + 'about the same record, which is the defect one level up')
  })

// ------------------------------------------------------------ §6 HALTED
test('§6 a HALTED node carries no provenance marker — its clock can never '
  + 'fire, so there is no estimate for a marker to qualify', async (t) => {
  for (const focused of [false, true]) {
    const text = await badge(t,
      { provenance: 'inferred', limitLocked: true }, focused)
    assert.doesNotMatch(text, /\(inferred\)/,
      `"halted (inferred)" reads as doubt about the halt (focused=${focused})`)
  }
})
