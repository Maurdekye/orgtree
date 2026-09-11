// minihire.test.tsx — user report 2026-09-11: at the most zoomed-out
// switchboard view the hire tokens disappear, and they only come back at the
// same zoom that brings back the card's quick actions.
//
// THEY WERE ONE GATE. `cards.tsx` computed `hireChips = focused || lod !==
// 'mini'` and used it for all four SpawnChips strips, so the tokens shared the
// shortcut row's threshold exactly (Z_MINI, shared.ts). The tokens are now
// mounted at every zoom; the shortcut row keeps the threshold.
//
// WHY THE GATE EXISTED, AND WHAT REPLACES IT (2026-09-10: a far-zoom control
// "swallows the click that focuses the agent"). Measured rather than assumed —
// tests/minihire_probe.py does the measuring in a real browser, because this
// is a hit-testing question and jsdom does no layout:
//
//   · over its OWN card a token covers 0.24px at z=.24 — it is anchored 1
//     world px inside an edge and grows outward, unlike `.sq-actions`, which
//     is a card ROW drawn over the body. That is the difference between the
//     two controls, and it is why only one of them had to go.
//   · over a NEIGHBOUR it covered up to 12.2px, which is the same complaint
//     one card over. `.sq:hover { z-index: 6 }` was carrying it there; at mini
//     that raise has nothing to clear (it exists for an open desk, and there
//     is no desk below Z_DESK), so the hovered card now sits UNDER its
//     neighbours instead — except while its tier menu is open.
//
// This file holds the parts jsdom can prove: what is mounted, that the hire
// route still fires, that the card's own press still reaches the card, and
// that the stacking rules are really in the shipped stylesheet.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs minihire

import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { inAct, mountView } from './harness'
import { NodeSquare } from '../src/canvas/cards'
import { AGENT_SHORTCUTS_KEY, setAgentShortcutsOn } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

declare const __SRC_DIR__: string

test.beforeEach(() => { setAgentShortcutsOn(true) })
test.afterEach(() => { localStorage.removeItem(AGENT_SHORTCUTS_KEY) })

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10, terra: 2, sol: 5, flash: 1, pro: 2 }
const hire = { enabled: true, installed: true, reason: null }
const W = () => window as unknown as Window & typeof globalThis

interface Sink { spawned: string[]; downs: string[] }

function node(): CanvasNode {
  return {
    id: 'target', title: 'target', state: 'live', tier: 'haiku', model_id: 'haiku',
    seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
    children: [], lineage: [], turns: [], audiences_held: [],
    bearer_state: null, frozen: null, limit_locked: false, mail_pending: 0,
    last_status: { status: 'working', summary: 'fixture', at: '' },
    prev_status: null, inflight_at: null, last_denials: [],
    occupancy: 100, occupancy_est: false, context_window: 1000,
    busy: false, activity: null, proc_warm: true, proc_live: true,
    proc_relaunch: false, proc_relaunch_reason: null, isBearerOf: undefined,
  } as unknown as CanvasNode
}

// z .24 is the desktop wheel's zoom-out clamp (OrgCanvas), i.e. the "maximum
// zoom" of the report; .8 is an ordinary one.
function card(lod: 'mini' | 'norm', sink: Sink = { spawned: [], downs: [] }) {
  const nd = node()
  return mountView(
    <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod={lod} focused={false}
      dragging={false} isDrop={false} seats={seats} codexHire={hire}
      antigravityHire={hire} claudeHire={hire}
      map={new Map([[nd.id, nd]])} op={op} slug="org" toast={noop}
      pxc={1} zoom={lod === 'mini' ? 0.24 : 0.8} compactAt={0.8} pub={false}
      maxTop={0} kioskRemaining={null} cascadeAlloc
      onSpawn={(t) => sink.spawned.push(`b:${t}`)}
      onSpawnSide={(t, side) => sink.spawned.push(`${side}:${t}`)}
      onSpawnTop={(t) => sink.spawned.push(`t:${t}`)}
      onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop}
      onRecenter={noop} onJump={noop} onMailLink={noop}
      onDragStart={(_e, id) => sink.downs.push(id)}
      onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />,
    (el) => el)
}

test('§1 the two controls no longer share one threshold: at maximum zoom-out '
  + 'the hire tokens are mounted and the quick actions are not', async (t) => {
  const view = await card('mini')
  t.after(() => view.unmount())
  const strips = [...view.el.querySelectorAll('.hsof')]
  assert.equal(strips.length, 4,
    'all four hire tokens ride the far-zoom card — subordinate, both '
    + 'coworker columns and the superior splice')
  assert.ok(view.el.querySelectorAll('.hsof-bridge').length > 0,
    'the hover bridges come with them, or the side columns cannot be reached '
    + 'across the gap they stand off')
  assert.equal(view.el.querySelector('.sq-actions'), null,
    'the quick-action row still belongs to the zoom threshold — decoupling '
    + 'the tokens must not have dragged it out here with them')
})

test('§2 …and with shortcuts on at normal zoom BOTH are mounted, so §1 is '
  + 'reading a real difference and not an unmounted card', async (t) => {
  const view = await card('norm')
  t.after(() => view.unmount())
  assert.equal(view.el.querySelectorAll('.hsof').length, 4)
  assert.ok(view.el.querySelector('.sq-actions'),
    'the shortcut row is absent at mini BECAUSE of the zoom, not because this '
    + 'fixture never renders one')
})

test('§3 a far-zoom token really hires: the compact arrow opens its tiers and '
  + 'a tier click routes the spawn', async (t) => {
  const sink: Sink = { spawned: [], downs: [] }
  const view = await card('mini', sink)
  t.after(() => view.unmount())
  const strip = view.el.querySelector('.hsof:not(.side)') as HTMLElement
  assert.ok(strip.classList.contains('hire-compact'),
    'a 124px card is 29.8px at z=.24, so the cluster must be staged behind '
    + 'the one arrow — otherwise this is testing the wrong control')
  assert.equal(strip.querySelectorAll('.hs-fam').length, 0, 'starts collapsed')
  await inAct(() => { strip.querySelector<HTMLButtonElement>('.hire-expand')!.click() })
  assert.deepEqual(sink.spawned, [], 'the arrow itself must not hire anything')
  const fams = view.el.querySelectorAll('.hsof:not(.side) .hs-fam')
  assert.ok(fams.length > 0, 'the arrow opened nothing')
  const opus = view.el.querySelector<HTMLButtonElement>('.hsof:not(.side) button.t-opus')
  assert.ok(opus, 'the tier buttons are the point of opening it')
  await inAct(() => { opus.click() })
  assert.deepEqual(sink.spawned, ['b:opus'],
    'the far-zoom token is visible but dead — the ask was visible AND usable')
})

test('§4 the card\'s own press still reaches the card at maximum zoom-out',
  async (t) => {
    // the mechanism behind the 2026-09-10 report: a control that stops the
    // pointerdown starves the drag-end → centerOn path that focuses an agent.
    // jsdom does no hit-testing, so this is the half it CAN prove — pressing
    // the card body is not intercepted by anything the tokens added.
    const sink: Sink = { spawned: [], downs: [] }
    const view = await card('mini', sink)
    t.after(() => view.unmount())
    const body = view.el.querySelector('.sq-head') as HTMLElement
    const ev = new (W().MouseEvent)('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    await inAct(() => { body.dispatchEvent(ev) })
    assert.deepEqual(sink.downs, ['target'])
  })

test('§5 the stacking rules that keep a token off its NEIGHBOUR are in the '
  + 'shipped stylesheet', async () => {
  // The geometric half lives in tests/minihire_probe.py — a real browser is
  // the only place a hit test means anything. What this can hold is that the
  // rules it measures have not been deleted, and that they say what the
  // measurement assumed.
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  // `.sq:hover` also heads an ordinary border rule, so match the WHOLE
  // selector at the head of a rule and collect every body it owns
  const bodies = (sel: string) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return [...css.matchAll(new RegExp(`(?:^|[}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`, 'g'))]
      .map((m) => m[1]!)
  }
  const declares = (sel: string, decl: RegExp, why: string) => {
    const found = bodies(sel)
    assert.ok(found.length, `no \`${sel}\` rule at all — ${why}`)
    assert.ok(found.some((b) => decl.test(b)),
      `\`${sel}\` no longer declares ${decl} — ${why}: ${found.join(' | ')}`)
  }
  declares('.sq:hover', /z-index:\s*6/,
    'with the hover raise gone the mini override guards nothing and this '
    + 'whole file is inert')
  declares('.sq.mini:hover', /z-index:\s*0/,
    'nothing lowers the hovered card at mini, so its token is back on top of '
    + 'the agent beside it')
  declares('.space > .sq', /z-index:\s*1/,
    'without one numbered layer for every card, `0` is only below the cards '
    + 'that happen to come later in DOM order')
  declares('.sq.mini:hover:has(> .hsof.is-expanded)', /z-index:\s*6/,
    'an open tier menu is taller than the gap it stands in — without this '
    + 'two of its buttons sit under the card below')
})

test('§6 the gate really is gone from the card source, not merely widened',
  async () => {
    const src = readFileSync(path.join(__SRC_DIR__, 'canvas/cards.tsx'), 'utf8')
    assert.doesNotMatch(src, /hireChips/,
      'the hire strips are gated again — §1 would still pass against a gate '
      + 'that admits this fixture and rejects some other card')
    assert.match(src, /showShortcuts && !focused && lod !== 'mini'/,
      'the shortcut row must keep the threshold the tokens just left')
  })
