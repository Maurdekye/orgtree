// picker_dump.mjs — bundles + runs `picker.dump.tsx` (the xai_dump.mjs
// recipe, 2026-09-03). Step 1 of the two-step `picker_probe.py`; kept out of
// the `*.test.tsx` glob because a dump proves nothing on its own.
//
//   node tests/picker_dump.mjs <out.html>

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(HERE, '..', 'node_modules', '.orgtree-picker')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await esbuild.build({
  entryPoints: [path.join(HERE, 'picker.dump.tsx')],
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  jsx: 'automatic',
  sourcemap: 'inline',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
  external: ['jsdom', 'node:*'],
})

const dest = process.argv[2]
if (!dest) {
  console.error('usage: node tests/picker_dump.mjs <out.html>')
  process.exit(2)
}
execFileSync(process.execPath,
  [path.join(out, 'picker.dump.mjs'), ...process.argv.slice(2)],
  { stdio: 'inherit' })
