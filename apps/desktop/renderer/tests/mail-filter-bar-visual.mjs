// Captures the inbox filter bar (mail-filter-bar-probe.tsx) in offscreen
// Electron, dark and light, and checks the one-field layout with --expect.
//   node mail-filter-bar-visual.mjs <build-output> <evidence> <node_modules> [--expect]
// Run the whole command, bundling included, under tests/joblimit.ps1 and the
// build slot. Without --expect it only records (a base for before/after).
delete process.env.ELECTRON_RUN_AS_NODE
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
await esbuild.build({ entryPoints: [path.join(here, 'mail-filter-bar-probe.tsx')], outfile: path.join(output, 'probe.js'),
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
let result
try {
  result = await runDesktop({ dir: evidence, url: `http://127.0.0.1:${server.address().port}`, token: '', org: '' },
    path.join(here, 'mail-filter-bar-visual.cjs'), { out: path.join(evidence, 'desktop'), timeout: 120000 })
} finally { server.close() }
writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
if (!result.ok) { console.log(JSON.stringify({ ok: false, error: result.error, out: evidence })); process.exit(1) }

const near = (a, b, d, what) => assert.ok(Math.abs(a - b) <= d, `${what}: ${a} vs ${b}`)
const checks = []
if (flag === '--expect') {
  for (const [theme, states] of Object.entries(result.value)) {
    for (const state of ['selected', 'empty', 'typing', 'popover']) {
      const m = states[state], what = `${theme} ${state}`
      assert.deepEqual(m.boxes, [m.boxes.find(b => b.includes('mail-tag-control'))], `${what}: the field is the only bordered box ${JSON.stringify(m.boxes)}`)
      // the open popover's trigger carries its own pressed fill
      if (state !== 'popover') assert.ok(m.fills.length === 1 && m.fills[0].includes('mail-tag-control'), `${what}: the field is the only filled box ${JSON.stringify(m.fills)}`)
      near(m.field.h, 24, 0.1, `${what} field height`)
      for (const [name, box] of [['trigger', m.trigger], ['input', m.input], ['clear', m.clear], ...m.chips.map((c, i) => [`chip ${i}`, c])])
        if (box) { near(box.cy, m.field.cy, 0.75, `${what} ${name} centre`); assert.ok(box.y >= m.field.y && box.y + box.h <= m.field.y + m.field.h, `${what} ${name} inside the field`) }
      for (const c of m.chips) { assert.equal(c.font, '10px', what); assert.ok(c.h <= 16, `${what} field chip height ${c.h}`) }
    }
    const s = states.selected, e = states.empty
    assert.equal(s.chips.length, 1, `${theme}: one selected chip`); assert.ok(s.clear, `${theme}: clear shown with a selection`)
    assert.equal(e.chips.length, 0, `${theme}: no chips`); assert.equal(e.clear, null, `${theme}: no clear without a selection`)
    assert.equal(e.triggerText, 'all tags')
    assert.ok(s.clear.x > s.input.x, `${theme}: clear sits right of the text filter`)
    near(s.clear.x + s.clear.w, s.field.x + s.field.w, 4, `${theme}: clear at the field's right end`)
    for (const c of [s.rowChip, s.headChip]) { assert.equal(c.font, '10px'); assert.equal(c.family, s.rowChip.family, `${theme}: one chip face`) }
    assert.ok(s.rowChip.h <= 15, `${theme}: row chip ${s.rowChip.h}px`)
    const tagged = e.rows.filter(r => r.chips > 0).map(r => r.l2), plain = e.rows.filter(r => r.chips === 0).map(r => r.l2)
    assert.ok(tagged.length && plain.length, `${theme}: tagged and untagged rows`)
    for (const h of tagged) near(h, plain[0], 0.5, `${theme}: chips do not grow the preview line`)
    assert.equal(states.typing.focus, 'input.mail-filter', `${theme}: typing focuses the inline filter`)
    const p = states.popover.popover
    assert.ok(p, `${theme}: popover`); near(p.box.x, states.popover.field.x, 0.5, `${theme}: popover left edge`)
    near(p.box.y, states.popover.field.y + states.popover.field.h + 4, 0.5, `${theme}: popover below the field`)
    near(p.search.h, 24, 0.5, `${theme}: compact tag search`)
    assert.equal(p.choices.length, 7); assert.deepEqual(p.choices.filter(c => c.pressed === 'true').map(c => c.text), ['alpha'])
    for (const c of p.choices) { assert.equal(c.font, '10px'); assert.ok(c.h <= 18, `${theme}: choice ${c.h}px`); assert.equal(c.check, c.pressed === 'true') }
    const n = states.node
    assert.equal(n.field, null); assert.deepEqual(n.boxes, ['input.mail-filter'], `${theme}: node mailbox keeps one filter box`)
    near(n.input.h, 24, 0.1, `${theme}: node filter height`)
    checks.push(theme)
  }
}
console.log(JSON.stringify({ ok: true, expect: flag === '--expect', checked: checks, shots: result.shots?.length, out: evidence }))
