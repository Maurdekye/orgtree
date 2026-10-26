// tools/rig/app-background-ui.mjs <out> <deps node_modules>: build THIS
// worktree's production renderer (for `rig run ... ui`) and the desktop panel
// CPU sampler for the background-panels capture
// (tools/rig/proofs/app-background-visual.mjs). esbuild resolves an existing
// dependency install through nodePaths; nothing is linked or copied.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const [outArg, depsArg] = process.argv.slice(2)
if (!outArg || !depsArg) throw Error('usage: app-background-ui.mjs <empty output folder> <node_modules>')
const out = path.resolve(outArg), deps = path.resolve(depsArg)
if (out === repo || out.startsWith(repo + path.sep)) throw Error('the output folder must be outside the source')
if (fs.existsSync(out) && fs.readdirSync(out).length) throw Error('use an empty output folder')
const esbuild = createRequire(path.join(deps, '_resolve.cjs'))('esbuild')
const ui = path.join(out, 'ui'), sampler = path.join(out, 'panel-runtime.cjs')
try {
  await esbuild.build({ entryPoints: [path.join(repo, 'apps/desktop/renderer/src/main.tsx')], outdir: ui,
    bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', nodePaths: [deps],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning',
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } })
  // The shipping main-process sampler, run by the capture's Electron main.
  await esbuild.build({ entryPoints: [path.join(repo, 'apps/desktop/main/panel-runtime.ts')], outfile: sampler,
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], nodePaths: [deps], logLevel: 'warning' })
} finally { esbuild.stop() }
const html = fs.readFileSync(path.join(repo, 'apps/desktop/renderer/index.html'), 'utf8')
if (!html.includes('<script type="module" src="/src/main.tsx"></script>')) throw Error('renderer index.html entry changed')
fs.writeFileSync(path.join(ui, 'index.html'), html.replace('<script type="module" src="/src/main.tsx"></script>',
  '<link rel="stylesheet" href="/main.css"><script type="module" src="/main.js"></script>'))
fs.mkdirSync(path.join(ui, 'assets'), { recursive: true })
fs.copyFileSync(path.join(repo, 'apps/desktop/assets/orgtree-eye.svg'), path.join(ui, 'assets', 'orgtree-eye.svg'))
console.log(JSON.stringify({ ui, sampler }))
