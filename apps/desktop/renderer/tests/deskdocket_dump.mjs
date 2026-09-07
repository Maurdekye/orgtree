// deskdocket_dump.mjs — bundles + runs `deskdocket.dump.tsx`, the same recipe
// docket_dump.mjs uses. Step 1 of the two-step `deskdocket_layout_probe.py`;
// kept out of the `*.test.tsx` glob because a dump proves nothing on its own.
//
//   node tests/deskdocket_dump.mjs <out.html> [empty]

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(HERE, '..', 'node_modules', '.orgtree-deskdocketdump')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await esbuild.build({
  entryPoints: [path.join(HERE, 'deskdocket.dump.tsx')],
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
  console.error('usage: node tests/deskdocket_dump.mjs <out.html> [empty]')
  process.exit(2)
}
execFileSync(process.execPath,
  [path.join(out, 'deskdocket.dump.mjs'), ...process.argv.slice(2)],
  { stdio: 'inherit' })
