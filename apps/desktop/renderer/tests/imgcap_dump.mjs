// imgcap_dump.mjs — bundles + runs `imgcap.dump.tsx`.
//
// Same esbuild recipe acctcols_dump.mjs uses (jsx automatic, output under
// node_modules so bare specifiers resolve). Kept OUT of the `*.test.tsx` glob
// on purpose: this is step 1 of a two-step probe and proves nothing alone.

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(HERE, '..', 'node_modules', '.orgtree-imgcap')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await esbuild.build({
  entryPoints: [path.join(HERE, 'imgcap.dump.tsx')],
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  jsx: 'automatic',
  sourcemap: 'inline',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
  // ⚠ packages:'external' rather than a hand-listed external[]. react-dom's
  // server build does `require('stream')`, and bundling it into ESM turns
  // that into esbuild's dynamic-require shim, which throws at run time. Node
  // resolves these itself from the real node_modules; only OUR src is bundled,
  // which is the part that has to be the live component.
  packages: 'external',
})

const dest = process.argv[2]
if (!dest) {
  console.error('usage: node tests/imgcap_dump.mjs <out.html>')
  process.exit(2)
}
execFileSync(process.execPath, [path.join(out, 'imgcap.dump.mjs'), dest],
  { stdio: 'inherit' })
