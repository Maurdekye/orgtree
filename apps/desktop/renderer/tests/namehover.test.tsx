// Medium-zoom full-name hover (docket show-full-truncated-agent-name-on-hover-
// at-mediu). At `lod === 'norm'` a hovered card whose `.name` is really cut
// shows a backdrop-backed `.name-full` copy laid over the name, running past
// the card edge; a fitting name never does, the copy goes when the hover ends,
// and far zoom (`lod === 'mini'`) keeps its own `.sq-far-name` reveal.
//
// jsdom has no layout, so the name's measured widths/offsets are supplied by
// a getter on HTMLElement.prototype that answers only for `.name` spans and
// is restored after every test.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct } from './harness'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

declare const __SRC_DIR__: string

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10, flash: 1, pro: 2, terra: 2, sol: 5, luna: .2 }
const hire = { enabled: true, installed: true, reason: null }

function makeNode(id: string): CanvasNode {
  return {
    id, title: id, state: 'live', tier: 'opus', model_id: 'opus',
    seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
    children: [], lineage: [], turns: [], audiences_held: [],
    bearer_state: null, frozen: null, limit_locked: false, mail_pending: 0,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    occupancy: 500, occupancy_est: false, context_window: 1000, busy: false,
    proc_warm: true, proc_live: true, proc_relaunch: false, proc_relaunch_reason: null,
    isBearerOf: null, generation: 1,
  } as unknown as CanvasNode
}

function card(n: CanvasNode, lod: 'mini' | 'norm') {
  return (
    <NodeSquare key={n.id} node={n} pos={{ x: 100, y: 200 }} lod={lod}
      focused={false} dragging={false} isDrop={false} seats={seats}
      codexHire={hire} antigravityHire={hire} claudeHire={hire}
      map={new Map([[n.id, n]])} op={op} slug="test-org" toast={noop} pxc={1}
      zoom={lod === 'mini' ? 0.35 : 1} compactAt={0.8} pub={false} maxTop={100}
      kioskRemaining={null} cascadeAlloc
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
      onInbox={noop} onLineage={noop} onOpenDoc={noop} onRecenter={noop}
      onJump={noop} onMailLink={noop} onDragStart={noop} onDragMove={noop}
      onDragEnd={noop} onDragCancel={noop} onPin={noop} pinned={false} />
  )
}

/** Fake layout for `.name` spans: `scroll` vs `client` decides truncation. */
function fakeNameLayout(scroll: number, client: number) {
  const proto = HTMLElement.prototype
  const keys = ['scrollWidth', 'clientWidth', 'offsetLeft', 'offsetTop'] as const
  const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const)
  const vals = { scrollWidth: scroll, clientWidth: client, offsetLeft: 23, offsetTop: 4 }
  for (const k of keys) {
    const orig = Object.getOwnPropertyDescriptor(proto, k)
    Object.defineProperty(proto, k, {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList?.contains('name')) return vals[k]
        return orig?.get ? orig.get.call(this) : 0
      },
    })
  }
  return () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d)
      else delete (proto as unknown as Record<string, unknown>)[k]
    }
  }
}

// React derives onPointerEnter/Leave from pointerover/pointerout.
const enter = (el: Element) => inAct(() => {
  el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body }))
})
const leave = (el: Element) => inAct(() => {
  el.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
})
const move = (el: Element) => inAct(() => {
  el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
})

const LONG = 'a-very-long-agent-name-that-cannot-fit-the-card'

test('medium zoom: a truncated name expands in place on hover and collapses on leave', async () => {
  const restore = fakeNameLayout(240, 80)
  const view = await mountView(card(makeNode(LONG), 'norm'), (el) => el)
  try {
    const sq = view.el.querySelector<HTMLElement>('.sq')!
    assert.ok(sq.classList.contains('norm'))
    assert.equal(sq.querySelector('.name-full'), null, 'nothing before the hover')

    await enter(sq)
    const full = sq.querySelector<HTMLElement>('.name-full')
    assert.ok(full, 'hovering a truncated name mounts the full-name overlay')
    assert.equal(full!.textContent, LONG, 'the overlay carries the complete name')
    assert.equal(full!.getAttribute('aria-hidden'), 'true', 'the name is not announced twice')
    assert.equal(full!.parentElement, sq.querySelector('.sq-title'),
      'the overlay lives in the name row, not lifted above the card')
    assert.equal(full!.style.left, '23px', 'anchored at the name\'s own x')
    assert.equal(full!.style.top, '4px', 'anchored at the name\'s own y')
    assert.equal(full!.style.transform, '', 'no inline transform or lift')
    assert.equal(sq.querySelector('.name')!.textContent, LONG, 'the regular name stays mounted')

    await leave(sq)
    assert.equal(sq.querySelector('.name-full'), null, 'the overlay goes when the hover ends')
  } finally {
    await view.unmount()
    restore()
  }
})

test('medium zoom: a name that fits does not expand on hover (negative control)', async () => {
  const restore = fakeNameLayout(80, 80)
  const view = await mountView(card(makeNode('short'), 'norm'), (el) => el)
  try {
    const sq = view.el.querySelector<HTMLElement>('.sq')!
    await enter(sq)
    await move(sq)
    assert.equal(sq.querySelector('.name-full'), null, 'fitting names never get the overlay')
  } finally {
    await view.unmount()
    restore()
  }
})

test('medium zoom: a truncated name without hover shows no overlay (negative control)', async () => {
  const restore = fakeNameLayout(240, 80)
  const view = await mountView(card(makeNode(LONG), 'norm'), (el) => el)
  try {
    assert.equal(view.el.querySelector('.name-full'), null)
  } finally {
    await view.unmount()
    restore()
  }
})

test('far zoom: no medium-zoom overlay; the far-zoom name reveal is unchanged', async () => {
  const restore = fakeNameLayout(240, 80)
  const view = await mountView(card(makeNode(LONG), 'mini'), (el) => el)
  try {
    const sq = view.el.querySelector<HTMLElement>('.sq')!
    assert.ok(sq.classList.contains('mini'))
    await enter(sq)
    await move(sq)
    assert.equal(sq.querySelector('.name-full'), null, 'mini never mounts the medium overlay')
    const far = sq.querySelector('.sq-far-tier .sq-far-name')
    assert.ok(far, 'far-zoom name reveal is still rendered')
    assert.equal(far!.textContent, LONG)
  } finally {
    await view.unmount()
    restore()
  }
})

test('zooming from far into medium under a still pointer shows the overlay; zooming out removes it', async () => {
  const restore = fakeNameLayout(240, 80)
  const n = makeNode(LONG)
  const view = await mountView(card(n, 'mini'), (el) => el)
  try {
    const sq = view.el.querySelector<HTMLElement>('.sq')!
    await enter(sq)
    await view.render(card(n, 'norm'))
    assert.ok(view.el.querySelector('.name-full'),
      'the still-hovered card shows the overlay once it reaches medium zoom')
    await view.render(card(n, 'mini'))
    assert.equal(view.el.querySelector('.name-full'), null, 'gone again at far zoom')
  } finally {
    await view.unmount()
    restore()
  }
})

// ---- stylesheet guards. jsdom does no layout, so the "same position, no lift,
// under the controls" guarantees are held here, against the CSS text itself.

const readCss = () => readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** every innermost `selectors { body }` block, @media contents included */
const cssRules = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] }))

const parseDecls = (body: string) => body.split(';').map((d) => d.trim()).filter(Boolean)
  .map((d) => {
    const i = d.indexOf(':')
    return [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()] as const
  })

/** the merged declarations of every rule whose selector list names `sel` exactly */
function declsFor(css: string, sel: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of cssRules(css)) {
    if (r.selectors.includes(sel)) for (const [p, v] of parseDecls(r.body)) out.set(p, v)
  }
  return out
}

/** margin/padding shorthand -> [top, right, bottom, left] in px */
function box(v: string): number[] {
  const parts = v.split(/\s+/).map((s) => {
    assert.match(s, /^-?\d+(\.\d+)?(px)?$/, `box value ${s} is plain px`)
    return Number(s.replace(/px$/, ''))
  })
  const [t, r = t, b = t, l = r] = parts
  return [t, r, b, l]
}

const OVERLAY = '.sq-head .name-full'

test('stylesheet: the overlay has a backdrop, runs on past the card, and is one rule', () => {
  const css = readCss()
  const d = declsFor(css, OVERLAY)
  assert.ok(d.size, `${OVERLAY} rule exists`)
  assert.equal(d.get('position'), 'absolute')
  assert.equal(d.get('white-space'), 'nowrap', 'one line, running past the card edge')
  assert.equal(d.get('background'), 'var(--tip-panel)', 'backdrop behind the text')
  assert.equal(d.get('pointer-events'), 'none', 'presses still land on the card')
  assert.deepEqual(declsFor(css, '.sq-title').get('position'), 'relative',
    'positioned against the name row')
  // no other rule anywhere (a :hover lift, a media override) may reach it
  const reaching = cssRules(css).filter((r) => r.selectors.some((s) => /\.name-full\b/.test(s)))
  assert.deepEqual(reaching.map((r) => r.selectors.join(', ')), [OVERLAY],
    'exactly one rule styles .name-full')
})

test('stylesheet: the overlay sits exactly on the cut name and never moves (no lift)', () => {
  const css = readCss()
  const rule = cssRules(css).find((r) => r.selectors.includes(OVERLAY))!
  assert.doesNotMatch(rule.body, /!important/, 'nothing may outrank the inline left/top')
  // A WHITELIST, not a blacklist: top/bottom/right/left/inset, translate,
  // rotate, scale, transform, offset-*, line-height, vertical-align, margin-*
  // longhands… every way of moving it is refused by not being on this list.
  const allowed = new Set(['position', 'z-index', 'margin', 'padding', 'font-family',
    'font-weight', 'font-size', 'color', 'white-space', 'background', 'border-radius',
    'box-shadow', 'pointer-events', 'transition', 'animation'])
  const d = declsFor(css, OVERLAY)
  for (const p of d.keys()) assert.ok(allowed.has(p), `${OVERLAY} may not declare ${p}`)
  assert.equal(d.get('transition'), 'none')
  assert.equal(d.get('animation'), 'none')
  // the margin cancels the padding exactly, so the text lands where the name's
  // text is: same x, same baseline
  const [mt, mr, mb, ml] = box(d.get('margin')!)
  const [pt, , , pl] = box(d.get('padding')!)
  assert.equal(mt, -pt, 'margin-top cancels padding-top (no vertical shift)')
  assert.equal(ml, -pl, 'margin-left cancels padding-left (no horizontal shift)')
  assert.equal(mr, 0)
  assert.equal(mb, 0)
  // same glyphs as the name it covers — compared, not hard-coded
  const name = declsFor(css, '.sq-head .name')
  for (const p of ['font-family', 'font-weight', 'font-size']) {
    assert.ok(name.get(p), `.sq-head .name declares ${p}`)
    assert.equal(d.get(p), name.get(p), `overlay ${p} matches the name's`)
  }
})

test('stylesheet: the overlay stays under the card controls and hire strips', () => {
  const css = readCss()
  const z = Number(declsFor(css, OVERLAY).get('z-index'))
  assert.ok(Number.isFinite(z), 'overlay declares a numeric z-index')
  for (const sel of ['.gearbtn', '.mailbtn', '.expandbtn', '.retirebtn', '.dismissbtn', '.hsof']) {
    const cz = Number(declsFor(css, sel).get('z-index'))
    assert.ok(Number.isFinite(cz), `${sel} declares a numeric z-index`)
    assert.ok(z < cz, `overlay z ${z} is below ${sel} z ${cz}`)
  }
})

test('stylesheet: the far-zoom lift reveal is unchanged', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.sq\.mini:hover \.sq-far-tier,\s*\n\.sq\.mini:focus-within \.sq-far-tier,\s*\n\.sq\.mini:focus-visible \.sq-far-tier \{\s*top: -26px;/)
})
