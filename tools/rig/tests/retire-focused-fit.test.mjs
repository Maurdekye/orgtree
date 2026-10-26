// Actual driver/proof replay over synthetic matrices and services only.
// No native geometry, window, engine, database, network or real retirement.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const read = file => (process.env.FOCUSED_RETIRE_FIXTURE_REF
  ? execFileSync('git', ['show', `${process.env.FOCUSED_RETIRE_FIXTURE_REF}:${file}`], { cwd: repo, encoding: 'utf8' })
  : fs.readFileSync(path.join(repo, file), 'utf8')).replaceAll('\r\n', '\n')
const driver = read('tools/rig/desktop/retire-focused-fit.cjs')
const proof = read('tools/rig/proofs/retire-focused-fit.mjs')
const fitCalls = [...driver.matchAll(/await page\.click\('([^']*fit the whole org[^']*)'\)/g)]
assert.equal(fitCalls.length, 2)
const FIT = 'button[title="fit the whole org (Shift+Alt+Space)"]'
const names = ['desktop script ran', 'zoomedIn', 'otherRetireKeepsView', 'ownRetireReturnsToFit']
const fitClick = async (selector, present = true) => {
  // Model only the current Fit button: no stale-title alias or generic fallback.
  if (!present || selector !== FIT) throw new Error(`unavailable Fit control: ${selector}`)
}

async function drive({ focusPresent = true, fault = '' } = {}) {
  const fit0 = { x: 0, y: 0, z: 1 }, fit1 = { x: 10, y: 15, z: 1.2 }
  const focused = { x: -200, y: -100, z: fault === 'zoom' ? 1.4 : 3 }
  let camera = fit0, fitCount = 0, contextOpened = false
  const seen = { shots: [], tools: [], sleeps: [], clicks: [] }
  const space = {}
  const context = vm.createContext({ module: { exports: {} },
    document: { querySelector: selector => { assert.equal(selector, '.space'); return space } },
    getComputedStyle: el => { assert.equal(el, space); return { transform: camera } },
    DOMMatrix: class { constructor(value) { this.e = value.x; this.f = value.y; this.a = value.z } },
  })
  vm.runInContext(driver, context)
  const page = {
    async eval(fn) { return vm.runInContext(`(${fn.toString()})()`, context) },
    async sleep(ms) { seen.sleeps.push(ms) },
    async waitFor(selector, options) { assert.equal(selector, '[data-first-use-agent="alice"]'); assert.equal(options.timeout, 30000) },
    async rightClick(selector) { assert.equal(selector, '[data-first-use-agent="alice"]'); contextOpened = true },
    async click(target) {
      if (typeof target === 'string') {
        await fitClick(target)
        seen.clicks.push(target)
        camera = ++fitCount === 1 ? fit0 : fit1
      } else {
        assert(contextOpened)
        assert.equal(target.selector, 'button.ctxmenu-item'); assert.equal(target.text, 'Focus')
        if (!focusPresent) throw new Error('unavailable visible Focus action')
        seen.clicks.push('Focus'); camera = focused
      }
    },
    async screenshot(name) { seen.shots.push(name) },
    async api(method, route, payload) {
      assert.equal(method, 'POST'); assert.equal(route, '/api/rig/tool')
      assert.equal(payload.org, 'synthetic-org'); assert.equal(payload.agent, 'boss')
      seen.tools.push({ tool: payload.tool, args: JSON.parse(JSON.stringify(payload.args)) })
      if (payload.tool === 'orgtree_retire') {
        assert.equal(payload.args.node, 'carol')
        camera = fault === 'other' ? fit0 : focused
      } else {
        assert.equal(payload.tool, 'orgtree_dissolve'); assert.equal(payload.args.node, 'alice')
        camera = fault === 'own' ? focused : fault === 'position' ? { ...fit1, x: 50 } : fit1
      }
      return { ok: true }
    },
  }
  const value = JSON.parse(JSON.stringify(await context.module.exports(page, { org: 'synthetic-org' })))
  assert.equal(fitCount, 2)
  return { value, seen }
}

const marker = 'export default async function (rig) {'
assert(proof.includes(marker))
const body = proof.slice(proof.indexOf(marker) + marker.length, proof.lastIndexOf('}')).replaceAll('import.meta.url', 'proofURL')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const execute = new AsyncFunction('rig', 'Proof', 'path', 'fileURLToPath', 'runDesktop', 'SEED_SETTLE_TIMEOUT', 'proofURL', body)
async function checkProof(ui) {
  const files = []
  class Proof {
    constructor() { this.dir = '/synthetic'; this.checks = [] }
    check(what, ok, detail) { this.checks.push({ what, ok: !!ok, detail }) }
    file(name, value) { files.push({ name, value }) }
    keep(_rig, options) { assert.deepEqual(options.agents, ['alice']) }
    summary() { return this.checks }
  }
  const rig = { scenario() {}, sql: () => [], async waitFor(fn) { assert(await fn()) } }
  const rows = await execute(rig, Proof, path, fileURLToPath, async () => ui, 1,
    new URL('../proofs/retire-focused-fit.mjs', import.meta.url).href)
  return { rows, files }
}

test('actual full driver clicks both current Fit controls and preserves all four proof checks', async () => {
  const { value, seen } = await drive()
  assert.deepEqual(seen.clicks, [FIT, 'Focus', FIT])
  assert.deepEqual(seen.shots, ['1-focused-alice', '2-other-retired-unchanged', '3-focused-retired-fit'])
  assert.deepEqual(seen.tools, [{ tool: 'orgtree_retire', args: { node: 'carol' } }, { tool: 'orgtree_dissolve', args: { node: 'alice' } }])
  assert.equal(seen.sleeps.filter(ms => ms === 1500).length, 2)
  assert(seen.sleeps.filter(ms => ms === 200).length >= 20)
  const { rows, files } = await checkProof({ ok: true, value })
  assert.deepEqual(rows.map(r => r.what), names)
  assert(rows.every(r => r.ok)); assert.equal(files[0].name, 'views.json')
})
test('the actual later Fit click seam independently matches the current hint suffix', async () => {
  await fitClick(fitCalls[1][1])
})
test('a missing Fit button still rejects either original call site', async () => {
  for (const call of fitCalls) await assert.rejects(fitClick(call[1], false), /unavailable Fit control/)
})
test('the actual driver still requires the visible Focus action', async () => {
  await assert.rejects(drive({ focusPresent: false }), /unavailable visible Focus action/)
})
test('camera regressions still fail the original zoom, other-retire and own-fit predicates', async () => {
  for (const [fault, key] of [['zoom', 'zoomedIn'], ['other', 'otherRetireKeepsView'],
    ['own', 'ownRetireReturnsToFit'], ['position', 'ownRetireReturnsToFit']]) {
    const { value } = await drive({ fault })
    const { rows } = await checkProof({ ok: true, value })
    assert.deepEqual(rows.map(r => r.what), names)
    assert.equal(rows.find(r => r.what === key).ok, false, fault)
  }
})
test('failed-driver proof records its failure without passing three unexecuted camera checks', async () => {
  const { rows, files } = await checkProof({ ok: false, error: 'missing Fit' })
  assert.deepEqual(rows, [{ what: names[0], ok: false, detail: 'missing Fit' }])
  assert.equal(files.length, 0)
})
