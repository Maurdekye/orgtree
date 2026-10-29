// orginbox-delivered-build.mjs — bundles orginbox-delivered.visual.tsx (the real org inbox window from
// ../src, CSS in main.tsx's order) into probe.js and probe.css for orginbox-delivered.capture.cjs.
//
//   node orginbox-delivered-build.mjs <checkout root> <outdir>
//
// <outdir> is below C:/orgtree-build and becomes tip/ of a capture's output. The checkout's
// own apps/desktop/renderer/src is bundled with this file's fixture. A checkout without node_modules reads
// the dependencies in place: BATCH_NODE_MODULES=<abs node_modules dir> (esbuild and React
// resolve from there; nothing is copied or junctioned).
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [root, outdir] = process.argv.slice(2).map((p) => (p ? path.resolve(p) : p))
const buildRoot = path.resolve('C:/orgtree-build')
if (!root || !outdir) throw new Error('usage: node orginbox-delivered-build.mjs <checkout root> <outdir>')
if (!outdir.startsWith(buildRoot + path.sep)) throw new Error(`refusing to write outside C:/orgtree-build: ${outdir}`)
const deps = process.env.BATCH_NODE_MODULES ? path.resolve(process.env.BATCH_NODE_MODULES) : null
const esbuild = deps ? createRequire(path.join(deps, 'noop.js'))('esbuild') : await import('esbuild')
const fixture = path.join(root, 'apps', 'desktop', 'renderer', 'tests', 'orginbox-delivered.visual.tsx')
rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })
const result = await esbuild.build({
  entryPoints: [fixture],
  outfile: path.join(outdir, 'probe.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  logLevel: 'warning',
  metafile: true,
  ...(deps ? { nodePaths: [deps] } : {}),
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
})
const inputs = Object.keys(result.metafile.inputs).filter((i) => !i.includes('node_modules'))
const fingerprint = createHash('sha256').update(readFileSync(path.join(outdir, 'probe.js'))).digest('hex')
writeFileSync(path.join(outdir, 'source.json'), JSON.stringify({ root, fixture, inputs: inputs.length, deps, fingerprint }, null, 2))
console.log(`orginbox-delivered bundle -> ${outdir} (${inputs.length} source files, sha256 ${fingerprint.slice(0, 12)})`)
