// Browser-safe data half of the shared fixture (no Node imports, so the visual bundle can use it).
// Shared fixture for the rich-formatting-everywhere tests
// (@item:orgtree/rich-formatting-everywhere-every-rich-text-surfa, spec rev 1 §6).
// One string, one world, one assertion helper: every converted surface must show
// Markdown, LaTeX and mentions the same way.
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
