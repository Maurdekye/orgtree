// farhire.test.tsx — far-map hire controls stay compact until explicitly opened.
//
// At a distance the canvas card is smaller than a provider-family chip cluster,
// because chips deliberately counter-scale to stay readable. This checks the
// rendered NodeSquare rather than a copy of its tier math: the compact control
// has to contain whatever families SpawnChips currently offers, including a
// machine whose available providers change.
//
// Run: cd frontend && node tests/run.mjs farhire

import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = {
  haiku: 1, sonnet: 2, opus: 5, fable: 10,
  'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, flash: 1, pro: 2,
}

function node(): CanvasNode {
  return {
    id: 'target', state: 'live', tier: 'terra', model_id: 'terra',
    children: [], seat: 2, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] },
  }
}

const available = { enabled: true, installed: true, reason: null }
const absent = { enabled: false, installed: false, reason: null }

function card(zoom: number, providers = {
  codexHire: available, antigravityHire: available, claudeHire: available,
}) {
  const nd = node()
  return mountView(
    <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod="norm" focused={false}
      dragging={false} isDrop={false} seats={seats}
      codexHire={providers.codexHire} antigravityHire={providers.antigravityHire}
      claudeHire={providers.claudeHire}
      map={new Map([[nd.id, nd]])} op={op} slug="org" toast={noop}
      pxc={1} zoom={zoom} compactAt={0.8} pub={false} maxTop={0}
      kioskRemaining={null} cascadeAlloc
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
      onInbox={noop} onLineage={noop} onOpenDoc={noop} onRecenter={noop}
      onJump={noop} onMailLink={noop} onDragStart={noop} onDragMove={noop}
      onDragEnd={noop} onDragCancel={noop} />,
    (el) => el)
}

test('the full three-provider set collapses only after its rendered width stops fitting the node',
  async (t) => {
    // Four tier buttons are 4×22 + 3×4 = 100px wide. A 124px card at .77 is
    // 95.48px wide, so this has crossed the fit boundary and must compact.
    const view = await card(0.77)
    t.after(() => view.unmount())
    const sets = [...view.el.querySelectorAll('.hsof.hire-compact')] as HTMLElement[]
    assert.equal(sets.length, 4, 'the report, both coworker, and superior strips compact together')

    const arrows = new Map(sets.map((set) => [
      set.classList.contains('side-l') ? 'left'
        : set.classList.contains('side-r') ? 'right'
          : set.classList.contains('side-t') ? 'top' : 'bottom',
      set.querySelector('.hire-expand')?.textContent,
    ]))
    assert.deepEqual(Object.fromEntries(arrows), {
      bottom: '↓', left: '←', right: '→', top: '↑',
    }, 'each compact control points away from the card centre')
    for (const set of sets) {
      assert.equal(set.querySelectorAll('.hire-expand').length, 1)
      assert.equal(set.querySelectorAll('.hs-fam').length, 0,
        'the individual family rows are not merely hidden while compact')
    }

    const report = view.el.querySelector('.hsof.hire-compact:not(.side)') as HTMLElement
    const expand = report.querySelector('.hire-expand') as HTMLButtonElement
    await inAct(() => { expand.click() })
    assert.equal(report.classList.contains('is-expanded'), true)
    const offered = [...report.querySelectorAll('.hs-fam button')]
    assert.equal(offered.length, 9,
      'opening renders the exact current provider/tier list, not a compact-only subset')
    assert.equal(new Set(offered.map((b) => b.className)).size, offered.length,
      'opening does not duplicate a tier while it reveals families')
    const codexRow = [...report.querySelectorAll<HTMLElement>('.hs-fam')]
      .find((row) => row.querySelector('.t-luna'))
    assert.ok(codexRow, 'the Codex spawn row is present')
    assert.deepEqual(
      [...codexRow.querySelectorAll('button')].map((b) => b.className),
      ['t-luna', 't-terra', 't-sol'],
      'luna is leftmost in the Codex row; the legacy reserve token is gone (item 12)')

    await inAct(() => { expand.click() })
    assert.equal(report.classList.contains('is-expanded'), false,
      'the same control closes the cluster before moving to another node')
  })

test('the full three-provider set stays direct once the actual panel is wider than its 100px longest row',
  async (t) => {
    // 124×.82 = 101.68px: real room for the 100px Claude row, no compacting.
    const view = await card(0.82)
    t.after(() => view.unmount())
    assert.equal(view.el.querySelectorAll('.hsof.hire-compact').length, 0)
    assert.equal(view.el.querySelectorAll('.hire-expand').length, 0)
    const report = view.el.querySelector('.hsof:not(.side)') as HTMLElement
    assert.ok(report.querySelectorAll('.hs-fam button').length > 0,
      'normal zoom still exposes individual hire tiers directly')
  })

test('a reduced provider set keeps direct buttons until its own row stops fitting',
  async (t) => {
    // Codex now has four chips: 4×22 + 3×4 = 100px. At .82 the card is
    // 101.68px wide, so it still fits and stays direct.
    const view = await card(0.82, {
      codexHire: available, antigravityHire: absent, claudeHire: absent,
    })
    t.after(() => view.unmount())
    assert.equal(view.el.querySelectorAll('.hsof.hire-compact').length, 0)
    assert.equal(view.el.querySelectorAll('.hsof:not(.side) .t-luna').length, 1)
    assert.equal(view.el.querySelectorAll('.hsof:not(.side) .t-gpt-reserve').length, 0,
      'the legacy reserve token never renders as a hire chip (item 12)')
  })

test('a no-harness row is never replaced with a needless compact arrow',
  async (t) => {
    const view = await card(0.24, {
      codexHire: absent, antigravityHire: absent, claudeHire: absent,
    })
    t.after(() => view.unmount())
    assert.equal(view.el.querySelectorAll('.hire-expand').length, 0)
    assert.equal(view.el.querySelectorAll('.hs-none').length, 4,
      'the accounts-route one-shot row remains visible on every placement edge')
  })
