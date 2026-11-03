// popoutchip.test.tsx — the "<X> is in another window" notice is one compact
// chip that never covers what it doesn't replace
// (@item:orgtree/x-is-in-another-window-placeholder-covers-parts-o; USER
// 2026-11-03 11:53:58Z med8fd483149a; decisions @coordinator-opus
// m022b0a65a2cf). Run:  cd apps/desktop/renderer && node tests/run.mjs popoutchip
import './testguard.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { DetachedNotice, placeStrip } from '../src/popout'
import { cardIsDeskLayout } from '../src/canvas/deskhosts'
import { flush, inAct, mountView } from './harness'

declare const __SRC_DIR__: string
const css = () => readFileSync(joinPath(__SRC_DIR__, 'styles.css'), 'utf8')
const block = (sel: string) => {
  const s = css(); const i = s.indexOf(sel + ' {'); assert.ok(i >= 0, sel + ' exists')
  return s.slice(i, s.indexOf('}', i))
}
const notice = (title: string, kind: string, calls: string[]) =>
  <DetachedNotice key={title} home={document} title={title} kind={kind}
    show={() => calls.push('show ' + title)} back={() => calls.push('back ' + title)} />

test('one notice is one single-line chip with Show window / Return here', async (t) => {
  const calls: string[] = []
  const v = await mountView(<>{notice('Inbox', 'inbox', calls)}</>, (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(2) })
  const chips = document.querySelectorAll('.popout-notices .popout-chip')
  assert.equal(chips.length, 1)
  assert.match(chips[0]!.textContent ?? '', /Inbox is in another window\./)
  const btns = [...chips[0]!.querySelectorAll('button')]
  assert.deepEqual(btns.map((b) => b.textContent), ['Show window', 'Return here'])
  btns[0]!.click(); btns[1]!.click()
  assert.deepEqual(calls, ['show Inbox', 'back Inbox'])
})

test('two or more notices collapse into ONE "N panels in other windows" chip with a list', async (t) => {
  const calls: string[] = []
  const v = await mountView(<>{notice('Inbox', 'inbox', calls)}{notice('Docket', 'docket', calls)}</>, (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(2) })
  assert.equal(document.querySelectorAll('.popout-notices .popout-chip').length, 1, 'never a stack of chips')
  const count = document.querySelector<HTMLButtonElement>('.popout-chip-count')
  assert.equal(count?.textContent?.trim(), '2 panels in other windows')
  assert.equal(document.querySelector('.popout-chip-list'), null, 'closed until opened')
  await inAct(async () => { count!.click(); await flush(2) })
  const rows = [...document.querySelectorAll('.popout-chip-row')]
  assert.equal(rows.length, 2)
  rows[1]!.querySelector('button')!.click()
  assert.deepEqual(calls, ['show Docket'], "each row carries its own panel's bring-back action")
})

test('a lone notice sits just below its visible opener button, else on the strip', async (t) => {
  const opener = document.createElement('button')
  opener.setAttribute('data-popout-opener', 'inbox'); document.body.appendChild(opener)
  opener.getBoundingClientRect = () => ({ x: 40, y: 10, left: 40, top: 10, right: 80, bottom: 34, width: 40, height: 24, toJSON() {} }) as DOMRect
  const v = await mountView(<>{notice('Inbox', 'inbox', [])}</>, (el) => el)
  t.after(() => { v.unmount(); opener.remove() })
  await inAct(async () => { await flush(2) })
  const strip = document.querySelector<HTMLElement>('.popout-strip')!
  assert.equal(strip.style.top, '38px', 'opener bottom + 4')
  assert.equal(strip.style.left, '40px')
  const v2 = await mountView(<>{notice('Settings', 'settings', [])}{notice('Inbox', 'inbox', [])}</>, (el) => el)
  t.after(() => v2.unmount())
  await inAct(async () => { await flush(2) })
  assert.equal(document.querySelector<HTMLElement>('.popout-strip')!.style.top, '52px', 'a collapsed chip uses the top-centre strip')
})

test('unmounting the surface removes its notice and an empty host', async () => {
  const v = await mountView(<>{notice('Inbox', 'inbox', [])}</>, (el) => el)
  await inAct(async () => { await flush(2) })
  v.unmount()
  await inAct(async () => { await flush(3) })
  assert.equal(document.querySelectorAll('.popout-chip').length, 0)
})

test('stylesheet: chip bounds, z-order and pointer pass-through', () => {
  const host = block('.popout-notices')
  assert.match(host, /pointer-events:\s*none/, 'the host never catches clicks')
  const z = Number(/z-index:\s*(\d+)/.exec(host)?.[1])
  assert.ok(z > 0 && z < 60, `above the canvas layer, below overlays and menus (z ${z})`)
  assert.doesNotMatch(host, /max-height/, 'no 40vh stack')
  assert.doesNotMatch(host, /transform/, 'no transform: it would make the fixed strip host-relative')
  assert.match(block('.popout-chip'), /max-width:\s*280px/, 'content-sized, capped near 280px')
  assert.match(block('.popout-chip'), /pointer-events:\s*auto/, 'only the chip catches clicks')
  const desk = block('.popout-placeholder.desk-elsewhere')
  assert.doesNotMatch(desk, /inset:\s*0/, 'a popped-out card desk no longer paints the whole card')
  assert.match(desk, /height:\s*auto/)
  assert.match(desk, /width:\s*max-content/, 'content-sized, not the 900px sign')
  assert.match(desk, /flex-wrap:\s*nowrap/, 'one line')
  const px = (re: RegExp, src: string) => Number(re.exec(src)?.[1])
  assert.ok(px(/font-size:\s*(\d+)px/, desk) <= 24, 'a compact chip, not the 40px legacy sign')
  assert.doesNotMatch(desk, /padding:\s*28px/)
  const holder = css().slice(css().indexOf('.desk-elsewhere-holder { background'))
  assert.match(holder.slice(0, holder.indexOf('}')), /pointer-events:\s*none/, 'the card stays clickable around the chip')
})

test('a focused card whose desk is in another window is NOT laid out as the desk', () => {
  assert.equal(cardIsDeskLayout(true, false, false), true, 'the open desk keeps the desk layout')
  assert.equal(cardIsDeskLayout(true, false, true), false, 'desk elsewhere: the normal face (header, name, badges) returns')
  assert.equal(cardIsDeskLayout(false, true, false), true, 'a pinned desk placeholder is unchanged')
  assert.equal(cardIsDeskLayout(false, false, false), false)
  const cards = readFileSync(joinPath(__SRC_DIR__, 'canvas', 'cards.tsx'), 'utf8')
  assert.match(cards, /const focused = cardIsDeskLayout\(/, 'the card derives its layout from that rule')
  const holder = css().match(/\.sq:not\(\.desk\) \.desk-elsewhere-holder \{ top: (\d+)px; \}/)
  assert.ok(holder, 'the chip sits below the face rows on a face-up card')
  const hosts = readFileSync(joinPath(__SRC_DIR__, 'canvas', 'deskhosts.tsx'), 'utf8')
  assert.match(hosts, /className="desk-slot"[^]*?\{elsewhere && <InDesksPlace/, 'production markup: the holder is INSIDE .desk-slot, not a direct child of .sq')
  assert.doesNotMatch(css(), /\.sq:not\(\.desk\) > \.desk-elsewhere-holder/, 'so the offset must be a descendant selector')
})

test('with no canvas the strip is the body-fixed host', async (t) => {
  const v = await mountView(<>{notice('Inbox', 'inbox', [])}</>, (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(3) })
  assert.ok(document.querySelector('body > .popout-notices .popout-chip'))
})

const VW = 1000, VH = 700
const chip = { w: 280, h: 38 }
const rect = (l: number, t: number, r: number, b: number) => ({ l, t, r, b })

test('placeStrip: top-centre when nothing covers it; the first free spot otherwise', () => {
  assert.deepEqual(placeStrip(VW, VH, [], chip), { mode: 'chip', top: 52, left: 360 })
  // a desk over the top-centre only: the next spot, top-left
  assert.deepEqual(placeStrip(VW, VH, [rect(300, 0, 700, 400)], chip), { mode: 'chip', top: 52, left: 12 })
  // top-centre and top-left covered: top-right
  assert.deepEqual(placeStrip(VW, VH, [rect(0, 0, 700, 400)], chip), { mode: 'chip', top: 52, left: 708 })
  // the whole top band covered: bottom-left
  assert.deepEqual(placeStrip(VW, VH, [rect(0, 0, 1000, 400)], chip), { mode: 'chip', top: 650, left: 12 })
})

test('placeStrip: never overlaps an obstacle it was given', () => {
  const desk = rect(188, -246, 812, 378)
  const p = placeStrip(VW, VH, [desk], chip)
  const box = { l: p.left, t: p.top, r: p.left + chip.w, b: p.top + chip.h }
  const hit = box.l < desk.r && box.r > desk.l && box.t < desk.b && box.b > desk.t
  assert.equal(p.mode, 'chip')
  assert.equal(hit, false, 'the chip clears the ordinary desk')
})

test('placeStrip: with no free spot it becomes a 44x28 badge in a free corner, else top-left', () => {
  // desks cover every chip spot but leave the top-left 44x28 corner free
  const wall = [rect(60, 0, 1000, 700), rect(0, 40, 60, 700)]
  const b = placeStrip(VW, VH, wall, chip)
  assert.equal(b.mode, 'badge')
  assert.ok(b.top >= 0 && b.left >= 0, 'on screen')
  const full = placeStrip(VW, VH, [rect(0, 0, 1000, 700)], chip)
  assert.deepEqual(full, { mode: 'badge', top: 12, left: 12 }, 'a window-filling desk still leaves the way back')
})

test('placeStrip: a lone notice goes under its opener when that spot is free', () => {
  const opener = rect(40, 10, 80, 34)
  assert.deepEqual(placeStrip(VW, VH, [], chip, opener), { mode: 'chip', top: 38, left: 40 })
  assert.deepEqual(placeStrip(VW, VH, [rect(0, 30, 400, 120)], chip, opener).mode, 'chip', 'a covered opener spot falls through')
})

test('the strip host is body-fixed and sits above the canvas layer', () => {
  const css = readFileSync(joinPath(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.doesNotMatch(css, /\.popout-notices\.in-canvas/, 'the canvas-world mount (R7) is gone: .space intercepts clicks there')
})
