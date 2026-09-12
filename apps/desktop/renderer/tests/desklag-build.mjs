// Bundle the real transcript fixture for desklag_probe.py, against whichever
// tree this file sits in — that is the whole point: the same probe source is
// built against v2.0.9 and against the branch under test, so the two runs
// differ only in the product code they pull in.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const out = process.argv[2]
if (!out) { console.error('usage: node tests/desklag-build.mjs <outdir>'); process.exit(2) }
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
await esbuild.build({
  entryPoints: [path.join(HERE, 'desklag-probe.tsx')],
  outfile: path.join(out, 'probe.js'), bundle: true, platform: 'browser',
  format: 'iife', jsx: 'automatic', logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
})
writeFileSync(path.join(out, 'probe.css'), readFileSync(path.join(HERE, '..', 'src', 'styles.css')))
writeFileSync(path.join(out, 'probe.html'), '<!doctype html><meta charset="utf-8">'
  + '<link rel="stylesheet" href="probe.css">'
  + '<body class="contrast-charcoal"><div id="root"></div>'
  + '<script src="probe.js"></script></body>')
