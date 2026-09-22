// Isolated Electron evidence; a fresh directory on every run, never live data.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const parent = path.resolve(process.argv[2] ?? '.probe-reload')
fs.mkdirSync(parent, { recursive: true })
const root = fs.mkdtempSync(path.join(parent, 'run-'))
// Deliberate negative controls transform only this disposable test bundle.
// Shipping source files remain untouched, and every result names its control.
const control = process.env.RELOAD_PROBE_CONTROL ?? ''
const controls = {
  'no-suspension': ['window-event-lifecycle.ts', 'record.outbox.suspend()', 'void 0'],
  'forget-cancelled-listener': ['window-event-lifecycle.ts', 'record.outbox.suspend()', 'record.outbox.suspend(); record.outbox.rearm()'],
  'error-finish-is-success': ['window-load-recovery.ts', 'if (committed) recovery.onLoadFinished(currentUrl())', 'recovery.onLoadFinished(currentUrl())'],
}
if (control && !controls[control]) throw new Error('Unknown reload probe control: ' + control)
const plugins = !control ? [] : [{ name: 'reload-negative-control', setup(build) {
  const [name, before, after] = controls[control]
  build.onLoad({ filter: /window-(event-lifecycle|load-recovery)\.ts$/ }, async args => {
    if (path.basename(args.path) !== name) return
    const source = fs.readFileSync(args.path, 'utf8')
    if (!source.includes(before)) throw new Error('Control no longer matches production source')
    return { contents: source.replace(before, after), loader: 'ts', resolveDir: path.dirname(args.path) }
  })
} }]
for (const sub of ['data', 'home']) fs.mkdirSync(path.join(root, sub))
for (const [entry, name] of [
  ['apps/desktop/preload/index.ts', 'preload'],
  ['tests/window-reload.probe.ts', 'main'],
]) {
  await build({ entryPoints: [entry], outfile: path.join(root, name + '.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], plugins })
}
const env = { ...process.env, PROBE_ROOT: root, ORGTREE_DATA: path.join(root, 'data'), HOME: path.join(root, 'home') }
delete env.ELECTRON_RUN_AS_NODE
const run = spawnSync(createRequire(import.meta.url)('electron'), [path.join(root, 'main.cjs')],
  { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
const resultFile = path.join(root, 'result.json')
const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null
console.log(JSON.stringify({ root, control, exit: run.status, signal: run.signal, error: run.error?.message, result }, null, 2))
if (run.status !== 0 || !result?.ok) {
  console.error(run.stderr?.slice(-4000))
  process.exitCode = 1
}
