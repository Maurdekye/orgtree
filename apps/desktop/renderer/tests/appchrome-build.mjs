// appchrome-build.mjs — bundle appchrome-fixture.tsx for appchrome_probe.py.
// Usage: node apps/desktop/renderer/tests/appchrome-build.mjs <outdir>
import * as esbuild from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.resolve(process.argv[2] ?? path.join(here, '..', '..', '..', '..', 'artifacts', 'appchrome-bundle'))
mkdirSync(out, { recursive: true })
await esbuild.build({
  entryPoints: [path.join(here, 'appchrome-fixture.tsx')], outdir: out,
  bundle: true, format: 'esm', jsx: 'automatic', logLevel: 'warning',
  loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"' },
})
writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8">'
  + '<link rel="stylesheet" href="/appchrome-fixture.css">'
  + '<body class="contrast-charcoal"><div id="root"></div>'
  + '<script type="module" src="/appchrome-fixture.js"></script></body>')
console.log(out)
