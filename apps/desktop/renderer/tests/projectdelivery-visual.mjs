// Captures project mail rows (projectdelivery-visual.tsx) in offscreen
// Electron: a project's inbox inside the real desk frame, an agent's and the
// user's Sent folders and an ordinary inbox, at 220px and 340px list columns,
// dark and light. With --expect it checks the three-line project row (user
// 2026-10-18 14:24Z): nothing wraps or is stretched, the queue state has its
// own line, and a name is cut only with an ellipsis.
//   node projectdelivery-visual.mjs <build-output> <evidence> <node_modules> [--expect]
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
await esbuild.build({ entryPoints: [path.join(here, 'projectdelivery-visual.tsx')], outfile: path.join(output, 'probe.js'),
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
    path.join(here, 'projectdelivery-visual.cjs'), { out: path.join(evidence, 'desktop'), timeout: 150000 })
} finally { server.close() }
writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
if (!result.ok) { console.log(JSON.stringify({ ok: false, error: result.error, out: evidence })); process.exit(1) }

const checked = []
if (flag === '--expect') {
  const near = (a, b, d, what) => assert.ok(Math.abs(a - b) <= d, `${what}: ${a} vs ${b}`)
  for (const [name, m] of Object.entries(result.value)) {
    const size = name.includes('-narrow') ? 'narrow' : 'wide', surface = name.replace(/^(dark|light)-/, '').replace(/-(narrow|wide).*$/, '')
    assert.ok(m.rows.length > 2, `${name}: positive control, rows rendered`)
    assert.equal(m.rows.some(r => r.queue) , surface !== 'inbox', `${name}: positive control, queue states only where mail went to a project`)
    for (const row of m.rows) {
      const what = `${name} ${row.from?.text}`
      // nothing wraps, and no chip is stretched by its line
      for (const p of [row.sender, row.time, row.kind, row.urgent, row.queue, row.recipient, row.preview])
        if (p) assert.equal(p.textLines, 1, `${what}: ${p.cls} wraps over ${p.textLines} lines`)
      for (const c of row.chips) { assert.equal(c.textLines, 1, `${what}: chip ${c.text} wraps`); assert.ok(c.h <= 20, `${what}: chip ${c.text} is ${c.h}px tall`) }
      for (const l of row.lines) assert.ok(l.h <= 20, `${what}: ${l.cls} is ${l.h}px tall`)
      // nothing leaves the row
      for (const p of [row.from, row.time, ...row.chips])
        if (p) assert.ok(p.x >= row.content.left - 0.5 && p.x + p.w <= row.content.right + 0.5, `${what}: ${p.cls ?? p.text} leaves the row ${JSON.stringify({ p, content: row.content })}`)
      // who and when on line 1; a queue state and the kind beside it on a line of
      // their own, and in a project's own mailbox the chips of every row
      assert.equal(row.from.line, 0, what); assert.equal(row.time.line, 0, what)
      if (row.queue || (surface === 'project' && (row.kind || row.urgent))) {
        assert.ok(row.cls.split(' ').includes('project-mail'), `${what}: project-mail row`)
        assert.deepEqual(row.lines.slice(0, 2).map(l => l.cls), ['l1', 'lmeta'], what)
        for (const p of [row.queue, row.kind, row.urgent]) if (p) assert.equal(p.line, 1, `${what}: ${p.cls} on the meta line`)
        if (row.kind && row.queue) {
          assert.ok(row.kind.x + row.kind.w <= row.queue.x, `${what}: the kind chip leads the queue state`)
          // the marker's name (its arrow glyph has a taller box) or an outline chip's label
          near((row.recipient ?? row.queue).textTop, row.kind.textTop, 0.5, `${what}: the queue state shares the chips' text line`)
        }
        near(row.lines[1].h, row.lines[0].h, 0.5, `${what}: the meta line is as tall as line 1`)
      } else assert.deepEqual(row.lines.map(l => l.cls), ['l1', 'l2'], what)
      // the widest column cuts no name in a project row; any cut ends in an ellipsis
      for (const p of [row.sender, row.recipient]) if (p) {
        if (size === 'wide' && row.queue) assert.equal(p.clipped, false, `${what}: ${p.text} is cut at 340px`)
        else if (p.clipped) assert.ok(p.ellipsis, `${what}: ${p.text} is cut without an ellipsis`)
      }
    }
    // a chip stands the same on every row and line (tags sit on the preview line)
    const chipHeights = {}
    for (const c of m.rows.flatMap(r => r.chips)) if (!c.cls.startsWith('mail-tag')) (chipHeights[c.cls.split(' ')[0]] ??= []).push(c.h)
    for (const [cls, hs] of Object.entries(chipHeights)) for (const h of hs) near(h, hs[0], 0.5, `${name}: every ${cls} chip has one height`)
    // one height per row shape
    for (const shape of [['l1', 'lmeta', 'l2'], ['l1', 'l2']]) {
      const hs = m.rows.filter(r => r.lines.map(l => l.cls).join() === shape.join()).map(r => r.box.h)
      for (const h of hs) near(h, hs[0], 0.5, `${name}: ${shape.join('+')} rows share one height`)
    }
    if (name.endsWith('-selected')) {
      assert.ok(m.head?.recipient, `${name}: the reading pane names the recipient`)
      assert.equal(m.head.recipient.textLines, 1, `${name}: the pane keeps the recipient on one line`)
    }
    checked.push(name)
  }
}
console.log(JSON.stringify({ ok: true, expect: flag === '--expect', checked, shots: result.shots?.length, out: evidence }))
