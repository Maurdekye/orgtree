// refmdcheap.test.tsx — a body with NO chips is not re-walked on every pass.
// useRefMd runs linkifyRefs after every render (its effect has no deps), and
// the only cheap exit was for a host that already held chips, so every
// re-render of a desk walked every plain row's text again (measured in jsdom
// 2026-11-15, desk-freeze-opus: 8 rows -> 8 full text walks per no-change
// re-render). Not claimed as the 4.6.1 desk-load hang fix: a waste removal.
// Run: node apps/desktop/renderer/tests/run.mjs refmdcheap
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { linkifyRefs } from '../src/canvas/refmd'
import type { RefWorld } from '../src/canvas/reflinks'
import { md } from '../src/canvas/shared'

const world = (o: Partial<RefWorld> = {}): RefWorld => ({ org: 'orgtree', ...o })
function body(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'md'
  el.innerHTML = md(text).__html
  return el
}
/** text walks linkifyRefs makes, counted at the document's TreeWalker */
function walks<T>(fn: () => T): { n: number; value: T } {
  const doc = document as unknown as { createTreeWalker: (...a: unknown[]) => unknown }
  const real = doc.createTreeWalker
  let n = 0
  // text walks only: jsdom's own querySelectorAll walks elements (SHOW_ELEMENT)
  doc.createTreeWalker = function (this: unknown, ...a: unknown[]) { if (a[1] === 4) n++; return real.apply(this, a) }
  try { const value = fn(); return { n, value } } finally { doc.createTreeWalker = real }
}

test('a plain body is walked once, then the next pass with nothing changed is the cheap exit', () => {
  const el = body('Step 4 done.\n\n- checked the build\n- **result**: fine')
  const w = world({ agents: new Map([['alpha', 'alpha']]) })
  assert.equal(linkifyRefs(el, w), 0, 'fixture: nothing to decorate')
  const second = walks(() => linkifyRefs(el, w))
  assert.equal(second.value, -1, 'a pass that found nothing to do must say so (-1), as the chip exit does')
  assert.equal(second.n, 0, `a no-change pass re-walked the body's text ${second.n} time(s)`)
})

test('the cheap exit still rescans when the text or the names change', () => {
  const el = body('waiting on the review')
  const items = new Map([['alpha', { kind: 'item', slug: 'alpha' }]]) as never
  linkifyRefs(el, world(), true, { index: items } as never)
  // the text changed under the host (React re-rendered the html)
  el.innerHTML = md('see @item:orgtree/alpha now').__html
  assert.ok(linkifyRefs(el, world({ items: new Map([['alpha', 'alpha']]) })) >= 1, 'new text with a token was not scanned')
  // a different world: an agent named in the prose enters the index
  const el2 = body('ask bravo about it')
  linkifyRefs(el2, world({ agents: new Map() }))
  const again = walks(() => linkifyRefs(el2, world({ agents: new Map([['bravo', 'bravo']]) })))
  assert.ok(again.n >= 1, 'a world with new names must rescan')
})
