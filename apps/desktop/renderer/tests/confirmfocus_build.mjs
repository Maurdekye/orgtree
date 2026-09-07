// confirmfocus_build.mjs — bundles `confirmfocus-probe.tsx` (the REAL
// ConfirmModal from ../src, real styles.css) into a browser page for
// `confirmfocus_probe.py`. Step 1 of that two-step probe; kept out of the
// `*.test.tsx` glob because a bundle proves nothing on its own.
//
//   node tests/confirmfocus_build.mjs <outdir>
//   node tests/confirmfocus_build.mjs <outdir> --source OLD_MODALS.tsx
//   node tests/confirmfocus_build.mjs <outdir> --subst SUBST.json
//
// `--source` swaps in another modals.tsx VERBATIM (the probe uses it to run
// the same page against the committed component from before the patch — the
// red half of red/green). `--subst` applies an exact-match substitution list
// to the current modals.tsx (the probe's mutants). Both leave the file on disk
// untouched: the swap happens inside esbuild's load hook, with the module's
// resolveDir kept at src/canvas so its relative imports still resolve.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODALS = path.join(HERE, '..', 'src', 'canvas', 'modals.tsx')
const argv = process.argv.slice(2)
const outdir = argv[0]
if (!outdir) {
  console.error('usage: node tests/confirmfocus_build.mjs <outdir> [--source F] [--subst F]')
  process.exit(2)
}
const opt = (flag) => { const i = argv.indexOf(flag); return i > 0 ? argv[i + 1] : null }

// the checkout is CRLF (.gitattributes); substitutions are written with \n
const read = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
let contents = read(MODALS)
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
  entryPoints: [path.join(HERE, 'confirmfocus-probe.tsx')],
  outfile: path.join(outdir, 'probe.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{
    name: 'confirmfocus-modals-swap',
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]canvas[\\/]modals\.tsx$/ }, () => ({
        contents, loader: 'tsx', resolveDir: path.dirname(MODALS),
      }))
    },
  }],
})
writeFileSync(path.join(outdir, 'probe.html'),
  '<!doctype html><html><head><meta charset="utf-8">'
  + '<link rel="stylesheet" href="probe.css"></head>'
  + '<body><div id="root"></div><script src="probe.js"></script></body></html>')
console.log(`confirmfocus_build: bundled${source ? ' (source=' + source + ')' : ''}`
  + `${subst ? ' (subst=' + subst + ')' : ''} into ${outdir}`)
