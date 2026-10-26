// Runs tests/apppanel-popout-native.probe.ts in real Electron windows: the app
// panel popped out through the product's window-open path, measured against
// its window before and after a resize, and photographed.
//
//   node tools/test-apppanel-popout-native.mjs [--css-from <rev>] [--shots <dir>]
//
// --css-from bundles apps.css as it was at <rev> (`git show`), the red control
// for a fix in that file; nothing in the checkout changes. --shots is where the
// screenshots and the receipt go (default: the temp root printed on exit). A
// worktree without node_modules names the dependency checkout's package.json
// in ORGTREE_TEST_DEPS. Windows Session 0 only: the probe refuses elsewhere.
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] ?? null }
const cssFrom = option('--css-from')
const deps = createRequire(process.env.ORGTREE_TEST_DEPS || import.meta.url)
const { build } = deps('esbuild')
const nodeModules = path.dirname(path.dirname(deps.resolve('esbuild/package.json')))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-apppanel-'))
const shots = path.resolve(option('--shots') || root)
fs.mkdirSync(shots, { recursive: true })

const APPS_CSS = 'apps/desktop/renderer/src/canvas/apps/apps.css'
const plugins = cssFrom ? [{ name: 'apps-css-from-rev', setup(b) {
  b.onLoad({ filter: /[\\/]canvas[\\/]apps[\\/]apps\.css$/ }, () => ({
    contents: execFileSync('git', ['show', `${cssFrom}:${APPS_CSS}`], { cwd: repo, encoding: 'utf8' }), loader: 'css' }))
} }] : []
// What main.tsx loads, in its order: the app panel (and its apps.css) before
// styles.css and shell.css, with the theme applied as at startup.
const harness = `
import { createRoot } from 'react-dom/client'
import { AppsWorkspace } from './apps/desktop/renderer/src/canvas/apps/ui'
import './apps/desktop/renderer/src/styles.css'
import './apps/desktop/renderer/src/shell.css'
import { startThemeSync } from './apps/desktop/renderer/src/themes'
startThemeSync()
createRoot(document.getElementById('root')).render(<AppsWorkspace slug="demo" />)
`
await build({ stdin: { contents: harness, loader: 'tsx', resolveDir: repo }, outfile: path.join(root, 'fixture.js'),
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [nodeModules], plugins,
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' })
await build({ entryPoints: [path.join(repo, 'tests/apppanel-popout-native.probe.ts')], outfile: path.join(root, 'probe.cjs'),
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], nodePaths: [nodeModules], logLevel: 'warning' })

const env = { ...process.env, ORGTREE_APPPANEL_ROOT: root, ORGTREE_APPPANEL_SHOTS: shots,
  ORGTREE_APPPANEL_LABEL: cssFrom ? `css-${cssFrom.replace(/[^\w.-]/g, '_')}` : 'tip' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(deps('electron'), [path.join(root, 'probe.cjs')], { stdio: 'inherit', windowsHide: true, env })
// The probe holds its own 60 s deadline; this backstop says so when it fires.
const timer = setTimeout(() => { console.error('app panel popout probe did not exit within 90 s; killing it'); child.kill(); process.exitCode = 1 }, 90000)
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1 })
child.on('exit', code => { clearTimeout(timer); console.log('screenshots and receipt:', shots); process.exitCode = code ?? 1 })
