// askticketrow.test.tsx — a question's linked ticket in the chats panel, and its Other answer box.
//
// USER 2026-11-26 14:05:08Z m0a7f4a3d3d1c (4.7.0-alpha.8, chats panel): "the ticket's name gets cut off". The
// ticket row above a question (.ask-q-head) is meant to stay on one line and end in an ellipsis, as the folded
// card's ticket does (.ask-fold-line). Its rule lost to the ticket chip's own rules: the plain chip rule
// `.ref-chip.ref-chip.ref-ready:is(.ref-item, …)` (inline-flex), and with "wrap object mentions" on, the wrapping
// rule (display: inline; white-space: normal) and `line-height: 0`, so a long title broke over lines that stacked on
// top of each other, cut off at the top. Same card, second report (@coordinator-opus 14:05:51Z): with Other picked,
// the answer box is indented but still 100% wide (`.dm-ask .ask-message textarea` beat `textarea.ask-other`), so it
// sticks out past the card's right edge.
//
// jsdom's computed style ignores selector specificity, so these tests work out the winning declaration of each
// property themselves: every style rule of styles.css and dm/dm.css whose selector matches the element, ordered by
// specificity and then source order, as a browser does (no @media rules; no !important in these properties).
//
// Run: node tests/run.mjs askticketrow

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { AskCard } from '../src/canvas/asks'
import { resetSubmittedAsks } from '../src/asksubmitted'
import type { RefRoutes, RefWorld } from '../src/canvas/reflinks'
import type { AskInfo, AskQuestion } from '../src/types'
import { flush, inAct, mountView } from './harness'

declare const __SRC_DIR__: string

const ORG = 'orgtree'
const ITEM = 'chats-panel-on-the-user-s-own-unread-messages-ta'
const TITLE = "Chats panel: × on the user's own unread messages takes them back, like the desk's queued-strip ×"
const world: RefWorld = { org: ORG, agents: new Map([['alice', 'alice']]), items: new Map([[ITEM, TITLE]]), docs: new Map() }
const refs: RefRoutes = { world, onOpen: () => {} }

const Q: AskQuestion = {
  question: 'The × on your own unread messages shifts the text. Which fix do you want?',
  header: '× text shift',
  options: [{ label: 'Always keep the gap' }, { label: 'Wrap only the first line' }],
  work_item: ITEM,
}
let serial = 0
const ask = (): AskInfo => ({
  id: `q-ticket-row-${++serial}`, node: 'alice', at: '2026-11-26T14:00:00Z', status: 'open', kind: 'batch', rev: 1,
  revs: { ask: 1 }, questions: [Q], tabs: [{ kind: 'question', ...Q }], question: Q.question, header: Q.header,
  work_items: [ITEM],
})

// ---- the cascade, worked out by hand
type Rule = { selectors: string[]; style: CSSStyleDeclaration; order: number }
let rules: Rule[] | null = null
const sheetRules = (): Rule[] => {
  if (rules) return rules
  const css = ['styles.css', 'dm/dm.css'].map(f => readFileSync(joinPath(__SRC_DIR__, f), 'utf8')).join('\n')
  const el = document.createElement('style')
  el.textContent = css
  document.head.appendChild(el)
  const out: Rule[] = []
  let order = 0
  for (const r of [...el.sheet!.cssRules]) {
    if (!(r instanceof window.CSSStyleRule)) continue   // @media, @keyframes, @font-face: none of them sets these
    out.push({ selectors: splitTop(r.selectorText), style: r.style, order: order++ })
  }
  el.remove()
  return (rules = out)
}
/** split at top-level commas (not the ones inside :is(…)) */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0, start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1 }
  }
  out.push(s.slice(start).trim())
  return out.filter(Boolean)
}
type Spec = [number, number, number]
const add = (a: Spec, b: Spec): Spec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const more = (a: Spec, b: Spec): boolean => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]
/** Selectors Level 4 specificity: :is/:not/:has take their most specific argument, :where nothing */
function specificity(sel: string): Spec {
  let spec: Spec = [0, 0, 0]
  let i = 0
  while (i < sel.length) {
    const c = sel[i]!
    if (c === '#') { spec = add(spec, [1, 0, 0]); i = skipName(sel, i + 1) }
    else if (c === '.') { spec = add(spec, [0, 1, 0]); i = skipName(sel, i + 1) }
    else if (c === '[') { spec = add(spec, [0, 1, 0]); i = sel.indexOf(']', i) + 1 }
    else if (c === ':' && sel[i + 1] === ':') { spec = add(spec, [0, 0, 1]); i = skipName(sel, i + 2); if (sel[i] === '(') i = close(sel, i) }
    else if (c === ':') {
      const end = skipName(sel, i + 1), name = sel.slice(i + 1, end)
      if (sel[end] === '(') {
        const stop = close(sel, end), args = splitTop(sel.slice(end + 1, stop - 1))
        if (name === 'is' || name === 'not' || name === 'has' || name === 'matches') {
          let best: Spec = [0, 0, 0]
          for (const a of args) { const s = specificity(a); if (more(s, best)) best = s }
          spec = add(spec, best)
        } else if (name !== 'where') spec = add(spec, [0, 1, 0])
        i = stop
      } else { spec = add(spec, [0, 1, 0]); i = end }
    }
    else if (/[a-zA-Z]/.test(c)) { spec = add(spec, [0, 0, 1]); i = skipName(sel, i) }
    else i++
  }
  return spec
}
const skipName = (s: string, i: number) => { while (i < s.length && /[\w-]/.test(s[i]!)) i++; return i }
const close = (s: string, open: number) => { let d = 0; for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')' && --d === 0) return i + 1 } return s.length }
const matches = (el: Element, sel: string): boolean => { try { return el.matches(sel) } catch { return false } }
/** the declared value that wins for `prop` on `el`, and the selector it came from */
function winner(el: Element, prop: string): { value: string; from: string } | null {
  let best: { spec: Spec; order: number; value: string; from: string } | null = null
  for (const r of sheetRules()) {
    const value = r.style.getPropertyValue(prop)
    if (!value) continue
    for (const sel of r.selectors) {
      if (!matches(el, sel)) continue
      const spec = specificity(sel)
      if (!best || more(spec, best.spec) || (spec.join() === best.spec.join() && r.order >= best.order)) best = { spec, order: r.order, value, from: sel }
    }
  }
  return best && { value: best.value.trim(), from: best.from }
}
const won = (el: Element, prop: string) => winner(el, prop)?.value ?? null

// ---- mounting: the chats panel's request bubble, as DmPanel draws it
const realFetch = globalThis.fetch
test.beforeEach(() => {
  globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
})
test.afterEach(() => { globalThis.fetch = realFetch; resetSubmittedAsks(); document.documentElement.classList.remove('wrap-object-mentions') })

async function chatsCard(t: { after: (f: () => void | Promise<void>) => void }, wrap: boolean) {
  document.documentElement.classList.toggle('wrap-object-mentions', wrap)
  const view = await mountView(
    <div className="dm-panel"><div className="dm-msg in first dm-ask">
      <AskCard ask={ask()} slug={ORG} toast={() => {}} refs={refs} layout="messages" />
    </div></div>, e => e)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  return view.el
}

for (const wrap of [false, true]) {
  test(`the question's ticket is one line ending in an ellipsis, never stacked or cut at the top (wrap object mentions ${wrap ? 'on' : 'off'})`, async t => {
    const el = await chatsCard(t, wrap)
    const chip = el.querySelector<HTMLElement>('.dm-ask .ask-q-head > .ref-chip')
    assert.ok(chip, 'POSITIVE CONTROL: the question has its ticket chip')
    assert.equal(chip!.classList.contains('ref-ready'), true, 'POSITIVE CONTROL: a ticket that resolves, as on the user\'s screen')
    assert.match(chip!.textContent ?? '', /Chats panel: × on the user's own unread messages/, 'POSITIVE CONTROL: with its title')
    assert.equal(won(chip!, 'display'), 'block', `a block that can end in an ellipsis (won by ${winner(chip!, 'display')?.from})`)
    assert.equal(won(chip!, 'white-space'), 'nowrap', `one line (won by ${winner(chip!, 'white-space')?.from})`)
    assert.equal(won(chip!, 'text-overflow'), 'ellipsis')
    assert.equal(won(chip!, 'overflow'), 'hidden')
    assert.notEqual(won(chip!, 'line-height'), '0', `its own line height, not the prose chip's 0 (won by ${winner(chip!, 'line-height')?.from})`)
  })
}

test('the Other answer box stays inside the card, lined up with the option rows', async t => {
  const el = await chatsCard(t, false)
  const other = [...el.querySelectorAll<HTMLElement>('.ask-message button.ask-row, .ask-message .ask-row')]
    .find(b => /^\s*Other\s*$/.test(b.querySelector('.ask-row-body')?.textContent ?? ''))
  assert.ok(other, 'POSITIVE CONTROL: the question has an Other row')
  await inAct(async () => { other!.click(); await flush(2) })
  const box = el.querySelector<HTMLTextAreaElement>('.dm-ask .ask-message textarea.ask-other')
  assert.ok(box, 'POSITIVE CONTROL: Other opens its answer box')
  const left = won(box!, 'margin-left'), right = won(box!, 'margin-right'), width = won(box!, 'width'), max = won(box!, 'max-width')
  assert.equal(left, '29px', 'indented under the option text, as on the desk')
  assert.equal(right, '0px', 'its right edge is the option rows\' right edge')
  assert.equal(width, 'calc(100% - 29px)', `as wide as what is left beside the indent (won by ${winner(box!, 'width')?.from})`)
  assert.equal(max, 'calc(100% - 29px)', `never wider (won by ${winner(box!, 'max-width')?.from})`)
})
