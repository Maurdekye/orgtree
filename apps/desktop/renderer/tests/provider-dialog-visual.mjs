// Renderer-only visual proof. No engine, provider traffic, or desktop settings.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { runDesktop } from '../../../../tools/rig/desktop.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [output, evidence] = process.argv.slice(2, 4).map(p => path.resolve(p))
const fixture = process.argv[4] || 'provider-dialog'
if (!['provider-dialog', 'provider-toggle'].includes(fixture)) throw new Error('Unknown fixture')
if (!output || !evidence) throw new Error('Supply build output and evidence directories')
mkdirSync(output, { recursive: true })
mkdirSync(evidence, { recursive: true })
await build({ entryPoints: [path.join(here, `${fixture}-probe.tsx`)], outfile: path.join(output, 'probe.js'),
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'warning' })
writeFileSync(path.join(output, 'probe.css'), readFileSync(path.join(here, '../src/styles.css')))
const html = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/probe.css">'
  + '<body><div id="root"></div><script src="/probe.js"></script></body>'
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
    path.join(here, `${fixture}-visual.cjs`), { out: path.join(evidence, 'desktop'), preset: 'short' })
  writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ok: result.ok, checks: result.value, error: result.error, out: evidence }))
  if (!result.ok) process.exitCode = 1
} finally { server.close() }
