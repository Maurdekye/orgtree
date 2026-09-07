// refchip_build.mjs — bundles `refchip-probe.tsx` (the REAL RefChip from
// ../src, the REAL styles.css) into a browser page for `refchip_probe.py`.
// Step 1 of that two-step probe; kept out of the `*.test.tsx` glob because a
// bundle proves nothing on its own.
//
//   node tests/refchip_build.mjs <outdir>
//   node tests/refchip_build.mjs <outdir> --source OLD_STYLES.css
//   node tests/refchip_build.mjs <outdir> --subst SUBST.json
//
// ⚠ THE SWAPPED FILE IS THE STYLESHEET, not the component. What is on trial
// here is a CASCADE — whether a rule written to beat `.settings button`
// actually beats it — so the red half of red/green is the sheet from BEFORE
// these rules existed, and the mutants are edits to the rules themselves.
//
// ⚠ AND `--source` MUST NAME A COMMIT, NOT `HEAD`. Once this work is
// committed, `git show HEAD:frontend/src/styles.css` IS the new sheet, so a
// control written that way passes and proves nothing. The probe's own default
// baseline is 35e4afa — the tip of main this branch started from, before any
// `.ref-chip` rule was written. (Learned the hard way by checklist-evidence
// on 2026-09-05, whose probe control did exactly this.)
//
// Both leave the file on disk untouched: the swap happens inside esbuild's
// load hook, with the module's resolveDir kept at src so its relative url()
// references still resolve.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STYLES = path.join(HERE, '..', 'src', 'styles.css')
const argv = process.argv.slice(2)
const outdir = argv[0]
if (!outdir) {
  console.error('usage: node tests/refchip_build.mjs <outdir> [--source F] [--subst F]')
  process.exit(2)
}
const opt = (flag) => { const i = argv.indexOf(flag); return i > 0 ? argv[i + 1] : null }

// the checkout is CRLF (.gitattributes); substitutions are written with \n
const read = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
let contents = read(STYLES)
const source = opt('--source')
if (source) contents = read(source)
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
  entryPoints: [path.join(HERE, 'refchip-probe.tsx')],
  outfile: path.join(outdir, 'probe.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{
    name: 'refchip-styles-swap',
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
writeFileSync(path.join(outdir, 'probe.html'),
  '<!doctype html><html><head><meta charset="utf-8">'
  + '<link rel="stylesheet" href="probe.css"></head>'
  + '<body><div id="root"></div><script src="probe.js"></script></body></html>')
console.log(`refchip_build: bundled${source ? ' (source=' + source + ')' : ''}`
  + `${subst ? ' (subst=' + subst + ')' : ''} into ${outdir}`)
