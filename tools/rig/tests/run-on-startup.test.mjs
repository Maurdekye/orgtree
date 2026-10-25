// Replay actual bridge/driver/proof code using a synthetic settings surface.
// No Electron, OS preferences, startup tasks, permission prompt or database.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const read = file => (process.env.STARTUP_FIXTURE_REF
  ? execFileSync('git', ['show', `${process.env.STARTUP_FIXTURE_REF}:${file}`], { cwd: repo, encoding: 'utf8' })
  : fs.readFileSync(path.join(repo, file), 'utf8')).replaceAll('\r\n', '\n')
const driver = read('tools/rig/desktop/run-on-startup.cjs')
const proof = read('tools/rig/proofs/run-on-startup.mjs')
const SWITCH = 'input[aria-label="Run on boot"]'
const hint = "Start Orgtree's background engine when the computer starts, before anyone signs in. While you are signed in, agents run in your session, with your desktop and apps. Off: nothing of Orgtree runs until you open it. Windows asks for permission to change this."
const declinedMessage = 'Windows did not give permission, so Orgtree still runs on boot.'
function goodValue() {
  const before = { checked: true, label: 'Run on boot', hint, alert: '', oldLabel: false, engineChoice: false }
  return { before, declined: { ...before, alert: declinedMessage }, off: { ...before, checked: false },
    writes: [{ startAtLogin: false }, { startAtLogin: false }] }
}

async function drive({ present = true } = {}) {
  let opened = false, checked = true, alert = '', pending
  const seen = { shots: [], waits: [], sleeps: [], bootKind: null }
  const window = { CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } },
    dispatchEvent(event) {
      assert.equal(event.type, 'orgtree:open-app-settings'); assert.equal(event.detail.tab, 'runtime')
      pending = (async () => {
        seen.bootKind = await window.orgtreeDesktop.getStartupKind()
        assert.equal(seen.bootKind, 'boot')
        checked = (await window.orgtreeDesktop.getPreferences()).startAtLogin
        for (const name of ['requestOrg', 'windowIdentity', 'getWindowIdentity', 'then', 'toJSON']) {
          assert.equal(window.orgtreeDesktop[name], undefined)
        }
        assert.equal(await window.orgtreeDesktop.syntheticUnusedMember(), null)
        opened = true
      })()
      return true
    },
  }
  const row = { querySelector: selector => { assert.equal(selector, '.set-label'); return { textContent: 'Run on boot' } },
    parentElement: { get textContent() { return hint } } }
  const input = { get checked() { return checked }, closest: selector => { assert.equal(selector, '.set-row'); return row },
    getAttribute: name => { assert.equal(name, 'aria-label'); return 'Run on boot' } }
  const document = {
    querySelector(selector) {
      if (selector === SWITCH) return opened && present ? input : null
      if (selector === 'select[aria-label="Where the background engine starts"]') return null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[role="alert"]') return alert ? [{ textContent: alert }] : []
      assert.equal(selector, 'input[role="switch"]'); return [input]
    },
  }
  const context = vm.createContext({ module: { exports: {} }, window, document })
  vm.runInContext(driver, context)
  const page = {
    async eval(fn) {
      const value = vm.runInContext(`(${fn.toString()})()`, context)
      if (pending) { await pending; pending = null }
      return value
    },
    async waitFor(target, options) {
      seen.waits.push(options.timeout)
      if (typeof target === 'string') {
        if (target === '[data-copy-agent-name="boss"]') return true
        if (!document.querySelector(target)) throw new Error(`unavailable startup switch: ${target}`)
      } else if (!await this.eval(target)) throw new Error('startup state did not settle')
    },
    async click(selector) {
      if (!document.querySelector(selector)) throw new Error(`unavailable startup switch: ${selector}`)
      try {
        checked = (await window.orgtreeDesktop.setPreferences({ startAtLogin: !checked })).startAtLogin
        alert = ''
      } catch (error) { alert = error.message }
    },
    async sleep(ms) { seen.sleeps.push(ms) },
    async screenshot(name) { seen.shots.push(name) },
  }
  const value = JSON.parse(JSON.stringify(await context.module.exports(page, { args: {} })))
  assert.equal(window.orgtreeDesktop, undefined, 'driver removes its synthetic bridge')
  return { value, seen }
}

const marker = 'export default async function (rig) {'
assert(proof.includes(marker))
const body = proof.slice(proof.indexOf(marker) + marker.length, proof.lastIndexOf('}'))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const execute = new AsyncFunction('rig', 'Proof', 'runDesktop', 'path', 'here', body)
async function checkProof(value = goodValue(), ok = true) {
  class Proof {
    constructor() { this.dir = '/synthetic'; this.rows = [] }
    check(what, pass, detail) { this.rows.push({ what, ok: !!pass, detail }) }
    summary() { return this.rows }
  }
  const rows = await execute({ org: 'synthetic' }, Proof, async () => ({ value, ok }), path, '/synthetic')
  assert.equal(rows.length, 7, 'all seven original checks execute')
  return rows
}

test('actual bridge and driver keep On, declined-On/message, accepted-Off and exactly two writes', async () => {
  const { value, seen } = await drive()
  assert.deepEqual(value, goodValue())
  assert.deepEqual(seen.shots, ['01-run-on-boot-on', '02-permission-declined', '03-run-on-boot-off'])
  assert.deepEqual(seen.waits, [60000, 20000, 10000, 10000])
  assert.deepEqual(seen.sleeps, [500, 300, 300])
  assert((await checkProof(value)).every(row => row.ok))
})
test('current Sentence-case label passes the original seven-check proof independently of the driver', async () => {
  assert((await checkProof()).every(row => row.ok))
})
test('a missing switch still rejects the actual driver', async () => {
  await assert.rejects(drive({ present: false }), /unavailable startup switch/)
})
test('old labels, missing boot hint and an engine-choice control retain their original failures', async () => {
  for (const [field, value, index] of [['oldLabel', true, 1], ['label', null, 1], ['engineChoice', true, 2], ['hint', '', 3]]) {
    const data = goodValue(); data.before[field] = value
    assert.equal((await checkProof(data))[index].ok, false, field)
  }
})
test('declined/accepted state, message and missing/extra writes still fail their original predicates', async () => {
  for (const [stage, field, value, index] of [['declined', 'checked', false, 4], ['declined', 'alert', '', 4],
    ['off', 'checked', true, 5], ['off', 'alert', declinedMessage, 5]]) {
    const data = goodValue(); data[stage][field] = value
    assert.equal((await checkProof(data))[index].ok, false, `${stage}.${field}`)
  }
  for (const writes of [[], [{ startAtLogin: false }], [...goodValue().writes, { startAtLogin: false }], [{ startAtLogin: true }, { startAtLogin: false }]]) {
    const data = goodValue(); data.writes = writes
    assert.equal((await checkProof(data))[6].ok, false)
  }
})
test('failed-driver empty data retains all seven failures without inventing later operations', async () => {
  assert((await checkProof(null, false)).every(row => !row.ok))
})
