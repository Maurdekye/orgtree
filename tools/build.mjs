import { build as bundle } from 'esbuild'
import { build as renderer } from 'vite'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

await bundle({ entryPoints: ['apps/desktop/main/index.ts'], outfile: 'dist/main/index.cjs',
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true })
await bundle({ entryPoints: ['apps/desktop/preload/index.ts'], outfile: 'dist/preload/index.cjs',
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true })
// Absolute, not relative: the backend serves this SAME index.html for every
// client-routed path (`/`, `/o/<org>`, ...) via its SPA catch-all. A relative
// base resolves "./assets/..." against whatever deep path the document was
// actually loaded from, so a reload from `/o/<org>` requests
// "/o/assets/index-*.js" — unmatched by the top-level `/assets` mount, so the
// catch-all answers with index.html's own text/html instead of the module
// script, and the app never boots (visible bug: Refresh on an open org turns
// the window white until the app is closed and reopened back to `/`).
await renderer({ root: 'apps/desktop/renderer', base: '/',
  build: { outDir: path.resolve('dist/renderer'), emptyOutDir: true } })
// The favicon is also used by the packaged UI. Keep one SVG source beside the
// Windows ICO and copy it into Vite's output rather than maintaining a duplicate.
fs.mkdirSync('dist/renderer/assets', { recursive: true })
fs.copyFileSync('apps/desktop/assets/orgtree-eye.svg', 'dist/renderer/assets/orgtree-eye.svg')

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
let commit = null, dirty = null
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  dirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim()
} catch { /* Development source archives can build; release preflight requires provenance. */ }
const files = ['dist/main/index.cjs', 'dist/preload/index.cjs', 'dist/renderer/index.html',
  ...fs.readdirSync('dist/renderer/assets').map(name => 'dist/renderer/assets/' + name),
  'engine/launch.py', 'engine/runtime/python.exe', 'engine/runtime/python313._pth', 'engine/runtime/runtime-manifest.json']
// Every build starts as the release channel; `npm run package:dev` rewrites
// this file with channel 'dev' and a commit-stamped version before packing.
// Rebuilding always resets it, so a development stamp cannot leak forward into
// a release package — and the release preflight refuses it if one ever does.
fs.writeFileSync('dist/build-info.json', JSON.stringify({ version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
  channel: 'release', commit, dirty, builtAt: new Date().toISOString(), sha256: Object.fromEntries(files.filter(file => fs.existsSync(file)).map(file => [file, hash(file)])) }, null, 2) + '\n')
