// Captures the Attention list's @user mention rows (attnmention-visual.tsx) in
// offscreen Electron beside an urgent mail and a mail that mentions @user, at
// 220px and 340px list columns, dark and light. With --expect it checks the
// cleaned-up mention row (user 2026-10-18 14:39Z): a two-line unread row with
// the mail rows' attention cue and height, a "mention" pill as tall as the
// other pills, and one excerpt line with @user in view and no ellipsis
// beside it.
//   node attnmention-visual.mjs <build-output> <evidence> <node_modules> [--expect]
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
await esbuild.build({ entryPoints: [path.join(here, 'attnmention-visual.tsx')], outfile: path.join(output, 'probe.js'),
  nodePaths: [dependencies], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'warning' })
esbuild.stop()
// the Attention view's own sheet rides along with the app's (main.tsx imports both)
writeFileSync(path.join(output, 'probe.css'), readFileSync(path.join(here, '../src/styles.css'), 'utf8')
  + '\n' + readFileSync(path.join(here, '../src/attention/attention.css'), 'utf8'))
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
    path.join(here, 'attnmention-visual.cjs'), { out: path.join(evidence, 'desktop'), timeout: 120000 })
} finally { server.close() }
writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
if (!result.ok) { console.log(JSON.stringify({ ok: false, error: result.error, out: evidence })); process.exit(1) }

const checked = []
if (flag === '--expect') {
  const near = (a, b, d, what) => assert.ok(Math.abs(a - b) <= d, `${what}: ${a} vs ${b}`)
  for (const [name, m] of Object.entries(result.value)) {
    const mentions = m.rows.filter(r => r.kind === 'mention'), mails = m.rows.filter(r => r.kind === 'mail')
    assert.equal(mentions.length, 3, `${name}: positive control, three mention rows`)
    assert.equal(mails.length, 2, `${name}: positive control, the urgent mail and the mail that mentions @user`)
    for (const row of mentions) {
      const what = `${name} ${row.from?.text}`
      assert.ok(['mailrow', 'unread', 'urgent'].every(c => row.cls.split(' ').includes(c)), `${what}: an unread mail row with the attention cue (${row.cls})`)
      assert.deepEqual(row.lines.map(l => l.cls), ['l1', 'l2'], what)
      assert.deepEqual(row.lines[0].kids, ['mfrom', 'mentionkind', 'mtime'], `${what}: agent, pill, time`)
      assert.deepEqual(row.lines[1].kids, ['mail-preview-text'], `${what}: one excerpt`)
      for (const l of row.lines) assert.ok(l.h <= 20 && l.textLines === 1, `${what}: ${l.cls} is one line (${l.h}px, ${l.textLines})`)
      // @user is in view, inside the excerpt's visible box
      assert.ok(row.token && row.token.x >= row.preview.x - 0.5 && row.token.x + row.token.w <= row.preview.x + row.preview.w + 0.5,
        `${what}: @user in view ${JSON.stringify({ token: row.token, preview: row.preview })}`)
      const text = row.preview.text
      assert.equal(/…\s*@user|@user…/.test(text) && !/^…\s@user/.test(text), false, `${what}: no ellipsis against @user in "${text}"`)
      assert.equal(text.slice(1, -1).includes('…'), false, `${what}: ellipses only at the ends of "${text}"`)
    }
    // the pill stands as every other pill on line 1, and the row is as tall as a mail row
    const pills = Object.fromEntries(m.rows.flatMap(r => r.chips).map(c => [c.cls.split(' ')[0], c]))
    assert.ok(pills.mentionkind && pills.urgentkind, `${name}: mention and urgent pills present`)
    near(pills.mentionkind.h, pills.urgentkind.h, 0.5, `${name}: the mention pill is as tall as the urgent pill`)
    for (const row of mentions) near(row.box.h, mails[0].box.h, 0.5, `${name} ${row.from?.text}: a mention row is as tall as a mail row`)
    checked.push(name)
  }
}
console.log(JSON.stringify({ ok: true, expect: flag === '--expect', checked, shots: result.shots?.length, out: evidence }))
