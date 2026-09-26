import { build as bundle } from 'esbuild'
import { build as renderer } from 'vite'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { PRIVATE_ALPHA_VERSION } from './private-alpha-policy.mjs'

// THE UPDATE FIXTURE IS A PROPERTY OF THE BUILD, NOT OF ITS METADATA.
// `--update-fixture` (or ORGTREE_BUILD_UPDATE_FIXTURE=1) compiles the harmless
// dual-entry update fixture's substitution INTO the main bundle; every other
// build compiles the ':disabled' marker in and cannot perform a substitution
// however its environment or the files beside it are edited. See
// update-fixture.ts for why
// a build-info flag was rejected as the guard: a reviewer's probe showed
// release-channel metadata carrying the flag passes both the capability reader
// and the real release provenance validator, which makes "we never write it" a
// default rather than an exclusion. Editing the bundle instead is caught by the
// sha256 of dist/main/index.cjs recorded below.
const updateFixture = process.argv.includes('--update-fixture')
  || process.env.ORGTREE_BUILD_UPDATE_FIXTURE === '1'
const privateAlpha = process.argv.includes('--private-alpha')
if (privateAlpha && updateFixture) throw new Error('Private alpha cannot include the update fixture')
if (updateFixture) {
  console.log('⚠ building WITH the update-fixture substitution compiled in. '
    + 'This build must not be published: the release preflight refuses it.')
}
await bundle({ entryPoints: ['apps/desktop/main/index.ts'], outfile: 'dist/main/index.cjs',
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true,
  // The WHOLE marker string, not a boolean: see update-fixture.ts. A boolean
  // left the preflight's bundle scan depending on dead-code elimination, and the
  // test that measured that FAILED — esbuild kept the eliminated branch's
  // literal. Substituting the marker itself needs no elimination.
  define: { __ORGTREE_PRIVATE_ALPHA__: JSON.stringify(
    'ORGTREE-PRIVATE-ALPHA-BUILD:' + (privateAlpha ? 'enabled' : 'disabled')),
    __ORGTREE_UPDATE_FIXTURE__: JSON.stringify(
    'ORGTREE-UPDATE-FIXTURE-BUILD:' + (updateFixture ? 'enabled' : 'disabled')) } })
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
let commit = null, dirty = null, mailhubCommit = null
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  dirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim()
} catch { /* Development source archives can build; release preflight requires provenance. */ }
try {
  // release provenance records BOTH repositories: this one and the exact
  // orgtree-mailhub revision the pinned submodule ships (mail-hub ticket)
  mailhubCommit = execFileSync('git', ['-C', 'engine/mailhub', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch { /* preflight fails the package when the submodule is absent. */ }
const files = ['dist/main/index.cjs', 'dist/preload/index.cjs', 'dist/renderer/index.html',
  ...fs.readdirSync('dist/renderer/assets').map(name => 'dist/renderer/assets/' + name),
  'engine/launch.py', 'engine/mailhub/mailhub/app.py', 'engine/mailhub/mailhub/serve.py',
  'engine/runtime/python.exe', 'engine/runtime/python313._pth', 'engine/runtime/runtime-manifest.json',
  'engine/postgres-runtime-manifest.json', 'engine/pg-custodian.exe', 'tools/pypg/pgimport.py']
// Every build starts as the release channel; `npm run package:dev` rewrites
// this file with channel 'dev' and a commit-stamped version before packing.
// Rebuilding always resets it, so a development stamp cannot leak forward into
// a release package — and the release preflight refuses it if one ever does.
// `updateFixture` here is a DISCLOSURE, never the guard — the guard is the
// constant compiled into index.cjs above. It is written so a fixture-capable
// artifact says so about itself and so the release preflight can refuse to
// package one; nothing at runtime reads it.
fs.writeFileSync('dist/build-info.json', JSON.stringify({ version: privateAlpha ? PRIVATE_ALPHA_VERSION : JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
  channel: privateAlpha ? 'private-alpha' : 'release', commit, dirty, mailhubCommit, builtAt: new Date().toISOString(),
  ...(updateFixture ? { updateFixture: true } : {}),
  sha256: Object.fromEntries(files.filter(file => fs.existsSync(file)).map(file => [file, hash(file)])) }, null, 2) + '\n')
