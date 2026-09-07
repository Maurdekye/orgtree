// focusspace_build.mjs — bundles `focusspace-probe.tsx` (the REAL OrgCanvas
// from ../src, real styles.css) into a browser page for `focusspace_probe.py`.
// Step 1 of that two-step probe; kept out of the `*.test.tsx` glob because a
// bundle proves nothing on its own.
//
//   node tests/focusspace_build.mjs <outdir>
//   node tests/focusspace_build.mjs <outdir> --subst SUBST.json
//
// `--subst` applies an exact-match substitution list to OrgCanvas.tsx, which
// is how the probe builds its RED baseline: the same page, driven the same
// way, against a canvas whose camera still centres on the whole viewport. A
// probe that has never been run against a broken build is not evidence. The
// substitution happens inside esbuild's load hook, with the module's
// resolveDir kept at src/canvas so its relative imports still resolve — the
// file on disk is never touched.

import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CANVAS = path.join(HERE, '..', 'src', 'canvas', 'OrgCanvas.tsx')
const argv = process.argv.slice(2)
const outdir = argv[0]
if (!outdir) {
  console.error('usage: node tests/focusspace_build.mjs <outdir> [--subst F]')
  process.exit(2)
}
const opt = (flag) => { const i = argv.indexOf(flag); return i > 0 ? argv[i + 1] : null }

// the checkout is CRLF (.gitattributes); substitutions are written with \n
const read = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
let contents = read(CANVAS)
const subst = opt('--subst')
if (subst) {
  for (const { old, new: nu } of JSON.parse(readFileSync(subst, 'utf8'))) {
    const n = contents.split(old).length - 1
    if (n !== 1) {
      console.error(`substitution matched ${n} times, expected exactly 1: ${JSON.stringify(old)}`)
      process.exit(3)
    }
    contents = contents.replace(old, nu)
  }
}

rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })
await esbuild.build({
  entryPoints: [path.join(HERE, 'focusspace-probe.tsx')],
  outfile: path.join(outdir, 'probe.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{
    name: 'focusspace-canvas-swap',
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]canvas[\\/]OrgCanvas\.tsx$/ }, () => ({
        contents, loader: 'tsx', resolveDir: path.dirname(CANVAS),
      }))
    },
  }],
})
writeFileSync(path.join(outdir, 'probe.html'),
  '<!doctype html><html><head><meta charset="utf-8">'
  + '<link rel="stylesheet" href="probe.css">'
  // ⚠ `.viewport` is `flex: 1; min-height: 0` (styles.css) — it has NO height
  // of its own and takes it from a flex-column parent. In the app that parent
  // is App.tsx's layout, where OrgCanvas is a sibling of the header. A bare
  // `#root` gives it nothing and the canvas lays out 2px tall, which the probe
  // catches as a degenerate viewport. Reproduce the same container here.
  + '<style>html,body{margin:0;padding:0;width:100%;height:100%}'
  + '#root{display:flex;flex-direction:column;width:100%;height:100%}</style>'
  + '</head><body><div id="root"></div><script src="probe.js"></script></body></html>')
console.log(`focusspace_build: bundled${subst ? ' (subst=' + subst + ')' : ''} into ${outdir}`)
