// modalpin_build.mjs — bundles `modalpin-probe.tsx` (the REAL DocGalleryModal
// and PinFrame from ../src, the real styles.css) into a browser page for
// `modalpin_probe.py`. Step 1 of that two-step probe; kept out of the
// `*.test.tsx` glob because a bundle proves nothing on its own.
//
//   node tests/modalpin_build.mjs <outdir>
//   node tests/modalpin_build.mjs <outdir> --subst SUBST.json
//
// `--subst` applies an exact-match substitution list to sources on the way
// into the bundle — the probe's mutants, which must each make the probe FAIL.
// Each entry is {file, old, new} where `file` is repo-relative from frontend/
// (e.g. "src/canvas/modalpin.tsx" or "src/styles.css"): the CSS half matters
// here because half of what this probe measures — no backdrop, clicks falling
// through, a title bar that stays put while the panel scrolls — is CSS, and a
// mutant that could only touch the TSX would leave those checks unattacked.
// Nothing is written to disk: the swap happens in esbuild's load hook.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND = path.join(HERE, '..')
const argv = process.argv.slice(2)
const outdir = argv[0]
if (!outdir) {
  console.error('usage: node tests/modalpin_build.mjs <outdir> [--subst F]')
  process.exit(2)
}
const opt = (flag) => { const i = argv.indexOf(flag); return i > 0 ? argv[i + 1] : null }

// the checkout is CRLF (.gitattributes); substitutions are written with \n
const read = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
/** file (absolute, normalised) -> patched contents */
const patched = new Map()
const subst = opt('--subst')
if (subst) {
  for (const { file, old, new: nu } of JSON.parse(readFileSync(subst, 'utf8'))) {
    const abs = path.join(FRONTEND, file)
    const cur = patched.get(abs) ?? read(abs)
    const n = cur.split(old).length - 1
    if (n !== 1) {
      console.error(`substitution matched ${n} times in ${file}, expected exactly 1: `
        + JSON.stringify(old))
      process.exit(3)
    }
    patched.set(abs, cur.replace(old, nu))
  }
}

rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })
await esbuild.build({
  entryPoints: [path.join(HERE, 'modalpin-probe.tsx')],
  outfile: path.join(outdir, 'probe.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{
    name: 'modalpin-swap',
    setup(build) {
      if (!patched.size) return
      build.onLoad({ filter: /\.(tsx?|css)$/ }, (args) => {
        const hit = patched.get(path.normalize(args.path))
        if (!hit) return null
        return {
          contents: hit,
          loader: args.path.endsWith('.css') ? 'css' : 'tsx',
          resolveDir: path.dirname(args.path),
        }
      })
    },
  }],
})
writeFileSync(path.join(outdir, 'probe.html'),
  '<!doctype html><html><head><meta charset="utf-8">'
  + '<link rel="stylesheet" href="probe.css"></head>'
  + '<body><div id="root"></div><script src="probe.js"></script></body></html>')
console.log(`modalpin_build: bundled${subst ? ' (subst=' + subst + ')' : ''} into ${outdir}`)
