// Bundles canvasbg-visual.tsx for canvasbg-capture.cjs.
//
//   node tests/canvasbg-build.mjs            (from apps/desktop/renderer)
//
// Output goes to C:/orgtree-build (CANVASBG_VISUAL_OUT overrides, default
// the author's scope). A checkout without node_modules can read the
// dependencies in place via BATCH_NODE_MODULES=<abs node_modules dir> —
// esbuild and React resolve from there, nothing is copied or junctioned.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const buildRoot = path.resolve('C:/orgtree-build')
const out = path.resolve(process.env.CANVASBG_VISUAL_OUT || 'C:/orgtree-build/epic-wonder-full/canvasbg-visual')
if (!out.startsWith(buildRoot + path.sep)) {
  throw new Error(`refusing to write outside C:/orgtree-build: ${out}`)
}
const deps = process.env.BATCH_NODE_MODULES ? path.resolve(process.env.BATCH_NODE_MODULES) : null
const esbuild = deps
  ? createRequire(path.join(deps, 'noop.js'))('esbuild')
  : await import('esbuild')

mkdirSync(out, { recursive: true })
await esbuild.build({
  entryPoints: [path.join(here, 'canvasbg-visual.tsx')],
  bundle: true,
  format: 'esm',
  jsx: 'automatic',
  outdir: out,
  entryNames: 'bundle',
  ...(deps ? { nodePaths: [deps] } : {}),
  define: { 'process.env.NODE_ENV': '"production"' },
})
writeFileSync(path.join(out, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>canvas backgrounds</title>'
  + '<link rel="stylesheet" href="bundle.css"><div id="root"></div>'
  + '<script type="module" src="bundle.js"></script>\n')
console.log(`canvasbg visual bundle -> ${out}`)
