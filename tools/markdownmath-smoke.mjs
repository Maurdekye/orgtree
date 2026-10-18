// Focused source tests and offline math capture. Dependencies stay outside source.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [deps, output, mode = 'tests'] = process.argv.slice(2)
if (!deps || !/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(path.resolve(output))) throw Error('Expected own C output')
const require = createRequire(path.join(path.resolve(deps), 'package.json'))
const esbuild = require('esbuild')
const visual = mode === 'visual'
const suites = ['markdownmath']
fs.mkdirSync(output, { recursive: true })
try {
  await esbuild.build({ entryPoints: visual ? [path.join(repo, 'apps/desktop/renderer/tests/markdownmath-visual.tsx')]
      : suites.map(s => path.join(repo, `apps/desktop/renderer/tests/${s}.test.ts`)),
    ...(visual ? { outfile: path.join(output, 'fixture.js') } : { outdir: output, outExtension: { '.js': '.mjs' } }),
    bundle: true, format: 'esm', platform: visual ? 'browser' : 'node', target: 'node22', jsx: 'automatic',
    nodePaths: [process.env.MATH_NODE_MODULES, path.join(path.resolve(deps), 'node_modules')].filter(Boolean),
    external: ['node:*'], loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    plugins: [{ name: 'external-jsdom', setup(build) { build.onResolve({ filter: /^jsdom$/ }, () => ({ path: pathToFileURL(require.resolve('jsdom')).href, external: true })) } }],
    define: { 'process.env.NODE_ENV': '"development"', __SRC_DIR__: JSON.stringify(path.join(repo, 'apps/desktop/renderer/src')) } })
} finally { esbuild.stop() }
let command, args, env = { ...process.env }
if (visual) {
  const css = pathToFileURL(path.join(repo, 'apps/desktop/renderer/src/styles.css')).href
  fs.writeFileSync(path.join(output, 'fixture.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><link rel="stylesheet" href="${css}"><style>html,body{margin:0}body{background:var(--bg);color:var(--ink);font:15px system-ui}main{padding:20px}.sample{border:1px solid var(--line);border-radius:8px;padding:12px;max-width:850px}h1{font-size:20px}h2{font-size:15px;color:var(--muted)}</style></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>`)
  command = require('electron'); args = [path.join(repo, 'apps/desktop/renderer/tests/markdownmath-capture.cjs')]
  delete env.ELECTRON_RUN_AS_NODE
  env.MATH_CAPTURE_ROOT = path.resolve(output)
} else {
  command = process.execPath; args = ['--max-old-space-size=1024', '--test', '--test-reporter=tap', '--test-force-exit', '--test-concurrency=1', '--test-timeout=10000', ...suites.map(s => path.join(output, s+'.test.mjs'))]
}
const result = spawnSync(command, args, { cwd: repo, env, encoding: 'utf8', windowsHide: true })
fs.writeFileSync(path.join(output, 'result.log'), `${result.stdout || ''}${result.stderr || ''}`)
console.log(result.stdout || ''); console.error(result.stderr || '')
fs.writeFileSync(path.join(output, 'process.json'), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message }, null, 2))
process.exitCode = result.status ?? 1
