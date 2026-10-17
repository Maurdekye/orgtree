// projecttoken.test.tsx — THE PROJECT HIRE TOKEN (Orgtree 4.4.0; docket
// `project-nodes-in-the-org-hierarchy-with-a-fair-p`,
// docs/rust-engine/PROJECT-NODES.md).
//
// USER 2026-10-16 21:02Z: "the user should be able to 'hire' a project from
// the hire tokens like they would hire an agent. its hire token will be
// square instead of a circle, light grey (now the project card's theme colours,
// user 2026-10-17 21:23:44Z), and use an appropriate icon instead
// of a letter. its tooltip will reflect that as well." The coordinator, on
// the same ruling: the token places a project node the way an agent token
// places a hire, and quotes no seat price, because a project is free.
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the token: a folder icon and no letter, alone on the strip's outermost
//      row, a tooltip that says it makes a project, where, and (free), a
//      press that opens the project form and hires nothing, and a light grey
//      square in the shipped stylesheet while the tier tokens stay round;
//   §2 a strip without a project handler (Quick chat's model picker) and a
//      card the canvas did not wire carry no project token;
//   §3 a card's four strips each offer it and name their edge: under the
//      card, beside it (left, right) or above it.
// The project card, the form and the menus are tests/projectnode.test.tsx;
// the engine half is tools/rig/proofs/project-nodes.mjs.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projecttoken

import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { inAct, mountView } from './harness'
import { NodeSquare, SpawnChips } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

declare const __SRC_DIR__: string

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const offer = { enabled: true, installed: true, reason: null }
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10, terra: 2, sol: 5, flash: 1, pro: 2 }
type Side = 'left' | 'right' | 'top'

const strip = (side: Side | undefined, onProject: (() => void) | undefined,
  onSpawn: (tier: string) => void = noop) =>
  mountView(<SpawnChips onSpawn={onSpawn} seats={seats} claudeHire={offer} side={side}
    onProject={onProject} />, (el) => el)

/* ─── §1 the token ──────────────────────────────────────────────────────── */

test('§1a the project token is an icon alone on the outermost row, says it '
  + 'makes a free project, and a press opens the form instead of hiring', async (t) => {
  let asked = 0
  const spawned: string[] = []
  const view = await strip(undefined, () => { asked++ }, (tier) => spawned.push(tier))
  t.after(() => view.unmount())
  const tok = view.el.querySelector<HTMLButtonElement>('button.project-token')
  assert.ok(tok, 'the hire strip carries a project token')
  assert.equal(tok.textContent?.trim(), '', 'an icon in place of a tier letter: no text at all')
  assert.ok(tok.querySelector('svg'), 'the icon itself (a folder)')
  const title = tok.getAttribute('title') ?? ''
  assert.equal(title, 'create a project under this node (free)',
    'the tooltip names a project, where it lands and that it is free')
  assert.equal(/\(-/.test(title), false, `no seat price on a free project, got "${title}"`)
  assert.equal(tok.getAttribute('aria-label'), 'create a project')
  const rows = [...view.el.querySelectorAll('.hs-fam')]
  assert.ok(rows.length >= 2, 'the fixture renders the provider rows the token sits beside')
  assert.equal(rows.at(-1)!.contains(tok), true, 'outermost: its own row after every provider row')
  assert.equal(rows.at(-1)!.querySelectorAll('button').length, 1, 'alone on that row')
  assert.ok(view.el.querySelector('button.t-opus'), 'the tier tokens are still there beside it')
  await inAct(() => { tok.click() })
  assert.equal(asked, 1, 'a press opens the project form')
  assert.deepEqual(spawned, [], 'and hires nothing')
})

test('§1b on the side and top strips it names its place and stays outermost', async (t) => {
  const cases: { side: Side; title: string; at: number }[] = [
    { side: 'left', title: 'create a project beside (free)', at: 0 },
    { side: 'right', title: 'create a project beside (free)', at: -1 },
    { side: 'top', title: 'create a project above, holding this node (free)', at: 0 },
  ]
  for (const c of cases) {
    const view = await strip(c.side, noop)
    t.after(() => view.unmount())
    const tok = view.el.querySelector('button.project-token')
    assert.ok(tok, `${c.side}: a project token`)
    assert.equal(tok.getAttribute('title'), c.title, `${c.side}: the tooltip`)
    const rows = [...view.el.querySelectorAll('.hs-fam')]
    assert.equal(rows.at(c.at)!.contains(tok), true,
      `${c.side}: the row farthest from the card, like the outermost provider row`)
  }
})

test('§1c the shipped stylesheet draws it as a square in the project card\'s theme colours; the tier '
  + 'tokens stay circles', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const rule = (sel: string) => {
    const at = css.indexOf(`${sel} {`)
    assert.ok(at >= 0, `styles.css has no "${sel}" rule`)
    return css.slice(at, css.indexOf('}', at))
  }
  assert.match(rule('.hsof button'), /border-radius:\s*50%/, 'the agent tokens are circles')
  const own = rule('.hsof button.project-token')
  assert.match(own, /border-radius:\s*4px/, 'the project token is a square (softened corners)')
  // USER 2026-10-17 21:23:44Z: "styled with the theme color, same as how
  // project nodes themselves are" (it replaces the light grey of 21:02Z)
  const card = rule('.sq.project')
  const cardBg = card.match(/background:\s*([^;]+);/)![1]!.trim()
  assert.equal(own.match(/background:\s*([^;]+);/)?.[1]?.trim(), cardBg, 'the card\'s own background')
  assert.match(own, /border-style:\s*dashed/, 'the card\'s dashed border')
  assert.match(own, /color:\s*var\(--accent\)/, 'the folder in the theme accent, as on the card')
  assert.equal(/#[0-9a-f]{6}/i.test(own), false, 'no fixed colour left')
})

/* ─── §2 where there is no token ────────────────────────────────────────── */

test('§2 a strip with no project handler (Quick chat\'s model picker) has no project token', async (t) => {
  const view = await mountView(<SpawnChips onSpawn={noop} seats={seats} claudeHire={offer}
    soleHire selected="opus" />, (el) => el)
  t.after(() => view.unmount())
  assert.ok(view.el.querySelector('button.t-opus'), 'the fixture renders tier tokens')
  assert.equal(view.el.querySelector('button.project-token') === null, true,
    'a model picker is not a place to create a project')
})

/* ─── §3 a card's four strips ───────────────────────────────────────────── */

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

// zoom 2: the card is 248 px wide, so no strip folds behind its arrow
const card = (onNewProjectAt?: (edge: 'b' | 'l' | 'r' | 't') => void) => {
  const nd = node()
  return mountView(
    <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod="norm" focused={false}
      dragging={false} isDrop={false} seats={seats} codexHire={offer}
      antigravityHire={offer} claudeHire={offer}
      map={new Map([[nd.id, nd]])} op={op} slug="org" toast={noop}
      pxc={1} zoom={2} compactAt={0.8} maxTop={0} cascadeAlloc
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop}
      onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop}
      onRecenter={noop} onJump={noop} onMailLink={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop}
      onNewProjectAt={onNewProjectAt} />,
    (el) => el)
}

test('§3a each of a card\'s four strips offers the token and names its edge', async (t) => {
  const edges: string[] = []
  const view = await card((edge) => edges.push(edge))
  t.after(() => view.unmount())
  const strips: [string, Element | null][] = [
    ['b', view.el.querySelector('.hsof:not(.side)')], ['l', view.el.querySelector('.hsof.side-l')],
    ['r', view.el.querySelector('.hsof.side-r')], ['t', view.el.querySelector('.hsof.side-t')],
  ]
  for (const [edge, s] of strips) {
    assert.ok(s, `the ${edge} strip is mounted`)
    const toks = s.querySelectorAll<HTMLButtonElement>('button.project-token')
    assert.equal(toks.length, 1, `${edge}: exactly one project token`)
    await inAct(() => { toks[0]!.click() })
  }
  assert.deepEqual(edges, ['b', 'l', 'r', 't'],
    'under the card, beside it on either side, above it: where the agent tokens hire')
})

test('§3b a card without the project handler keeps its four strips and no token', async (t) => {
  const view = await card(undefined)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelectorAll('.hsof').length, 4, 'all four strips are there')
  assert.equal(view.el.querySelectorAll('button.project-token').length, 0)
})
