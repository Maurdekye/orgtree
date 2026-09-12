// The bundle half of `popoutdrag_probe.py`. Mutations are planted the way
// popout-build.mjs plants them: in the SOURCE, so a fault control exercises
// the same code path the product does rather than a hand-edited copy of it.
import * as esbuild from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const out = path.resolve('node_modules/.orgtree-popoutdrag-probe')
const mutation = process.argv[2]
const mutations = {
  // the state before the fix: the bar keeps `margin-left: auto`, so a
  // popped-out window's title bar is a button cluster in the top-right corner
  'no-detached-bar': ['src/canvas/modalpin.tsx', " + (ownWindow ? ' detached' : '')", ''],
  // ...and the surface's name is rendered only while pinned
  'no-detached-name': ['src/canvas/modalpin.tsx', '{(pinned || ownWindow) && <>', '{pinned && <>'],
  // the panel stops saying it is in a window of its own, so its own heading
  // no longer stands down and the window says its name twice
  'no-panel-class': ['src/canvas/modalpin.tsx', " + (ownWindow ? ' modalpin-detached' : '')", ''],
  // the title bar scrolls away with the content, taking the handle with it
  'no-sticky-bar': ['src/styles.css', 'position: sticky; top: calc(-1 * var(--panel-pad-y, 8px)); z-index: 6;',
    'position: static; z-index: 6;'],
  // the drag region itself is gone: the bar is wide and still moves nothing
  'no-drag-region': ['src/styles.css', '.popout-mount :where(.cc-head-top, .modalpin-bar) { -webkit-app-region: drag; }',
    '.popout-mount :where(.cc-head-top, .modalpin-bar) { -webkit-app-region: none; }'],
  // the exclusions are gone: the drag region swallows every control in it
  'no-control-exclusions': ['src/styles.css', `.popout-mount :where(.cc-head-top, .modalpin-bar)
  :where(button, a, input, select, textarea, summary, label,`,
    `.popout-mount :where(.cc-head-top, .modalpin-bar)
  :where(summary, label,`],
}
if (mutation && !mutations[mutation]) throw new Error(`Unknown mutation ${mutation}`)
const plugins = mutation ? [{ name: mutation, setup(build) {
  const [file, old, replacement] = mutations[mutation]
  build.onLoad({ filter: /\.(css|[tj]sx?)$/ }, ({ path: filePath }) => {
    if (path.resolve(file) !== filePath) return
    const source = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
    if (source.split(old).length !== 2) throw new Error(`Mutation must match once: ${mutation}`)
    return { contents: source.replace(old, replacement),
      loader: filePath.endsWith('.css') ? 'css' : filePath.endsWith('tsx') ? 'tsx' : 'ts' }
  })
} }] : []

mkdirSync(out, { recursive: true })
await esbuild.build({ entryPoints: ['tests/popoutdrag-fixture.tsx'], bundle: true,
  outdir: out, format: 'esm', jsx: 'automatic', loader: { '.woff2': 'file' }, plugins })
writeFileSync(path.join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8">'
  + '<link rel="stylesheet" href="/popoutdrag-fixture.css"></head>'
  + '<body><div id="root"></div><script type="module" src="/popoutdrag-fixture.js"></script></body></html>')
