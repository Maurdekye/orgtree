delete process.env.ELECTRON_RUN_AS_NODE
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as httpServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '../../../../tools/rig/desktop.mjs'
const here = path.dirname(fileURLToPath(import.meta.url))
const [outputArg, depsArg] = process.argv.slice(2)
const output = path.resolve(outputArg), deps = path.resolve(depsArg)
const require = createRequire(path.join(deps, '../package.json')), esbuild = require('esbuild')
mkdirSync(output, { recursive: true })
await esbuild.build({ entryPoints: [path.join(here, 'mentionnavigation.visual.tsx')], outfile: path.join(output, 'probe.js'),
  nodePaths: [deps], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'error' })
await esbuild.build({ entryPoints: [path.join(here, '../src/styles.css')], outfile: path.join(output, 'probe.css'),
  nodePaths: [deps], bundle: true, loader: { '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' }, logLevel: 'error' })
esbuild.stop()
const server = httpServer((req, res) => {
  if (req.url === '/') { res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/probe.css"><div id="root"></div><script src="/probe.js"></script>'); return }
  if (req.url === '/probe.js' || req.url === '/probe.css') {
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript')
    res.end(readFileSync(path.join(output, req.url.slice(1)))); return
  }
  res.writeHead(404); res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let result
try {
  result = await runDesktop({ dir: output, url: `http://127.0.0.1:${server.address().port}`, token: '', org: '' },
    path.join(here, 'mentionnavigation.visual.cjs'), { out: path.join(output, 'desktop'), timeout: 90000 })
} finally { server.close() }
writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ ok: result.ok, error: result.error, output }))
if (!result.ok) process.exitCode = 1
