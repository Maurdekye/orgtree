// overseerhire.test.tsx — the overseer's own hire chips collapse the same
// way an agent's do at far zoom.
//
// User report 2026-08-30: "the hire tokens dont collapse under the overseer
// eye, only next to agents." NodeSquare's SpawnChips call forwards `zoom`
// (cards.tsx) so an agent's chip cluster switches to a compact ⋯ control once
// its rendered width stops fitting the card (see farhire.test.tsx, the sibling
// this file mirrors). UserNode's SpawnChips call omitted `zoom` entirely, so
// `SpawnChips` always saw `zoom === undefined`, computed `fitDelta = Infinity`,
// and `farCompact` could never become true — the eye's chips rendered at full
// size at every zoom, up to and including the map-fit view of a real org,
// where they visibly spill over the card beneath the eye.
//
// This mounts the real UserNode at the exact zoom farhire.test.tsx uses for
// NodeSquare's three-provider case (0.77 — the full nine-tier cluster no
// longer fits a 124px card), and asserts the eye's own bottom strip compacts
// identically. Run against the pre-fix cards.tsx (UserNode's SpawnChips call
// without zoom/expanded/onToggleExpanded) this fails: `.hsof.hire-compact`
// never appears under `.sq.user` at any zoom.
//
// Run: cd frontend && node tests/run.mjs overseerhire

import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UserNode } from '../src/canvas/cards'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = {
  haiku: 1, sonnet: 2, opus: 5, fable: 10,
  'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, flash: 1, pro: 2,
}
const available = { enabled: true, installed: true, reason: null }

function eye(zoom: number) {
  return mountView(
    <UserNode pos={{ x: 0, y: 0 }} isDrop={false}
      stats={{ circ: 0, seats: 0, free: 0 }} pip={null} seats={seats}
      codexHire={available} antigravityHire={available} claudeHire={available}
      pub={false} kiosk={undefined} kioskRemaining={null} pxc={1} zoom={zoom}
      onSpawn={noop} onMailLink={noop} focused={false} eyeW={124}
      posX={() => 0} map={new Map()} op={op} slug="org" toast={noop} />,
    (el) => el)
}

test('the eye’s own hire chips collapse once their rendered width stops '
  + 'fitting the card, exactly as an agent’s do',
  async (t) => {
    // same math as farhire.test.tsx: the widest row is 4×22 + 3×4 = 100px; a
    // 124px card at .77 is 95.48px wide, well past the fit boundary
    const view = await eye(0.77)
    t.after(() => view.unmount())
    const strip = view.el.querySelector('.sq.user .hsof') as HTMLElement
    assert.ok(strip, 'the eye renders no hire strip at all')
    assert.ok(strip.classList.contains('hire-compact'),
      'the eye’s hire strip did not collapse at a zoom where an agent’s '
      + 'equivalent card would — this is the reported bug')
    assert.equal(strip.querySelectorAll('.hire-expand').length, 1,
      'a collapsed strip must offer exactly one control to open it')
    assert.equal(strip.querySelectorAll('.hs-fam').length, 0,
      'the individual family rows are not merely hidden while compact')

    const expand = strip.querySelector('.hire-expand') as HTMLButtonElement
    await inAct(() => { expand.click() })
    assert.equal(strip.classList.contains('is-expanded'), true,
      'the compact control must still open the full tier list on click')
    assert.equal(strip.querySelectorAll('.hs-fam button').length, 9,
      'opening renders the exact current provider/tier list (4 claude + 3 codex '
      + '+ 2 antigravity — the legacy reserve token is not a tier, item 12)')
  })

test('the eye stays direct once the actual panel is wider than its longest row',
  async (t) => {
    // 124×.82 = 101.68px: real room for the 100px Claude row (4 tiers), no
    // compacting — same crossover farhire.test.tsx uses for NodeSquare
    const view = await eye(0.82)
    t.after(() => view.unmount())
    const strip = view.el.querySelector('.sq.user .hsof') as HTMLElement
    assert.ok(strip)
    assert.equal(strip.classList.contains('hire-compact'), false)
    assert.equal(strip.querySelectorAll('.hire-expand').length, 0)
    assert.ok(strip.querySelectorAll('.hs-fam button').length > 0,
      'normal zoom still exposes individual hire tiers directly')
  })
