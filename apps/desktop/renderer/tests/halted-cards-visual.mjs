import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '../../../../tools/rig/desktop.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')
const [output, evidence, deps] = process.argv.slice(2).map(p => path.resolve(p))
if (![output, evidence, deps].every(Boolean)) {
  throw new Error('Usage: halted-cards-visual.mjs <C build output> <C evidence> <existing node_modules>')
}
const require = createRequire(path.join(deps, '../package.json'))
const esbuild = require('esbuild')
mkdirSync(output, { recursive: true })
mkdirSync(evidence, { recursive: true })
await esbuild.build({
  entryPoints: [path.join(here, 'halted-cards-visual.tsx')],
  outfile: path.join(output, 'probe.js'),
  nodePaths: [deps], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  logLevel: 'warning',
})
esbuild.stop()
writeFileSync(path.join(output, 'probe.css'), readFileSync(path.join(root, 'apps/desktop/renderer/src/styles.css'))
  + '\n.halted-capture{padding:24px;color:var(--ink-strong);font:14px var(--mono)}'
  + '.halted-capture-zoom{display:flex;align-items:center;gap:26px;margin:14px 0 22px}'
  + '.halted-capture-zoom h2{width:110px}.halted-capture-row{display:flex;gap:24px}'
  + '.halted-capture-row section{display:grid;justify-items:center;gap:8px}'
  + '.halted-capture .sq{position:relative;width:124px;height:124px;box-sizing:border-box}')
const server = createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/probe.css"><div id="root"></div><script src="/probe.js"></script>')
    return
  }
  if (req.url === '/probe.js' || req.url === '/probe.css') {
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript')
    res.end(readFileSync(path.join(output, req.url.slice(1))))
    return
  }
  res.writeHead(404); res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const result = await runDesktop(
    { dir: evidence, url: `http://127.0.0.1:${server.address().port}`, token: '', org: '' },
    path.join(here, 'halted-cards-visual.cjs'), {
      out: path.join(evidence, 'desktop'), timeout: 100000,
      electron: path.join(deps, 'electron/dist/electron.exe'),
    },
  )
  writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  if (!result.ok) process.exitCode = 1
} finally { server.close() }
