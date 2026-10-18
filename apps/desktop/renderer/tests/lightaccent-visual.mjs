// Captures the light-mode gallery (lightaccent-visual.tsx: the user's inbox and
// the Attention list) in offscreen Electron, in the light and solarized-light
// contrast families with every preset theme, and in charcoal with Orgtree
// Grey. With --expect it checks every preset's accent on the light surfaces
// (user 2026-10-18 15:34Z and 15:35Z): every text drawn in the accent or its
// hover reads at 4.5:1 or more on the background it really sits on, at rest
// and on a hovered urgent and unread row, every accent fill's own text does
// too, and each effort bar is a light control whose fill stands 3:1 apart from
// its rail; the dark surfaces keep every preset's own accent and the dark
// effort rail.
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
// the presets' own accents, which the dark surfaces keep (themes.tsx THEMES)
const DARK_ACCENTS = { orgtree: '#b6bdc8', claude: '#d97757', codex: '#22c4bd', antigravity: '#75a5ff',
  openrouter: '#b69afa', langserver: '#cda206', muse: '#afe5ff' }
if (flag === '--expect') {
  const { frames, tokens } = result.value
  const reads = (what, list, min) => {
    for (const t of list) assert.ok(t.ratio >= min, `${what}: "${t.text}" (${t.el}) ${t.color ?? t.ink} on ${t.on} is ${t.ratio}:1`)
  }
  for (const contrast of ['light', 'solarized-light']) for (const theme of Object.keys(DARK_ACCENTS)) {
    for (const view of ['inbox', 'attention']) {
      const name = `${contrast}-${theme}-${view}`, f = frames[name]
      assert.ok(f, `${name} was captured`)
      assert.equal(f.root.theme, theme, `${name}: the gallery runs the ${theme} theme`)
      assert.notEqual(f.root.accent, DARK_ACCENTS[theme], `${name}: the light surfaces give ${theme} its deep partner`)
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
      if (view === 'inbox') {
        // the app accent's bar, an inherited level's and a Claude desk's (its provider colour)
        assert.ok(f.effort.length >= 3 && f.effort.some((e) => e.desk), `${name}: found the effort bars: ${JSON.stringify(f.effort)}`)
        for (const e of f.effort) {
          assert.ok(e.railOnPanel < 1.5, `${name}: the effort rail ${e.rail} is light on ${e.panel} (${e.railOnPanel}:1)`)
          assert.ok(e.fillOnRail >= 3, `${name}: the effort fill ${e.fill} on the rail ${e.rail} is ${e.fillOnRail}:1${e.desk ? ' (desk)' : ''}`)
        }
      }
      checked.push(name)
    }
  }
  // the dark surfaces keep the theme's own accent, and the effort bar its dark rail
  for (const view of ['inbox', 'attention']) {
    const f = frames[`charcoal-orgtree-${view}`]
    assert.equal(f.root.accent, '#b6bdc8', `charcoal ${view}: Orgtree Grey keeps #b6bdc8`)
    assert.equal(f.root.ink, '#17191d', `charcoal ${view}: and its dark ink`)
    if (view === 'inbox') for (const e of f.effort) assert.equal(e.rail, '#3f3f46', `charcoal: the effort rail stays #3f3f46 (${e.rail})`)
    checked.push(`charcoal-orgtree-${view}`)
  }
  assert.equal(tokens['obsidian-black-orgtree'].accent, '#b6bdc8', 'obsidian black keeps the Orgtree Grey accent')
  for (const [theme, accent] of Object.entries(DARK_ACCENTS)) {
    assert.equal(tokens[`charcoal-${theme}`].accent, accent, `charcoal keeps ${theme}'s own accent ${accent}`)
  }
  checked.push('tokens')
}
console.log(JSON.stringify({ ok: true, expect: flag === '--expect', checked, shots: result.shots?.length, out: evidence }))
