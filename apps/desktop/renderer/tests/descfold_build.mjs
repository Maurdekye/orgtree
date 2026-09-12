// descfold_build.mjs — bundles `descfold-probe.tsx` (the REAL
// DocketDescription and ReceivedMailBody from ../src, the REAL styles.css)
// into a browser page for `descfold_probe.py`. Step 1 of that two-step probe;
// kept out of the `*.test.tsx` glob because a bundle proves nothing on its own.
//
//   node tests/descfold_build.mjs <outdir>
//   node tests/descfold_build.mjs <outdir> --subst SUBST.json
//
// `--subst` swaps text inside the STYLESHEET only, in esbuild's load hook, so
// the file on disk is never touched. It exists for the known-negative controls
// in the .py: the fold is a CSS clip driven by a measured `maxHeight`, so the
// way it silently degrades is a stylesheet that stops clipping — and a control
// that cannot be expressed as a sheet edit cannot prove the probe would notice.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STYLES = path.join(HERE, '..', 'src', 'styles.css')
const argv = process.argv.slice(2)
const outdir = argv[0]
if (!outdir) {
  console.error('usage: node tests/descfold_build.mjs <outdir> [--subst F]')
  process.exit(2)
}
const opt = (flag) => { const i = argv.indexOf(flag); return i > 0 ? argv[i + 1] : null }

// the checkout is CRLF (.gitattributes); substitutions are written with \n
const read = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
let contents = read(STYLES)
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
  entryPoints: [path.join(HERE, 'descfold-probe.tsx')],
  outfile: path.join(outdir, 'probe.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{
    name: 'descfold-styles-swap',
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]styles\.css$/ }, () => ({
        contents, loader: 'css', resolveDir: path.dirname(STYLES),
      }))
    },
  }],
})
if (!readFileSync(path.join(outdir, 'probe.css'), 'utf8').length) {
  throw new Error('bundle produced an EMPTY probe.css — the sheet was lost, '
    + 'and every measurement would be of an unstyled page')
}
// ⚠ THE PANELS ARE STACKED, NOT OVERLAID. `.overlay` is fixed-position chrome
// in the app; eight of them on one page would sit on top of each other and
// every panel but the last would measure as hidden. The frame below is the
// only style this page adds, and it changes nothing the fold depends on:
// widths and line-heights come from the real sheet.
const FRAME = `
html, body { margin: 0; background: var(--bg); }
/* ONE SLOT PER PANEL, EACH ITS OWN CONTAINING BLOCK. The overlay and the msgs
   scroller are fixed/absolute chrome in the app; eight of them stacked on one
   page overlap, and a panel covered by the next one measures as unhittable —
   a fault of the page, not of the feature. A relative slot keeps every
   absolutely-positioned child inside its own panel. */
.probe-slot { position: relative; margin: 0 0 60px; isolation: isolate; }
.probe-slot > .overlay { position: static; }
.probe-slot > .msgs { position: static; height: auto; width: 620px; }
.settings.wide.docket-modal { width: 620px; max-width: 620px; }
`
writeFileSync(path.join(outdir, 'probe.html'),
  '<!doctype html><html><head><meta charset="utf-8">'
  + '<link rel="stylesheet" href="probe.css">'
  + `<style>${FRAME}</style></head>`
  + '<body><div id="root"></div><script src="probe.js"></script></body></html>')
console.log(`descfold_build: bundled${subst ? ' (subst=' + subst + ')' : ''} into ${outdir}`)
