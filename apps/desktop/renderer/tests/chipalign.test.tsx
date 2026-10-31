// chipalign.test.tsx — USER 2026-10-31 08:44:26Z m4b300ae4cbd1 ("agent links are sometimes vertically misaligned
// with the surrounding text in places, can that be cleaned up?").
//
// An inline link chip is an inline-flex box (badge, then name). A flex box takes its baseline from its first item, so
// with `align-items: center` the BADGE's letter sat on the line's baseline and the name 1 to 2 px off the words around
// it. The contract: the name is the chip's baseline (`align-items: baseline`), the badge centres itself and adds no
// height (`align-self: center` and negative block margins), and a row that holds a chip beside words aligns by
// baseline. jsdom has no layout, so this pins the stylesheet; chipalign.capture.cjs measures the real baselines of
// every chip in every surface in Electron (Session 0).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs chipalign

import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView } from './harness'
import { NodeLink, ProjectLink } from '../src/canvas/identity'

declare const __SRC_DIR__: string

/** every declaration the stylesheet gives `selector` (as one of a rule's comma-separated selectors), later rules last */
function declarations(css: string, selector: string): Map<string, string> {
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style)
  const out = new Map<string, string>()
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const r = rule as CSSStyleRule & { cssRules?: CSSRuleList }
      if (r.selectorText && r.selectorText.split(',').map(s => s.trim().replace(/\s+/g, ' ')).includes(selector))
        for (let i = 0; i < r.style.length; i++) out.set(r.style[i]!, r.style.getPropertyValue(r.style[i]!))
      else if (r.cssRules && !r.selectorText) visit(r.cssRules)
    }
  }
  try { visit((style.sheet as CSSStyleSheet).cssRules) } finally { style.remove() }
  return out
}

const css = () => readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')

test('§1 an agent or project chip takes its baseline from its name, not its badge', () => {
  const sheet = css()
  for (const sel of ['.ref-chip.ref-agent', 'button.ref-chip.ref-agent', 'span.ref-chip.ref-agent', '.node-link']) {
    const d = declarations(sheet, sel)
    assert.equal(d.get('display'), 'inline-flex', `${sel} stays an inline-flex box`)
    assert.equal(d.get('align-items'), 'baseline', `${sel}: align-items is baseline (center put the badge's letter on the line's baseline and the name 1 to 2 px off it)`)
    assert.equal(d.get('vertical-align'), 'baseline', `${sel} sits on its line's baseline`)
    assert.equal(d.get('margin-block'), '-2px', `${sel}: negative block margins keep the chip's taller mono line box from lengthening its line`)
  }
})

test('§2 the badge centres itself on the name, out of baseline alignment and out of the line\'s height', () => {
  const sheet = css()
  for (const sel of ['.ref-chip .tier', '.ref-chip .project-mark', '.node-link .tier', '.node-link .project-mark', '.event-actor .tier', '.event-actor .project-mark']) {
    const d = declarations(sheet, sel)
    assert.equal(d.get('align-self'), 'center', `${sel}: align-self centre (it takes no part in the chip's baseline)`)
    assert.equal(d.get('margin-block'), '-4px', `${sel}: negative block margins, so the 16px badge adds nothing to the line`)
  }
})

test('§3 a row that holds a chip beside words aligns by baseline', () => {
  const sheet = css()
  for (const sel of ['.event-head', '.event-actor', '.event-head .ref-chip.ref-agent', '.ask-fold-line', '.idle-ticket'])
    assert.equal(declarations(sheet, sel).get('align-items'), 'baseline', `${sel}: align-items is baseline (centre aligns boxes of a mono chip and sans words, not their text)`)
})

test('§3b a table cell that draws the chip as a block keeps its own height', () => {
  assert.match(declarations(css(), '.slots-table .slot-agent .ref-agent').get('margin-block') ?? '', /^0(px)?$/, 'no negative margin on the clipped block form')
})

test('§3c the ticket chip in those two rows adds nothing to their height', () => {
  for (const sel of ['.ask-fold-line > .ref-chip.ref-chip', '.idle-ticket > .ref-chip.ref-chip'])
    assert.equal(declarations(css(), sel).get('margin-block'), '-2px', `${sel}: negative block margins, since baseline alignment alone grows the row by up to a pixel`)
})

test('§4 the docket mention\'s badge sits on its name\'s line, not 2 px below it', () => {
  const d = declarations(css(), '.docket-modal .docket-mention .tier')
  assert.equal(d.get('top'), '-1.7px', 'raised 2.7 px from the old top: 1px, to within 1 px of the name\'s line centre')
})

test('§5 a mounted chip and its badge wear those rules', async () => {
  const style = document.createElement('style'); style.textContent = css(); document.head.appendChild(style)
  const noop = () => {}
  const view = await mountView(<div className="event-head">
    <span className="event-actor"><NodeLink id="dev1" tier="opus" onFocus={noop} /></span>
    <p><ProjectLink id="crew" onFocus={noop} /></p>
  </div>, el => el)
  try {
    const root = view.el
    const chips = root.querySelectorAll<HTMLElement>('.ref-agent')
    assert.equal(chips.length, 2, 'an agent chip and a project chip')
    assert.equal(getComputedStyle(chips[0]!).alignItems, 'baseline', 'the agent chip is baseline-aligned')
    assert.equal(getComputedStyle(chips[0]!.querySelector('.tier')!).alignSelf, 'center', 'its badge centres itself')
    assert.equal(getComputedStyle(root.querySelector('.event-head')!).alignItems, 'baseline', 'the row aligns by baseline')
    assert.equal(getComputedStyle(chips[1]!.querySelector('.project-mark')!).alignSelf, 'center', "a project chip's folder centres itself too")
  } finally { await view.unmount(); style.remove() }
})
