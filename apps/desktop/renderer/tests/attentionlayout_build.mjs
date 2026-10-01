// attentionlayout_build.mjs — bundles `attentionlayout-probe.tsx` (the real
// OrgCanvas, AttentionView and App settings from ../src, CSS in main.tsx's
// order) into a browser page for `attentionlayout_probe.py`.
//
//   node tests/attentionlayout_build.mjs <outdir> [entry.tsx]
//
// The optional second argument bundles another probe page the same way
// (orgsubmenu_probe.py uses it for orgsubmenu-probe.tsx).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const outdir = process.argv[2]
if (!outdir) {
  console.error('usage: node tests/attentionlayout_build.mjs <outdir>')
  process.exit(2)
}
rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })
await esbuild.build({
  entryPoints: [path.join(HERE, process.argv[3] || 'attentionlayout-probe.tsx')],
  outfile: path.join(outdir, 'probe.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  logLevel: 'warning',
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
})
writeFileSync(path.join(outdir, 'probe.html'),
  '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="probe.css">'
  + '<body class="contrast-charcoal"><div id="root"></div><script src="probe.js"></script></body>')
