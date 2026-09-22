// Whole shipping App in isolated Electron; no engine, installed app or live data.
// Controls remove one production mechanism at build/IPC binding time. They must
// fail the SAME visible assertion that the unchanged production path passes.
import { build } from 'esbuild'
import { spawnSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? '.probe-app-composition')
const mode = process.argv[3] ?? 'baseline'
if (!['baseline', 'no-bus', 'no-readiness', 'no-lifecycle', 'no-compact-header'].includes(mode)) throw Error('Unknown control')
// Never recursively delete a caller's directory. A run owns a fresh child.
fs.mkdirSync(root, { recursive: true })
const run = fs.mkdtempSync(path.join(root, mode + '-'))
for (const name of ['home', 'data']) fs.mkdirSync(path.join(run, name))
const common = { bundle: true, logLevel: 'warning' }
await build({ ...common, entryPoints: ['apps/desktop/preload/index.ts'],
  outfile: path.join(run, 'preload.cjs'), format: 'cjs', platform: 'node', external: ['electron'] })
await build({ ...common, entryPoints: ['tests/app-composition.probe.ts'],
  outfile: path.join(run, 'main.cjs'), format: 'cjs', platform: 'node', external: ['electron'] })
await build({ ...common, entryPoints: ['apps/desktop/renderer/src/main.tsx'],
  outfile: path.join(run, 'app.js'), platform: 'browser', format: 'iife', jsx: 'automatic',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
  // Match the production React build used by Vite in tools/build.mjs.
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: mode === 'no-bus' ? [{ name: 'remove-production-bus-start', setup(b) {
    b.onLoad({ filter: /renderer[\\/]src[\\/]main\.tsx$/ }, async ({ path: file }) => {
      const source = fs.readFileSync(file, 'utf8')
      if (!source.includes('\nstartHeldEvents()')) throw Error('Control no longer matches shipping startup')
      return { contents: source.replace('\nstartHeldEvents()', '\n/* negative control: bus start removed */'), loader: 'tsx' }
    })
  } }] : mode === 'no-compact-header' ? [{ name: 'remove-compact-header', setup(b) {
    b.onLoad({ filter: /renderer[\\/]src[\\/]shell\.css$/ }, async ({ path: file }) => {
      const source = fs.readFileSync(file, 'utf8')
      const rule = /@container shellheader \(max-width: 760px\) \{[\s\S]*?\r?\n\}/
      if (!rule.test(source)) throw Error('Control no longer matches compact header repair')
      return { contents: source.replace(rule, '/* negative control: compact header removed */'), loader: 'css' }
    })
  } }] : [] })
fs.writeFileSync(path.join(run, 'app.html'), `<!doctype html><html><head><meta charset="utf-8"><title>App composition fixture</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script>window.__APP_PROBE_DOC=crypto.randomUUID();window.__APP_PROBE_ERRORS=[];addEventListener('error',e=>window.__APP_PROBE_ERRORS.push(String(e.error?.stack||e.message)));addEventListener('unhandledrejection',e=>window.__APP_PROBE_ERRORS.push(String(e.reason?.stack||e.reason)))</script><script src="/app.js"></script></body></html>`)
fs.writeFileSync(path.join(run, 'source.json'), JSON.stringify({
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  status: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }), mode,
  entry: 'apps/desktop/renderer/src/main.tsx',
}, null, 2))
const env = { ...process.env, PROBE_ROOT: run, PROBE_MODE: mode,
  ORGTREE_DATA: path.join(run, 'data'), HOME: path.join(run, 'home') }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(createRequire(import.meta.url)('electron'), [path.join(run, 'main.cjs')],
  { env, encoding: 'utf8', timeout: 240000, windowsHide: true })
fs.writeFileSync(path.join(run, 'electron.stdout.log'), result.stdout ?? '')
fs.writeFileSync(path.join(run, 'electron.stderr.log'), result.stderr ?? '')
const file = path.join(run, 'result.json')
console.log('Artifacts: ' + run)
if (!fs.existsSync(file)) {
  console.error('No result: ', result.status, result.signal, result.error, result.stderr)
  process.exitCode = 1
} else {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = result.status === 0 && report.summary.failing === 0 ? 0 : 1
}
