// Captures and checks blocking in the org mailbox (Mail hub 2.6.0; docket
// blocking-contacts-on-the-hub-hubchat-1-4-0-orgtr; @coordinator-opus m366025ce9de1
// ruling C): the probe netblocks-probe.tsx (real OrgInboxModal, synthetic
// engine API, no engine or hub) in offscreen Electron through tools/rig/desktop.
// The six states: (1) the row's red × blocks at once (USER 2026-11-25 21:49:37Z
// m8ee22829e340, no confirm); (2) the red cancel
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

const v = result.value, CY = 'cy.fixture.cc0033', ALICE = 'alice.fixture.aa0011', BOB = 'bob.fixture.bb0022'
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
  assert.equal(v.initial.alice, null); assert.equal(v.initial.aliceButton, 'blocked sign')
})
check('1: each row of the hub list ends in the blocked status sign as a small button that blocks at once (USER alpha.8 m2d6e12a94c56)', () => {
  const x = v.initial.aliceX
  // the same sign, colour and size as cy's blocked-status badge in the same list
  assert.ok(Math.abs(x.iconW - v.initial.cy.w) < 0.5 && Math.abs(x.iconH - v.initial.cy.h) < 0.5, `icon ${x.iconW}x${x.iconH} vs badge ${v.initial.cy.w}x${v.initial.cy.h}`)
  assert.equal(x.iconColor, v.initial.cy.color)
  assert.equal(x?.title, `Block @net:${ALICE}: no messages either way`); assert.ok(red(x.color), x.color)
  assert.ok(x.w > 8 && x.w < 30 && x.h < 30, `small: ${x.w}x${x.h}`); assert.ok(x.rightGap >= 0 && x.rightGap < 20, `at the row's end: ${x.rightGap}`)
  assert.ok(red(v.hoverX.color), v.hoverX.color)
  const posts = v.calls.filter(c => c.method === 'POST')
  assert.deepEqual(posts.map(c => c.body), [{ address: ALICE, blocked: true }, { address: ALICE, blocked: false }])
})
check('2: a blocked contact shows the red cancel sign and an unblock button', () => {
  assert.equal(v.blocked.alice?.label, 'blocked'); assert.ok(red(v.blocked.alice.color), v.blocked.alice.color); assert.ok(v.blocked.alice.w > 0)
  // USER mc519405980c8: a checkmark in the block button's place unblocks; no text button
  assert.equal(v.blocked.aliceButton, 'unblock check'); assert.deepEqual(v.blocked.textUnblock, [])
  const b = v.blocked.aliceX, x = v.initial.aliceX
  assert.equal(b?.title, `Unblock @net:${ALICE}`)
  assert.ok(Math.abs(b.w - x.w) < 0.5 && Math.abs(b.h - x.h) < 0.5 && Math.abs(b.rightGap - x.rightGap) < 0.5 && Math.abs(b.iconW - x.iconW) < 0.5,
    `same size and place as the block button: ${JSON.stringify(b)} vs ${JSON.stringify(x)}`)
})
check('3: the blocked contacts list says "blocked by you" with unblock', () => {
  assert.ok(v.blocked.list?.some(l => /blocked by you/.test(l)), JSON.stringify(v.blocked.list)); assert.equal(v.blocked.listButton, 'unblock check')
  // USER m3d87ef9439ae "yes make that a checkmark too": the same green checkmark button as the blocked row's
  const l = v.blocked.listX, b = v.blocked.aliceX
  assert.equal(l?.title, `Unblock @net:${ALICE}`)
  assert.ok(Math.abs(l.w - b.w) < 0.5 && Math.abs(l.h - b.h) < 0.5 && Math.abs(l.iconW - b.iconW) < 0.5 && l.color === b.color,
    `same size and colour as the row checkmark: ${JSON.stringify(l)} vs ${JSON.stringify(b)}`)
})
check('5: a refused message shows the red cancel sign with the engine\'s words', () => {
  const words = `not delivered — you have been blocked by @net:${CY} and cannot message them`
  assert.equal(v.refused.label, words); assert.equal(v.refused.title, words); assert.ok(v.refused.svg); assert.ok(red(v.refused.color), v.refused.color)
})
check('unblock acts at once and the sign goes', () => {
  assert.equal(v.unblocked.alice, null); assert.equal(v.unblocked.aliceButton, 'blocked sign'); assert.equal(v.unblocked.err, null)
})
const DEE = 'dee.fixture.dd0044', GONE = 'gone.fixture.ee0055'
check('7: the lockdown list is the shared list under its hub, each with a × that takes it off; no address box or allow/unlist', () => {
  const l = v.lockList
  assert.ok(l?.sharedList); assert.equal(l.addressBox, false); assert.equal(l.allowLinks, 0)
  assert.deepEqual(l.rows.map(r => r.address).sort(), [`@net:${DEE}`, `@net:${GONE}`])
  assert.deepEqual(l.rows.map(r => r.x).sort(), [`Take @net:${DEE} off the lockdown list`, `Take @net:${GONE} off the lockdown list`])
})
check('8: Add opens a searchable dropdown of connected contacts not listed; a choice adds at once; × removes', () => {
  assert.deepEqual(v.addAll, [ALICE, BOB, CY], 'every connected contact on any hub (Bob is on the 2.5.0 hub B); Dee is listed already; Gone is not connected')
  assert.deepEqual(v.addSearch, [ALICE])
  assert.deepEqual(v.lockAdded.rows.map(r => r.address).sort(), [`@net:${ALICE}`, `@net:${DEE}`, `@net:${GONE}`])
  assert.deepEqual(v.lockRemoved.rows.map(r => r.address).sort(), [`@net:${ALICE}`, `@net:${DEE}`])
  assert.deepEqual(v.lockCalls, [{ add: [{ hub: 'a', address: ALICE }] }, { remove: [{ hub: 'a', address: GONE }] }])
})
check('11-13: the section is one card: chip + inline action, plain hub words, Allowed addresses + Add, empty state, set-aside toggle and count', () => {
  const e = v.secEmpty, t = v.secThree
  assert.equal(e.chip, 'On · Org decides · set by you'); assert.deepEqual(e.headButtons, ['Lift lockdown'])
  assert.deepEqual(e.hubs, ['Hub Awaiting for the hub']); assert.deepEqual(t.hubs, ['Hub Aenforcing'])
  assert.equal(e.listHead, 'Allowed addressesAdd'); assert.equal(e.empty, 'Nobody outside yet; organizations on this computer can still reach the org')
  assert.equal(e.toggle, 'Set aside mail from unlisted addresses'); assert.equal(e.toggleOn, false); assert.equal(e.setAsideButton, null)
  assert.deepEqual(t.rows.sort(), [`@net:${ALICE}`, `@net:${DEE}`, `@net:${GONE}`]); assert.equal(t.empty, null)
  assert.equal(t.toggleOn, true); assert.equal(t.setAsideButton, 'Show set-aside mail (2)'); assert.equal(v.setAsideShown.length, 2)
})
check('14-17: settings shows the list under the Lockdown dropdown once it is in force, with the searchable Add', () => {
  assert.equal(v.setOff, null, 'Org decides with the org off: no list')
  assert.ok(v.setOnEmpty?.underDropdown); assert.equal(v.setOnEmpty.chip, 'On · forced on by you · set by you')
  assert.equal(v.setOnEmpty.empty, 'Nobody outside yet; organizations on this computer can still reach the org')
  assert.deepEqual(v.setThree.rows.sort(), [`@net:${ALICE}`, `@net:${DEE}`, `@net:${GONE}`])
  assert.deepEqual(v.setAdd, [BOB, CY], 'connected contacts not listed, across hubs')
})
console.log(JSON.stringify({ ok: true, checked: checks, shots: result.shots?.length, out: evidence }))
