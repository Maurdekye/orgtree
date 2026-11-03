// Shared fixture for the rich-formatting-everywhere tests
// (@item:orgtree/rich-formatting-everywhere-every-rich-text-surfa, spec rev 1 §6).
// One string, one world, one assertion helper: every converted surface must show
// Markdown, LaTeX and mentions the same way.
import assert from 'node:assert/strict'
import type { RefWorld, ResolvedRef } from '../../src/canvas/reflinks'

export const ORG = 't'

/** the spec's fixture string, verbatim */
export const RICH = 'a **bold** word and `code @agent-in-code $x$`, inline $e^{i\\pi}+1=0$, a price $5 and ${HOME},\n'
  + '@alpha @proj-one @item:t/sample-item @doc:t/sample-doc @mail:t/node/alpha/m1 @app:t/demo @panel:t/demo-panel @net:someone.abc123 @user\n'
  + 'a < b & "c"'

/** display math, for the pipeline test only */
export const RICH_DISPLAY = '$$\\int_0^1 x\\,dx$$'

export const world: RefWorld = {
  org: ORG,
  agents: new Map([['alpha', 'alpha'], ['proj-one', 'proj-one']]),
  items: new Map([['sample-item', 'sample-item']]),
  docs: new Map([['sample-doc', 'sample-doc']]),
  handles: new Set(['agent', 'item', 'doc', 'mail', 'app', 'panel'] as never),
}

export const opened: ResolvedRef[] = []
export const onOpen = (r: ResolvedRef) => { opened.push(r) }

/** the refs a surface takes (`RefRoutes`) */
export const refs = { world, onOpen }

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
  const code = root.querySelector('code')
  assert.ok(code && code.textContent?.includes('@agent-in-code'), '(c) the code span keeps its text')
  assert.ok(!code!.querySelector('[data-ref-token]') && !code!.querySelector('.katex'),
    '(c) no chip and no formula inside the code span')
  assert.ok(text.includes('a < b & "c"'), '(d) the literal `a < b & "c"` is visible')
  assert.ok(!text.includes('&lt;') && !text.includes('&amp;'), '(d) no escaped entity text is visible')
}
