// docketname_dump.mjs — bundles + runs `docketname.dump.tsx`.
//
// Same esbuild recipe run.mjs uses (jsx automatic, jsdom external, output
// under node_modules so bare specifiers resolve). Kept OUT of the `*.test.tsx`
// glob on purpose: the dump is step 1 of a two-step probe and proves nothing
// on its own, so it must not sit in the suite looking like a passing test.

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(HERE, '..', 'node_modules', '.orgtree-docketname')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await esbuild.build({
  entryPoints: [path.join(HERE, 'docketname.dump.tsx')],
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
  console.error('usage: node tests/docketname_dump.mjs <out.html>')
  process.exit(2)
}
execFileSync(process.execPath, [path.join(out, 'docketname.dump.mjs'), dest],
  { stdio: 'inherit' })
