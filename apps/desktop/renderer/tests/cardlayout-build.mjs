// Bundle the real NodeSquare browser fixture for cardlayout_probe.py.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const out = process.argv[2]
if (!out) { console.error('usage: node tests/cardlayout-build.mjs <outdir>'); process.exit(2) }
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
await esbuild.build({
  entryPoints: [path.join(HERE, 'cardlayout-probe.tsx')],
  outfile: path.join(out, 'probe.js'), bundle: true, platform: 'browser',
  format: 'iife', jsx: 'automatic', logLevel: 'warning',
})
writeFileSync(path.join(out, 'probe.css'), readFileSync(path.join(HERE, '..', 'src', 'styles.css')))
writeFileSync(path.join(out, 'probe.html'), '<!doctype html><meta charset="utf-8">'
  + '<link rel="stylesheet" href="probe.css"><body><div id="root"></div>'
  + '<script src="probe.js"></script></body>')
