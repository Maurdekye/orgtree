// Node half of the shared fixture: the data lives in richdata.ts (browser-safe), the assertion helper here.
import assert from 'node:assert/strict'
export { ORG, RICH, RICH_DISPLAY, world, opened, onOpen, refs } from './richdata'

/** Assertions (a)-(d) of spec §6 on a rendered surface. `mentions` limits the
 *  chip check to the kinds the surface supports (default: agent, item, doc). */
export function expectRich(root: Element, opts: { mentions?: string[] } = {}) {
  assert.ok(root.querySelector('strong'), '(a) Markdown: a <strong> exists')
  assert.ok(root.querySelector('.katex'), '(b) LaTeX: the inline formula rendered as .katex')
  const text = root.textContent ?? ''
  assert.ok(text.includes('$5'), '(b) a literal $5 stays text')
  assert.ok(text.includes('${HOME}'), '(b) a literal ${HOME} stays text')
  const tokens = [...root.querySelectorAll('[data-ref-token]')].map(c => c.getAttribute('data-ref-token'))
  for (const t of opts.mentions ?? ['@alpha', '@proj-one', '@item:t/sample-item', '@doc:t/sample-doc']) {
    assert.ok(tokens.includes(t), `(c) a chip for ${t}; chips present: ${tokens.join(', ') || 'none'}`)
  }
  const code = [...root.querySelectorAll('code')].find(c => c.textContent?.includes('@agent-in-code'))
  assert.ok(code, '(c) the code span keeps its text')
  assert.ok(!code!.querySelector('[data-ref-token]') && !code!.querySelector('.katex'),
    '(c) no chip and no formula inside the code span')
  assert.ok(text.includes('a < b & "c"'), '(d) the literal `a < b & "c"` is visible')
  assert.ok(!text.includes('&lt;') && !text.includes('&amp;'), '(d) no escaped entity text is visible')
}
