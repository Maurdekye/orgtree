// palette_dump.mjs — bundles + runs `palette.dump.tsx` (the xai_dump.mjs
// recipe, 2026-09-03). Step 2 of the three-step `palette_probe.py`, which
// first mints the palette with the backend and hands it over as JSON; kept
// out of the `*.test.tsx` glob because a dump proves nothing on its own.
//
//   node tests/palette_dump.mjs <out.html> <palette.json>

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(HERE, '..', 'node_modules', '.orgtree-palette')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await esbuild.build({
  entryPoints: [path.join(HERE, 'palette.dump.tsx')],
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

const [dest, json] = process.argv.slice(2)
if (!dest || !json) {
  console.error('usage: node tests/palette_dump.mjs <out.html> <palette.json>')
  process.exit(2)
}
execFileSync(process.execPath,
  [path.join(out, 'palette.dump.mjs'), ...process.argv.slice(2)],
  { stdio: 'inherit' })
