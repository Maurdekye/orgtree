// Captures the light-mode gallery (lightaccent-visual.tsx: the user's inbox and
// the Attention list) in offscreen Electron, in the light, solarized-light and
// charcoal contrast families with the Orgtree Grey theme. With --expect it
// checks the Orgtree Grey accent on the light surfaces (user 2026-10-18
// 15:34Z): every text drawn in the accent or its hover reads at 4.5:1 or more
// on the background it really sits on, at rest and on a hovered urgent and
// unread row, and every accent fill's own text does too; dark surfaces and
// the other themes keep their accents.
//   node lightaccent-visual.mjs <build-output> <evidence> <node_modules> [--expect]
// Run the whole command, bundling included, under tests/joblimit.ps1 and the
// build slot. Without --expect it only records (a base for before/after).
// Electron probes must launch in browser mode even under an inherited Node-mode parent.
delete process.env.ELECTRON_RUN_AS_NODE
// Resolve real dependencies without copying or linking node_modules.
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { runDesktop } from '../../../../tools/rig/desktop.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [outputArg, evidenceArg, dependenciesArg, flag] = process.argv.slice(2)
if (!outputArg || !evidenceArg || !dependenciesArg) throw new Error('Supply build-output, evidence and real dependency root')
const output = path.resolve(outputArg), evidence = path.resolve(evidenceArg), dependencies = path.resolve(dependenciesArg)
const require = createRequire(path.join(dependencies, '../package.json'))
const esbuild = require('esbuild')
mkdirSync(output, { recursive: true }); mkdirSync(evidence, { recursive: true })
await esbuild.build({ entryPoints: [path.join(here, 'lightaccent-visual.tsx')], outfile: path.join(output, 'probe.js'),
  nodePaths: [dependencies], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'warning' })
esbuild.stop()
// the app's sheets the gallery draws with (main.tsx imports these)
writeFileSync(path.join(output, 'probe.css'), ['../src/styles.css', '../src/attention/attention.css']
  .map((f) => readFileSync(path.join(here, f), 'utf8')).join('\n'))
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
let result
try {
  result = await runDesktop({ dir: evidence, url: `http://127.0.0.1:${server.address().port}`, token: '', org: '' },
    path.join(here, 'lightaccent-visual.cjs'), { out: path.join(evidence, 'desktop'), timeout: 150000 })
} finally { server.close() }
writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
if (!result.ok) { console.log(JSON.stringify({ ok: false, error: result.error, out: evidence })); process.exit(1) }

const checked = []
if (flag === '--expect') {
  const { frames, tokens } = result.value
  const reads = (what, list, min) => {
    for (const t of list) assert.ok(t.ratio >= min, `${what}: "${t.text}" (${t.el}) ${t.color ?? t.ink} on ${t.on} is ${t.ratio}:1`)
  }
  for (const contrast of ['light', 'solarized-light']) {
    for (const view of ['inbox', 'attention']) {
      const name = `${contrast}-orgtree-${view}`, f = frames[name]
      assert.ok(f, `${name} was captured`)
      assert.equal(f.root.theme, 'orgtree', `${name}: the gallery runs the Orgtree Grey theme`)
      assert.ok(f.root.cls.split(' ').includes(`contrast-${contrast}`), `${name}: on the ${contrast} surfaces (${f.root.cls})`)
      // positive controls: the audit found the accent's text and fills
      assert.ok(f.texts.length >= 3, `${name}: found ${f.texts.length} texts in the accent: ${JSON.stringify(f.texts)}`)
      assert.ok(f.fills.length >= 1, `${name}: found ${f.fills.length} accent fills`)
      reads(`${name} text`, f.texts, 4.5)
      reads(`${name} fill`, f.fills, 4.5)
      for (const [state, h] of Object.entries(f.hover)) {
        assert.ok(h && h.texts.length >= 1, `${name}: the hovered ${state} row has text in the accent`)
        reads(`${name} hovered ${state} row`, h.texts, 4.5)
      }
      checked.push(name)
    }
  }
  // the dark surfaces keep the theme's own accent
  for (const view of ['inbox', 'attention']) {
    const f = frames[`charcoal-orgtree-${view}`]
    assert.equal(f.root.accent, '#b6bdc8', `charcoal ${view}: Orgtree Grey keeps #b6bdc8`)
    assert.equal(f.root.ink, '#17191d', `charcoal ${view}: and its dark ink`)
    checked.push(`charcoal-orgtree-${view}`)
  }
  assert.equal(tokens['obsidian-black-orgtree'].accent, '#b6bdc8', 'obsidian black keeps the Orgtree Grey accent')
  // other themes are not this slice's: Claude keeps its accent, Muse its own light partner
  assert.equal(tokens['light-claude'].accent, '#d97757', 'Claude Terracotta on light is unchanged')
  assert.equal(tokens['solarized-light-claude'].accent, '#d97757', 'Claude Terracotta on solarized light is unchanged')
  assert.equal(tokens['light-muse'].accent, '#0077b0', "Muse Eggshell keeps its light partner")
  checked.push('tokens')
}
console.log(JSON.stringify({ ok: true, expect: flag === '--expect', checked, shots: result.shots?.length, out: evidence }))
