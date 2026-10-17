// Run this entire command (including bundling) under tests/joblimit.ps1.
// Resolve real dependencies without copying or linking node_modules.
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '../../../../tools/rig/desktop.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [outputArg, evidenceArg, dependenciesArg] = process.argv.slice(2)
if (!outputArg || !evidenceArg || !dependenciesArg) throw new Error('Supply build-output, evidence and real dependency root')
const output = path.resolve(outputArg), evidence = path.resolve(evidenceArg), dependencies = path.resolve(dependenciesArg)
const require = createRequire(path.join(dependencies, '../package.json'))
const esbuild = require('esbuild')
mkdirSync(output, { recursive: true }); mkdirSync(evidence, { recursive: true })
await esbuild.build({ entryPoints: [path.join(here, 'mail-tags-multi-probe.tsx')], outfile: path.join(output, 'probe.js'),
  nodePaths: [dependencies], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'warning' })
esbuild.stop()
writeFileSync(path.join(output, 'probe.css'), readFileSync(path.join(here, '../src/styles.css')))
const html = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/probe.css"><div id="root"></div><script src="/probe.js"></script>'
const server = createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return }
  if (req.url === '/probe.js' || req.url === '/probe.css') {
    res.setHeader('Content-Type', req.url.endsWith('css') ? 'text/css' : 'text/javascript')
    res.end(readFileSync(path.join(output, req.url.slice(1)))); return
  }
  res.writeHead(404); res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const result = await runDesktop({ dir: evidence, url: `http://127.0.0.1:${server.address().port}`, token: '', org: '' },
    path.join(here, 'mail-tags-multi-visual.cjs'), { out: path.join(evidence, 'desktop'), timeout: 90000 })
  writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ok: result.ok, error: result.error, value: result.value, out: evidence }))
  if (!result.ok) process.exitCode = 1
} finally { server.close() }
