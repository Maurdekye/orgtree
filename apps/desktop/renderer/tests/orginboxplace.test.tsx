// orginboxplace.test.tsx — user report 2026-10-01 (3.0.9): "in circular view,
// when there are enough agents at the right depth, they can overlap this [the
// org inbox]. can you make it so that no matter what the arrangement of agents
// is, this always stays far enough out from the center to not overlap
// anything?" Ruling: conservative — the inbox keeps its usual place while
// nothing is drawn there, moves out only as far as it must, and comes back.
// Run:  cd apps/desktop/renderer && node tests/run.mjs orginboxplace
declare const __SRC_DIR__: string
import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { cardFurniture, DRAFT, draftOpeningGrant, INBOX, INBOX_CLEAR, INBOX_H, layout, NODE_H, NODE_W, orgPxc, placeOrgInbox, sizeOf, USER, USER_W, withDraftTree } from '../src/canvas/shared'
import type { Box, CanvasNode, ChartLayout, DraftState } from '../src/canvas/shared'
import { DraftNode } from '../src/canvas/cards'
import { recentDocumentChips } from '../src/canvas/docs'
import type { TreePayload } from '../src/types'

type Pt = { x: number; y: number }
const node = (id: string, children: CanvasNode[] = []): CanvasNode =>
  ({ id, title: id, tier: 't', state: 'live', children } as unknown as CanvasNode)
const eye = (kids: CanvasNode[]): CanvasNode =>
  ({ id: USER, title: 'you', tier: null, state: 'user', children: kids } as CanvasNode)
const flat = (n: number, pre = 'k') => Array.from({ length: n }, (_, i) => node(`${pre}${i}`))
const tree = (fan: number, depth: number, pre = 'n'): CanvasNode[] =>
  depth === 0 ? [] : Array.from({ length: fan }, (_, i) => node(`${pre}${i}`, tree(fan, depth - 1, `${pre}${i}.`)))

const usual = (t: Map<string, Pt>): Pt => {
  const e = t.get(USER)!
  return { x: e.x + USER_W + 260, y: e.y - INBOX_H - 96 }
}
// the smallest gap between the inbox and any other card (negative = overlap)
const clearance = (t: Map<string, Pt>, at: Pt): number => {
  const iw = USER_W, ih = INBOX_H
  let min = Infinity
  for (const [id, p] of t) {
    if (id === INBOX) continue
    const { w, h } = sizeOf(id)
    const gx = Math.max(p.x - (at.x + iw), at.x - (p.x + w))
    const gy = Math.max(p.y - (at.y + ih), at.y - (p.y + h))
    min = Math.min(min, Math.max(gx, gy))
  }
  return min
}
const place = (root: CanvasNode, mode: ChartLayout) => {
  const t = layout(root, new Map(), mode)
  return { t, at: placeOrgInbox(t)! }
}
const same = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

const arrangements: [string, CanvasNode][] = [
  ...[1, 2, 3, 4, 6, 8, 9, 12, 20, 40].map((n) => [`${n} top-level`, eye(flat(n))] as [string, CanvasNode]),
  ['4x2', eye(tree(4, 2))],
  ['10x2', eye(tree(10, 2))],
  ['4x3', eye(tree(4, 3))],
  ['a big second ring weighted toward the inbox angle (it encircles it)', eye([node('a', flat(2, 'a')), node('b', flat(40, 'b')), node('c', flat(1, 'c'))])],
  ['a big second ring weighted away from it', eye([node('a', flat(40, 'a')), node('b', flat(2, 'b')), node('c', flat(1, 'c'))])],
  ['1500 agents', eye(tree(10, 1).concat(Array.from({ length: 50 }, (_, i) => node(`w${i}`, tree(5, 1, `w${i}.`).concat(tree(2, 2, `w${i}x`))))))],
]

test('circle view: the org inbox clears every card by the margin, whatever the rings hold', () => {
  let moved = 0
  for (const [name, root] of arrangements) {
    const { t, at } = place(root, 'circular')
    const c = clearance(t, at)
    assert.ok(c >= INBOX_CLEAR - 1e-6, `${name}: inbox is ${c.toFixed(1)}px from the nearest card (needs ${INBOX_CLEAR})`)
    if (!same(at, usual(t))) moved++
  }
  assert.ok(moved >= 3, `the crowded cases really did reach the usual place (${moved} moved)`)
})

test('circle view: the inbox keeps its usual place while nothing is drawn there, and comes back when the arc shrinks', () => {
  for (const n of [1, 2, 3, 4]) {
    const { t, at } = place(eye(flat(n)), 'circular')
    assert.ok(same(at, usual(t)), `${n} agents in a bottom arc: the inbox stays at its usual place`)
  }
  // a deeper ring that does not reach the inbox does not move it either
  const deep = place(eye([node('a', flat(3, 'a'))]), 'circular')
  assert.ok(same(deep.at, usual(deep.t)), 'a sparse deeper ring leaves it alone')
  // grow the first ring until it reaches the inbox, then shrink it back
  let reached = 0
  for (let n = 1; n <= 30 && !reached; n++) {
    const { t, at } = place(eye(flat(n)), 'circular')
    if (!same(at, usual(t))) reached = n
  }
  assert.ok(reached > 4, `the inbox only moves once the ring grows round to it (at ${reached})`)
  const back = place(eye(flat(3)), 'circular')
  assert.ok(same(back.at, usual(back.t)), 'and returns to its usual place when the ring shrinks')
})

// user ruling 2 (2026-10-01): a ring so large that it passes round OUTSIDE the
// usual place leaves the inbox where it is, inside the ring near the centre
test('circle view: a big ring that encircles the usual place does not move the inbox', () => {
  const r = (t: Map<string, Pt>, id: string) => {
    const e = t.get(USER)!, p = t.get(id)!
    return Math.hypot(p.x - e.x, p.y - e.y)
  }
  for (const [name, root, id] of [
    ['40 top-level agents', eye(flat(40)), 'k0'],
    ['one agent with 60 reports', eye([node('a', flat(60, 'a'))]), 'a0'],
  ] as const) {
    const { t, at } = place(root, 'circular')
    const u = usual(t), e = t.get(USER)!
    assert.ok(r(t, id) > Math.hypot(u.x - e.x, u.y - e.y) + 300, `${name}: the ring really passes outside the usual place`)
    assert.ok(same(at, u), `${name}: the inbox stays at its usual place, inside the ring`)
    assert.ok(clearance(t, at) >= INBOX_CLEAR - 1e-6, `${name}: and clear of every card`)
  }
})

test('circle view: when it moves, it moves along the same line and only as far as it must', () => {
  for (const [name, root] of arrangements) {
    const { t, at } = place(root, 'circular')
    const u = usual(t)
    if (same(at, u)) continue
    const e = t.get(USER)!
    const o = { x: e.x + USER_W / 2, y: e.y + USER_W / 2 }
    const du = { x: u.x + USER_W / 2 - o.x, y: u.y + INBOX_H / 2 - o.y }
    const da = { x: at.x + USER_W / 2 - o.x, y: at.y + INBOX_H / 2 - o.y }
    assert.ok(Math.abs(du.x * da.y - du.y * da.x) < 1e-6 * Math.hypot(du.x, du.y) * Math.hypot(da.x, da.y),
      `${name}: same direction from the eye`)
    const s = Math.hypot(da.x, da.y) / Math.hypot(du.x, du.y)
    assert.ok(s > 1, `${name}: outward`)
    // a little nearer in would be inside the margin of some card
    const near = { x: o.x + du.x * (s - 0.01) - USER_W / 2, y: o.y + du.y * (s - 0.01) - INBOX_H / 2 }
    assert.ok(clearance(t, near) < INBOX_CLEAR, `${name}: no nearer spot on the line clears the cards`)
  }
})

test('row view: the inbox keeps its place, and that place clears every card', () => {
  for (const [name, root] of arrangements) {
    const { t, at } = place(root, 'row')
    assert.ok(same(at, usual(t)), `${name}: row placement unchanged`)
    assert.ok(clearance(t, at) >= INBOX_CLEAR - 1e-6, `${name}: and clear of every card`)
  }
})

test('a satellite card (watchdog) laid out at the usual place also pushes the inbox out', () => {
  const t = layout(eye(flat(2)), new Map(), 'circular')
  const u = usual(t)
  t.set('dog:w1', { x: u.x + 10, y: u.y + 10 })
  const at = placeOrgInbox(t)!
  assert.ok(!same(at, u) && clearance(t, at) >= INBOX_CLEAR - 1e-6)
})

// ---- always-drawn furniture outside the card square (review-sol 2026-10-01):
// a credit bar is as tall as its holding and can rise far above its card
const boxGap = (b: Box, at: Pt) => Math.max(
  Math.max(b.x - (at.x + USER_W), at.x - (b.x + b.w)),
  Math.max(b.y - (at.y + INBOX_H), at.y - (b.y + b.h)))
const furnitureClearance = (t: Map<string, Pt>, at: Pt, f: (id: string, p: Pt) => Box[]) => {
  let min = clearance(t, at)
  for (const [id, p] of t) if (id !== INBOX) for (const b of f(id, p)) min = Math.min(min, boxGap(b, at))
  return min
}
// the reviewer's valid weighted ring: every grant covers its children, and
// r8 holds 1000 credits, so its bar is (2 + 1000)·pxc ≈ 198px on a 124px card
function weighted(): { payload: TreePayload; root: CanvasNode } {
  const kids = [16, 5, 16, 13, 0, 15, 10, 21, 6, 21, 4]
  const grants = [32, 10, 32, 26, 0, 30, 20, 42, 1000, 42, 8]
  const agent = (id: string, grant: number, children: unknown[] = []) => ({
    id, title: id, tier: 't', state: 'live', seat: 2, grant, free: 0, children })
  const payload = { roots: kids.map((k, i) => agent(`r${i}`, grants[i]!,
    Array.from({ length: k }, (_, j) => agent(`r${i}.${j}`, 0)))) } as unknown as TreePayload
  return { payload, root: withDraftTree(payload, null) }
}
const furnitureFor = (root: CanvasNode, pxc: number) => {
  const map = new Map<string, CanvasNode>()
  const walk = (n: CanvasNode) => { map.set(n.id, n); n.children.forEach(walk) }
  walk(root)
  // exactly what OrgCanvas passes
  return (id: string, p: Pt) => {
    const n = map.get(id)
    return cardFurniture(id, p, pxc, {
      credits: n && n.state === 'live' && !n.isBearerOf ? n.seat! + n.grant! : undefined,
      docs: n?.documents?.length ?? 0,
    })
  }
}

test('a credit bar rising above its card pushes the inbox out too', () => {
  const { payload, root } = weighted()
  // Descendant weights no longer move ancestors around a ring. Give the tall
  // bar an explicit collision, independent of a particular layout's phase:
  // its card clears the inbox below it, but its bar reaches into the inbox.
  const t = new Map([[USER, layout(root, new Map(), 'circular').get(USER)!]])
  const u = usual(t)
  t.set('r8', { x: u.x + 22, y: u.y + INBOX_H + INBOX_CLEAR + 1 })
  const pxc = orgPxc(payload), f = furnitureFor(root, pxc)
  const bar = f('r8', t.get('r8')!)[0]!
  assert.ok(bar.h > NODE_H + 60, `positive control: r8's bar is ${bar.h.toFixed(1)}px, well above its card`)
  const cardsOnly = placeOrgInbox(t)!
  assert.ok(furnitureClearance(t, cardsOnly, f) < 0,
    'positive control: clearing the card squares alone leaves the inbox on r8\'s bar')
  const at = placeOrgInbox(t, f)!
  const c = furnitureClearance(t, at, f)
  assert.ok(c >= INBOX_CLEAR - 1e-6, `inbox is ${c.toFixed(1)}px from the nearest card or bar (needs ${INBOX_CLEAR})`)
})

test('every arrangement clears the credit bars and the eye\'s own bar as well', () => {
  for (const [name, root] of arrangements) {
    const t = layout(root, new Map(), 'circular')
    // flat test trees carry no credits: give every agent a holding that reaches 1.6 cards
    const f = (id: string, p: Pt) => cardFurniture(id, p, 1, { credits: id === USER ? undefined : NODE_H * 1.6, docs: 4 })
    const at = placeOrgInbox(t, f)!
    assert.ok(furnitureClearance(t, at, f) >= INBOX_CLEAR - 1e-6, `${name}`)
  }
  // and with nothing tall drawn near it, the furniture leaves the usual place alone
  const t = layout(eye(flat(3)), new Map(), 'circular')
  assert.ok(same(placeOrgInbox(t, (id, p) => cardFurniture(id, p, 1, { credits: 10, docs: 4 }))!, usual(t)))
})

test('document chips beside a card count as part of it', () => {
  const t = layout(eye(flat(2)), new Map(), 'circular')
  const u = usual(t)
  // a card 60px left of the inbox (clear by its square) whose chip column reaches within 36px
  t.set('near', { x: u.x - 60 - NODE_W, y: u.y - 30 })
  const withDocs = (id: string, p: Pt) => cardFurniture(id, p, 1, { docs: id === 'near' ? 4 : 0 })
  assert.ok(clearance(t, u) >= INBOX_CLEAR && same(placeOrgInbox(t)!, u), 'positive control: the card square alone is clear')
  assert.ok(furnitureClearance(t, u, withDocs) < INBOX_CLEAR, 'positive control: its chips are not')
  const at = placeOrgInbox(t, withDocs)!
  assert.ok(!same(at, u) && furnitureClearance(t, at, withDocs) >= INBOX_CLEAR - 1e-6, 'so the inbox steps past the chips')
})

// ---- the open hire draft's credit bar (review-sol 2026-10-01): DraftNode
// always draws it, as tall as its tier seat + pending grant
function draftScene(grant: number | null) {
  const agent = (id: string) => ({ id, title: id, tier: 't', state: 'live', seat: 2, grant: 0, free: 0, children: [] })
  const payload = { roots: Array.from({ length: 21 }, (_, i) => agent(`a${i}`)), tiers: { t: 2 },
    default_top_grant: 50 } as unknown as TreePayload
  const draft: DraftState = { parent: null, tier: 't', beside: { anchor: 'a13', side: 'left' } }
  const root = withDraftTree(payload, draft)
  const t = layout(root, new Map(), 'circular')
  const pxc = orgPxc(payload), seats = { t: 2 }
  const base = furnitureFor(root, pxc)
  // exactly what OrgCanvas passes for the draft: seat + (reported ?? opening) grant
  const credits = seats.t + (grant ?? draftOpeningGrant(draft, 50))
  const f = (id: string, p: Pt) => id === DRAFT ? cardFurniture(id, p, pxc, { credits }) : base(id, p)
  return { t, f, pxc, credits, payload }
}

test('the open hire draft\'s credit bar is cleared too, at the grant it opens with', () => {
  const { t, f, pxc, credits } = draftScene(null)
  assert.equal(pxc, 77.5, 'the reviewer\'s scale')
  assert.equal(credits, 52, 'a top-level draft opens at the org default grant (50) + its seat (2)')
  const bar = f(DRAFT, t.get(DRAFT)!)[0]!
  assert.ok(Math.abs(bar.h - 4030) < 1e-6, `positive control: the draft bar is ${bar.h}px tall`)
  const noDraftBar = placeOrgInbox(t, (id, p) => id === DRAFT ? [] : f(id, p))!
  assert.ok(furnitureClearance(t, noDraftBar, f) < 0, 'positive control: ignoring the draft bar leaves the inbox on it')
  const at = placeOrgInbox(t, f)!
  assert.ok(furnitureClearance(t, at, f) >= INBOX_CLEAR - 1e-6, 'with it, the inbox clears the bar')
})

test('changing the draft\'s grant re-places the inbox, and cancelling the draft puts it back', () => {
  for (const g of [0, 5, 50, 400]) {
    const { t, f } = draftScene(g)
    const at = placeOrgInbox(t, f)!
    assert.ok(furnitureClearance(t, at, f) >= INBOX_CLEAR - 1e-6, `grant ${g}: clear of the draft bar`)
  }
  const small = draftScene(0), big = draftScene(400)
  assert.ok(!same(placeOrgInbox(small.t, small.f)!, placeOrgInbox(big.t, big.f)!), 'a taller bar moves it further')
  // cancelled: the same org with no draft lays the inbox out exactly as before
  const plain = withDraftTree(small.payload, null), t0 = layout(plain, new Map(), 'circular')
  const f0 = furnitureFor(plain, small.pxc)
  const back = placeOrgInbox(t0, f0)!
  assert.ok(furnitureClearance(t0, back, f0) >= INBOX_CLEAR - 1e-6)
  assert.ok(!t0.has(DRAFT) && same(back, placeOrgInbox(t0, f0)!), 'no draft, no draft bar')
})

test('DraftNode reports its opening grant and every change to it', async () => {
  const got: number[] = []
  const tree = { cascade_hire: true, slug: 'o' } as unknown as TreePayload
  const v = await mountView(<DraftNode pos={{ x: 0, y: 0 }} draft={{ parent: null, tier: 'haiku' }} map={new Map()}
    seats={{ haiku: 1 }} maxTop={1000} defaultTop={50} tree={tree} zoom={1} pxc={1}
    onConfirm={() => {}} onCancel={() => {}} onGrant={(g) => got.push(g)} />, (el) => el)
  try {
    assert.deepEqual(got, [50], 'the opening grant, on mount')
    const bar = v.el.querySelector('.sq.draft .cbar') as HTMLElement
    assert.ok(bar, 'the draft draws its credit bar')
    const P = (globalThis as unknown as { window: { PointerEvent: typeof PointerEvent } }).window.PointerEvent
    const proto = HTMLElement.prototype as unknown as { setPointerCapture?: unknown }
    const had = proto.setPointerCapture
    proto.setPointerCapture = () => {}
    try {
      await inAct(() => { bar.dispatchEvent(new P('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, clientX: 0, clientY: 300, button: 0, buttons: 1 })) })
      await inAct(() => { bar.dispatchEvent(new P('pointermove', { bubbles: true, cancelable: true, pointerId: 1, clientX: 0, clientY: 270, buttons: 1 })) })
    } finally { proto.setPointerCapture = had }
    assert.equal(got[got.length - 1], 80, 'dragging the bar up 30px at pxc 1 reports grant 80')
  } finally { await v.unmount() }
})

test('the furniture numbers are the stylesheet\'s and the components\' own', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const rule = (sel: string) => { const at = css.indexOf('\n' + sel + ' {'); assert.ok(at >= 0, sel); return css.slice(at, css.indexOf('}', at)) }
  assert.match(rule('.cbar'), /left: -22px; bottom: 0; width: 14px;/, '.cbar: 22px out, 14 wide, on the bottom edge')
  assert.match(rule('.cbar-inf-wrap'), /left: -22px; bottom: 0; width: 14px; height: 220px;/, 'the eye\'s bar is 220px')
  assert.match(rule('.doc-chips'), /left: calc\(100% \+ 3px\); top: 26px;[\s\S]*gap: 3px;/, '.doc-chips column')
  assert.match(rule('.doc-chip'), /width: 21px; height: 21px;/, '21px chips')
  const docs = readFileSync(path.join(__SRC_DIR__, 'canvas', 'docs.tsx'), 'utf8')
  assert.match(docs, /recentDocumentChips\(docs\)\.map/, 'chips use the shared selection')
  const presented = Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: `Report ${i}`, at: '' }))
  assert.deepEqual(recentDocumentChips(presented), presented.slice(0, 4), 'at most four chips, newest first')
  const cards = readFileSync(path.join(__SRC_DIR__, 'canvas', 'cards.tsx'), 'utf8')
  assert.match(cards, /const len = Math\.max\(6, \(seat \+ cur\) \* pxc\)/, 'bar length = max(6, (seat + grant)·pxc)')
  assert.match(cards, /live && !node\.isBearerOf && lod !== 'mini' && \(\s*<CreditBar seat=\{seat\} grant=\{grant\}/, 'live non-bearer cards draw it')
  const canvas = readFileSync(path.join(__SRC_DIR__, 'canvas', 'OrgCanvas.tsx'), 'utf8')
  assert.match(canvas, /const pxPerCredit = useMemo\(\(\) => orgPxc\(tree\), \[tree\]\)/, 'bars are drawn at orgPxc(tree)')
  assert.match(canvas, /const inboxPxc = useMemo\(\(\) => orgPxc\(tree\), \[tree\]\)/, 'and the inbox is placed at the same scale')
  assert.match(canvas, /onGrant=\{setDraftGrant\}/, 'the canvas hears the draft grant')
  assert.match(canvas, /credits: id === DRAFT \? draftCredits/, 'and sizes the draft bar from it')
  assert.match(cards, /draftOpeningGrant\(draft, defaultTop\)/, 'DraftNode opens at the same grant')
  assert.match(canvas, /draftOpeningGrant\(draft, tree\.default_top_grant \?\? 50\)/, 'as the canvas assumes')
})

test('OrgCanvas places the inbox through placeOrgInbox, after every other card', () => {
  const src = readFileSync(path.join(__SRC_DIR__, 'canvas', 'OrgCanvas.tsx'), 'utf8').split('\r\n').join('\n')
  const at = src.indexOf('const target = useMemo(')
  const body = src.slice(at, src.indexOf('return t\n', at))
  const inbox = body.indexOf('placeOrgInbox(t, ')
  assert.ok(inbox > 0, 'the target layout uses placeOrgInbox')
  for (const before of ["t.set('dog:'", 'n.isBearerOf && t.has'])
    assert.ok(body.indexOf(before) > 0 && body.indexOf(before) < inbox, `${before} is laid out before the inbox`)
  assert.equal(body.indexOf('USER_W + 260'), -1, 'no second copy of the old fixed offset')
})
