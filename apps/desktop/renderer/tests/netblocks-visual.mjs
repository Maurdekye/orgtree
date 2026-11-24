// Captures and checks blocking in the org mailbox (Mail hub 2.6.0; docket
// blocking-contacts-on-the-hub-hubchat-1-4-0-orgtr; @coordinator-opus m366025ce9de1
// ruling C): the probe netblocks-probe.tsx (real OrgInboxModal, synthetic
// engine API, no engine or hub) in offscreen Electron through tools/rig/desktop.
// The six states: (1) block -> "block — sure?" -> blocked; (2) the red cancel
// sign and unblock; (3) "blocked contacts" says "blocked by you"; (4) a contact
// that blocks the org shows "has blocked this org"; (5) a refused message shows
// the red cancel sign with the engine's words; (6) a 2.5.x hub says it needs an
// update. The engine-hub join (refused send, notice, poll) is netblocks-e2e.
//   node netblocks-visual.mjs <build-output> <evidence> <node_modules>
// Session 0 only; run the whole command, bundling included, under
// tests/joblimit.ps1 and a build slot. Exit 0 = every check passed.
delete process.env.ELECTRON_RUN_AS_NODE
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { runDesktop } from '../../../../tools/rig/desktop.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [outputArg, evidenceArg, dependenciesArg] = process.argv.slice(2)
if (!outputArg || !evidenceArg || !dependenciesArg) throw new Error('Supply build-output, evidence and real dependency root')
const output = path.resolve(outputArg), evidence = path.resolve(evidenceArg), dependencies = path.resolve(dependenciesArg)
const require = createRequire(path.join(dependencies, '../package.json'))
const esbuild = require('esbuild')
mkdirSync(output, { recursive: true }); mkdirSync(evidence, { recursive: true })
await esbuild.build({ entryPoints: [path.join(here, 'netblocks-probe.tsx')], outfile: path.join(output, 'probe.js'),
  nodePaths: [dependencies], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'warning' })
esbuild.stop()
// the app's stylesheet first, then the components' own CSS esbuild bundled beside probe.js (chips, roster)
const bundled = existsSync(path.join(output, 'probe.css')) ? readFileSync(path.join(output, 'probe.css'), 'utf8') : ''
writeFileSync(path.join(output, 'probe.css'), readFileSync(path.join(here, '../src/styles.css'), 'utf8') + '\n' + bundled)
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
  result = await runDesktop({ dir: evidence, url: `http://127.0.0.1:${server.address().port}`, token: '', org: '', run: { ui: 'probe' } },
    path.join(here, 'netblocks-visual.cjs'), { out: path.join(evidence, 'desktop'), timeout: 120000 })
} finally { server.close() }
writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
if (!result.ok) { console.log(JSON.stringify({ ok: false, error: result.error, out: evidence })); process.exit(1) }

const v = result.value, CY = 'cy.fixture.cc0033', ALICE = 'alice.fixture.aa0011'
const red = c => { const [r, g, b] = (c.match(/\d+/g) ?? []).map(Number); return r > 150 && r > g * 1.6 && r > b * 1.6 }
const checks = []
const check = (name, f) => { f(); checks.push(name) }
check('session 0', () => { assert.equal(result.session.electron, 0); assert.equal(result.session.rig, 0) })
check('6: a 2.5.x hub says it needs an update, and offers no block', () => {
  assert.deepEqual(v.initial.update.filter(t => /needs an update/.test(t)), ['this mail hub needs an update before it can block contacts'])
  assert.equal(v.initial.bob, null)
  assert.ok(!/\bblock\b/.test(v.initial.hubText[1].replace(/block contacts/, '')), `hub B offers no block: ${v.initial.hubText[1]}`)
})
check('4: a contact that blocks the org shows the red sign and "has blocked this org"', () => {
  assert.equal(v.initial.cy?.label, 'has blocked this org'); assert.ok(red(v.initial.cy.color), v.initial.cy.color)
  assert.ok(v.initial.list?.some(l => /has blocked this org: no messages either way/.test(l)), JSON.stringify(v.initial.list))
  assert.equal(v.initial.alice, null); assert.equal(v.initial.aliceButton, 'block')
})
check('1: block asks once more ("block — sure?"), and only the second press blocks', () => {
  assert.equal(v.asking.aliceButton, 'block — sure?'); assert.equal(v.asking.alice, null)
  const posts = v.calls.filter(c => c.method === 'POST')
  assert.deepEqual(posts.map(c => c.body), [{ address: ALICE, blocked: true }, { address: ALICE, blocked: false }])
})
check('2: a blocked contact shows the red cancel sign and an unblock button', () => {
  assert.equal(v.blocked.alice?.label, 'blocked'); assert.ok(red(v.blocked.alice.color), v.blocked.alice.color); assert.ok(v.blocked.alice.w > 0)
  assert.equal(v.blocked.aliceButton, 'unblock')
})
check('3: the blocked contacts list says "blocked by you" with unblock', () => {
  assert.ok(v.blocked.list?.some(l => /blocked by you/.test(l)), JSON.stringify(v.blocked.list)); assert.equal(v.blocked.listButton, 'unblock')
})
check('5: a refused message shows the red cancel sign with the engine\'s words', () => {
  const words = `not delivered — you have been blocked by @net:${CY} and cannot message them`
  assert.equal(v.refused.label, words); assert.equal(v.refused.title, words); assert.ok(v.refused.svg); assert.ok(red(v.refused.color), v.refused.color)
})
check('unblock acts at once and the sign goes', () => {
  assert.equal(v.unblocked.alice, null); assert.equal(v.unblocked.aliceButton, 'block'); assert.equal(v.unblocked.err, null)
})
console.log(JSON.stringify({ ok: true, checked: checks, shots: result.shots?.length, out: evidence }))
