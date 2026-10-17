// Focused renderer proof without dependency installs, copies or junctions.
// Run under the team's build lock: node tools/helper-transcript-smoke.mjs
// <provisioned checkout> <C:/orgtree-build/helper-transcript-sol/...> [visual]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [deps, output, mode] = process.argv.slice(2)
if (!deps || !output || !/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(path.resolve(output))) throw new Error('Provide dependency checkout and assigned C output subdirectory')
const require = createRequire(path.join(path.resolve(deps), 'package.json'))
const esbuild = require('esbuild')
fs.mkdirSync(output, { recursive: true })
const visual = mode === 'visual' || mode === 'visual-before'
const entry = path.join(repo, 'apps/desktop/renderer/tests', visual ? 'helpertranscript-visual.tsx' : 'helpertranscript.test.tsx')
const controls = mode === 'test-controls'
const controlEntries = ['helpertranscript', 'toolclock-turn', 'toolclock-live', 'foldpersist']
try {
  await esbuild.build({ entryPoints: controls ? controlEntries.map(name => path.join(repo, 'apps/desktop/renderer/tests', name + '.test.tsx')) : [entry],
    ...(controls ? { outdir: output, outExtension: { '.js': '.mjs' } } : { outfile: path.join(output, visual ? 'fixture.js' : 'test.mjs') }), bundle: true,
    format: 'esm', platform: visual ? 'browser' : 'node', target: 'node22', jsx: 'automatic',
    nodePaths: [path.join(path.resolve(deps), 'node_modules')], external: ['node:*'],
    plugins: [{ name: 'external-jsdom', setup(build) { build.onResolve({ filter: /^jsdom$/ }, () => ({ path: pathToFileURL(require.resolve('jsdom')).href, external: true })) } },
      ...(visual && mode === 'visual-before' ? [{ name: 'before-helper-ui', setup(build) {
        build.onLoad({ filter: /[\\/]canvas[\\/]desk\.tsx$/ }, () => {
          const old = spawnSync('git', ['show', '0498bbc:apps/desktop/renderer/src/canvas/desk.tsx'], { cwd: repo, encoding: 'utf8', windowsHide: true })
          if (old.status !== 0) throw new Error(old.stderr || 'Cannot read before-UI source')
          return { contents: old.stdout, loader: 'tsx', resolveDir: path.join(repo, 'apps/desktop/renderer/src/canvas') }
        })
      } }] : [])],
    define: { 'process.env.NODE_ENV': '"development"', __SRC_DIR__: JSON.stringify(path.join(repo, 'apps/desktop/renderer/src')) } })
} finally { esbuild.stop() }
let command, args, env = { ...process.env }
if (visual) {
  const css = pathToFileURL(path.join(repo, 'apps/desktop/renderer/src/styles.css')).href
  fs.writeFileSync(path.join(output, 'fixture.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${css}"><style>body{background:var(--bg);color:var(--text);font:14px system-ui}</style></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>`)
  command = require('electron'); args = [path.join(repo, 'apps/desktop/renderer/tests/helpertranscript-capture.cjs')]
  delete env.ELECTRON_RUN_AS_NODE
  env.HELPER_CAPTURE_ROOT = path.resolve(output)
} else { command = process.execPath; args = ['--max-old-space-size=1024', '--test', '--test-reporter=tap', '--test-force-exit', '--test-concurrency=1', '--test-timeout=10000',
  ...(controls ? controlEntries.map(name => path.join(output, name + '.test.mjs')) : [path.join(output, 'test.mjs')])] }
const result = spawnSync(command, args, { cwd: repo, env, encoding: 'utf8', windowsHide: true })
fs.writeFileSync(path.join(output, 'result.log'), `${result.stdout || ''}${result.stderr || ''}`)
console.log(result.stdout || ''); console.error(result.stderr || '')
fs.writeFileSync(path.join(output, 'process.json'), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message }, null, 2))
process.exitCode = result.status ?? 1
