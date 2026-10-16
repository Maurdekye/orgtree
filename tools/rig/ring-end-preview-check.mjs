// Run inside the caller's FIFO lock and kernel Job. Dependencies stay in place.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import path from 'node:path'
import { runDesktop } from './desktop.mjs'
const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '')
const mode = process.argv[2], out = process.argv[3]
if (!['tests', 'visual'].includes(mode) || !out || !/^C:[\\/]orgtree-build[\\/]/i.test(out)) throw Error('tests|visual C:/orgtree-build/<caller>/... required')
const deps = process.env.ORGTREE_DEPENDENCY_ROOT || 'E:/Libraries/Desktop/orgtree/.worktrees/rust-engine/node_modules'
const require = createRequire(path.join(deps, '..', 'package.json')), esbuild = require('esbuild')
fs.mkdirSync(out, { recursive: true })
if (mode === 'tests') {
  const bundle = path.join(out, 'reorderpreview.mjs')
  await esbuild.build({ entryPoints: [root + '/apps/desktop/renderer/tests/reorderpreview.test.tsx'], outfile: bundle,
    bundle: true, format: 'esm', platform: 'node', target: 'node22', jsx: 'automatic', nodePaths: [deps], external: ['node:*'],
    define: { 'process.env.NODE_ENV': '"development"', __SRC_DIR__: JSON.stringify(root + '/apps/desktop/renderer/src') },
    plugins: [{ name: 'jsdom-in-place', setup(build) { build.onResolve({ filter: /^jsdom$/ }, () => ({ path: pathToFileURL(require.resolve('jsdom')).href, external: true })) } }] })
  esbuild.stop()
  const p = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-timeout=10000', bundle], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024 })
  fs.writeFileSync(path.join(out, 'tests.log'), (p.stdout || '') + (p.stderr || ''))
  console.log(p.stdout, p.stderr); if (p.error) throw p.error
  process.exitCode = p.status ?? 1
} else {
  await esbuild.build({ entryPoints: [root + '/apps/desktop/renderer/tests/ring-end-preview-probe.tsx'], outfile: path.join(out, 'probe.js'),
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', nodePaths: [deps] })
  esbuild.stop()
  const server = createServer((req, res) => {
    if (new URL(req.url, 'http://localhost').pathname === '/probe.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(out, 'probe.js'))); return }
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0}</style><div id="root"></div><script src="/probe.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const result = await runDesktop({ dir: out, url: 'http://127.0.0.1:' + server.address().port, token: '', org: '' },
      root + '/apps/desktop/renderer/tests/ring-end-preview-capture.cjs', { out: path.join(out, 'captures'), profile: path.join(out, 'profile'), preset: '1000x700', timeout: 45000 })
    fs.writeFileSync(path.join(out, 'visual.json'), JSON.stringify(result, null, 2))
    if (!result.ok || result.shots.length !== 4) throw Error(JSON.stringify(result.error ?? result))
    console.log(JSON.stringify({ samples: result.value, shots: result.shots }))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
