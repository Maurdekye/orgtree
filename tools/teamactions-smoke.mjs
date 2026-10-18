// One focused renderer file or one synthetic capture, without dependency installs.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [deps, output, mode] = process.argv.slice(2)
if (!deps || !output || !/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(path.resolve(output))) throw Error('Expected provisioned dependencies and assigned C output')
const require = createRequire(path.join(path.resolve(deps), 'package.json'))
const esbuild = require('esbuild')
fs.mkdirSync(output, { recursive: true })
const visual = mode?.startsWith('visual')
try {
  await esbuild.build({ entryPoints: [path.join(repo, 'apps/desktop/renderer/tests', visual ? 'teamactions-visual.tsx' : 'teamactions.test.tsx')],
    outfile: path.join(output, visual ? 'fixture.js' : 'test.mjs'), bundle: true, format: 'esm', platform: visual ? 'browser' : 'node',
    target: 'node22', jsx: 'automatic', nodePaths: [path.join(path.resolve(deps), 'node_modules')], external: ['node:*'],
    plugins: [{ name: 'external-jsdom', setup(build) { build.onResolve({ filter: /^jsdom$/ }, () => ({ path: pathToFileURL(require.resolve('jsdom')).href, external: true })) } }],
    define: { 'process.env.NODE_ENV': '"development"', __SRC_DIR__: JSON.stringify(path.join(repo, 'apps/desktop/renderer/src')) } })
} finally { esbuild.stop() }
let command, args, env = { ...process.env }
if (visual) {
  const css = pathToFileURL(path.join(repo, 'apps/desktop/renderer/src/styles.css')).href
  fs.writeFileSync(path.join(output, 'fixture.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${css}"><style>html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font:14px system-ui}.desk-bare{height:100%}</style></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>`)
  command = require('electron'); args = [path.join(repo, 'apps/desktop/renderer/tests/teamactions-capture.cjs')]
  delete env.ELECTRON_RUN_AS_NODE
  env.TEAM_CAPTURE_ROOT = path.resolve(output)
} else {
  command = process.execPath; args = ['--max-old-space-size=1024', '--test', '--test-reporter=tap', '--test-force-exit', '--test-concurrency=1', '--test-timeout=10000', path.join(output, 'test.mjs')]
}
const result = spawnSync(command, args, { cwd: repo, env, encoding: 'utf8', windowsHide: true })
fs.writeFileSync(path.join(output, 'result.log'), `${result.stdout || ''}${result.stderr || ''}`)
console.log(result.stdout || ''); console.error(result.stderr || '')
fs.writeFileSync(path.join(output, 'process.json'), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message }, null, 2))
process.exitCode = result.status ?? 1
