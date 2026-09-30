// farname.test.tsx — user report 2026-09-30: at maximum zoom-out the popped-out
// agent name renders UNDER adjacent agent nodes.
//
// At mini the hovered card is deliberately painted under its neighbours
// (styles.css `.sq.mini:hover { z-index: 0 }`), and the name reveal lives inside
// that card's stacking context, so a neighbour covered it. The name is now a
// click-through copy in the world layer, a SIBLING of the cards, above them.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs farname
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
function cardElement(lod: 'mini' | 'norm', sink: Sink = { spawned: [], downs: [] },
    focused = false, pinnedFocus = false) {
  const nd = node()
  return (
    <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod={lod} focused={focused} pinnedFocus={pinnedFocus}
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
      onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />)
}

function card(lod: 'mini' | 'norm') {
  return mountView(cardElement(lod), (el) => el)
}

const hover = async (el: Element) => inAct(() => {
  el.querySelector('.sq')!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
})
const css = () => readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
const zOf = (selector: string): number | null => {
  const text = css()
  for (let at = text.indexOf(selector + ' {'); at >= 0; at = text.indexOf(selector + ' {', at + 1)) {
    const block = text.slice(at, text.indexOf('}', at))
    const m = /z-index:\s*(\d+)/.exec(block)
    if (m) return Number(m[1])
  }
  return null
}

test('hovering a far-zoom card puts its name outside the card, above every card layer', async (t) => {
  const view = await card('mini')
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('.sq-far-ghost'), null, 'nothing before hover')
  await hover(view.el)
  const ghost = view.el.querySelector('.sq-far-ghost')
  assert.ok(ghost, 'the name copy mounts on hover')
  assert.equal(ghost!.textContent?.includes('target'), true)
  assert.equal(ghost!.closest('.sq'), null,
    'it must not live inside the card: the card is a stacking context that sits under its neighbours at mini')
  const ghostZ = zOf('.sq-far-ghost')
  for (const layer of ['.sq:hover', '.sq.mini > .hsof.hire-compact.is-expanded'])
    assert.ok(ghostZ !== null && ghostZ > zOf(layer)!, `name z ${ghostZ} must clear ${layer}`)
  assert.ok(ghostZ! > 5, 'and clear an open desk (5)')
  const dragZ = Number(/dragging \? (\d+)/.exec(readFileSync(path.join(__SRC_DIR__, 'canvas', 'cards.tsx'), 'utf8'))![1])
  assert.ok(ghostZ! > dragZ, `name z ${ghostZ} must clear a dragged neighbour card (${dragZ})`)
  const rule = css().slice(css().indexOf('.sq-far-ghost {'))
  assert.match(rule.slice(0, rule.indexOf('}')), /pointer-events:\s*none/, 'click-through, so hit-testing is unchanged')
})

test('keyboard focus reveals the same overlay, and blur removes it', async (t) => {
  const view = await card('mini')
  t.after(() => view.unmount())
  const sq = view.el.querySelector('.sq')!
  await inAct(() => { sq.dispatchEvent(new MouseEvent('focusin', { bubbles: true })) })
  assert.ok(view.el.querySelector('.sq-far-ghost'), 'focus-within reveals the name in the world layer')
  await inAct(() => { sq.dispatchEvent(new MouseEvent('focusout', { bubbles: true })) })
  assert.equal(view.el.querySelector('.sq-far-ghost')!.classList.contains('on'), false, 'retracting')
  await inAct(() => new Promise((r) => setTimeout(r, 350)))
  assert.equal(view.el.querySelector('.sq-far-ghost'), null, 'removed once the reverse has played')
})

test('the overlay reuses the own reveal elements so the original motion plays', async (t) => {
  const view = await card('mini')
  t.after(() => view.unmount())
  await hover(view.el)
  const ghost = view.el.querySelector('.sq-far-ghost')!
  for (const c of ['.sq-far-tier', '.sq-far-scaler', '.sq-far-name'])
    assert.ok(ghost.querySelector(c), `uses the card's own ${c} (its transitions and reduced-motion rule)`)
  assert.equal(ghost.classList.contains('on'), true, 'revealed look is a class switch on the same elements, so its transitions animate it')
  assert.match(css(), /\.sq-far-ghost:not\(\.on\) \.sq-far-tier \{ left: 10px; \}/, 'and the resting look it starts from matches the card')
})

test('at normal zoom the existing in-card reveal is untouched', async (t) => {
  const view = await card('norm')
  t.after(() => view.unmount())
  await hover(view.el)
  assert.equal(view.el.querySelector('.sq-far-ghost'), null)
})

for (const target of ['normal zoom', 'open desk', 'pinned desk'] as const) {
  test(`a revealed mini name disappears immediately on switching to ${target}`, async (t) => {
    const view = await card('mini')
    t.after(() => view.unmount())
    await hover(view.el)
    assert.equal(!!view.el.querySelector('.sq-far-ghost.on'), true, 'positive reveal control')
    await view.render(cardElement(target === 'normal zoom' ? 'norm' : 'mini', undefined,
      target === 'open desk', target === 'pinned desk'))
    assert.equal(!!view.el.querySelector('.sq-far-ghost'), false, 'no mini overlay during the new presentation')
    assert.equal(view.el.querySelector('.sq')!.classList.contains('far-ghosted'), false)
    await view.render(cardElement('mini'))
    assert.equal(!!view.el.querySelector('.sq-far-ghost.on'), true, 'still-hovered mini card reveals on return')
  })
}

test('zooming during pointer-leave retraction removes the overlay without reviving it on return', async (t) => {
  const view = await card('mini')
  t.after(() => view.unmount())
  await hover(view.el)
  await inAct(() => {
    view.el.querySelector('.sq')!.dispatchEvent(new MouseEvent('pointerout', {
      bubbles: true, relatedTarget: document.body,
    }))
  })
  assert.equal(!!view.el.querySelector('.sq-far-ghost'), true, 'eligible leave retains the reverse animation')
  assert.equal(!!view.el.querySelector('.sq-far-ghost.on'), false)
  await view.render(cardElement('norm'))
  assert.equal(!!view.el.querySelector('.sq-far-ghost'), false, 'zoom cancels retraction immediately')
  await view.render(cardElement('mini'))
  assert.equal(!!view.el.querySelector('.sq-far-ghost'), false, 'no stale retained state on rapid return')
  await hover(view.el)
  await inAct(() => new Promise((r) => setTimeout(r, 350)))
  assert.equal(!!view.el.querySelector('.sq-far-ghost.on'), true, 'cancelled leave timer cannot remove a new reveal')
})
