// Replay the actual cold-reset desktop script and its five UI assertions.
// No Electron, engine, database, provider, network or clipboard is started.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const read = file => (process.env.COLD_RESET_FIXTURE_REF
  ? execFileSync('git', ['show', `${process.env.COLD_RESET_FIXTURE_REF}:${file}`], { cwd: repo, encoding: 'utf8' })
  : fs.readFileSync(path.join(repo, file), 'utf8')).replaceAll('\r\n', '\n')
const desktop = read('tools/rig/desktop/cold-reset-default.cjs')
const proof = read('tools/rig/proofs/cold-reset-default.mjs')
const begin = proof.indexOf('  // ---- the Org settings panel, as the user sees it')
const end = proof.indexOf('\n  p.keep(', begin)
assert(begin >= 0 && end > begin, 'replay the actual UI proof block')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const uiProof = new AsyncFunction('rig', 'p', 'stored', 'runDesktop', 'here', 'path', 'same', proof.slice(begin, end))
const onDefault = { enabled: true, occ: 0.25 }
const offDefault = { enabled: false, occ: 0.25 }
const toggle = 'input[role="switch"][aria-label="Reset a session before a known-cold turn"]'
const occupancy = 'input[aria-label="Cheap compaction context occupancy percent"]'

async function drive({ save = true, savedOcc = 0.25 } = {}) {
  let open = false, policies = false, on = true, saved = { ...onDefault }, pending = null
  const seen = { reads: 0, commits: [], shots: [], closes: 0 }
  const document = {
    querySelector(selector) {
      if (selector === '.sq.user') return {}
      if (selector === '#org-settings-tab-policies') return open ? {} : null
      if (selector === toggle) return open && policies ? { checked: on } : null
      if (selector === occupancy) return open && policies && on ? { value: '25' } : null
      throw new Error(`unexpected selector: ${selector}`)
    },
    querySelectorAll(selector) { assert.equal(selector, '.toast'); return [] },
  }
  const context = vm.createContext({ module: { exports: {} }, document,
    location: { pathname: '/o/fresh-org' },
    fetch: async route => {
      assert.equal(route, '/api/orgs/fresh-org', 'read only the fixture org')
      seen.reads++
      if (pending && save && --pending.remaining === 0) {
        saved = { enabled: pending.enabled, occ: savedOcc }
        seen.commits.push({ ...saved }); pending = null
      }
      return { ok: true, json: async () => ({ auto_cheap_compact: { ...saved } }) }
    },
  })
  const evaluate = (fn, ...args) => vm.runInContext(`(${fn.toString()})(...${JSON.stringify(args)})`, context)
  vm.runInContext(desktop, context)
  const page = {
    eval: evaluate,
    async rightClick(selector) { assert.equal(selector, '.sq.user') },
    async click(target) {
      if (target?.selector === 'button.ctxmenu-item' && target.text === 'Org settings') {
        assert.equal(open, false); open = true; policies = false
      } else if (target === '#org-settings-tab-policies') policies = true
      else if (target === toggle) {
        assert(open && policies); assert.equal(pending, null, 'finish the prior save before the next edit')
        on = !on; pending = { enabled: on, remaining: 3 }
      } else throw new Error(`removed or unexpected control: ${JSON.stringify(target)}`)
    },
    // Org settings has no footer Close (USER 2026-10-28 m3291e5890d55): Escape closes it.
    async press(key) {
      assert.equal(key, 'Escape'); assert(open, 'Escape closes the open settings')
      assert.equal(pending, null, 'do not close before the last edit is persisted')
      open = false; policies = false; seen.closes++
    },
    async waitFor(target, { gone = false } = {}) {
      // Each attempt is a deterministic driver tick, not a wall-clock sleep.
      for (let n = 0; n < 5; n++) {
        const value = typeof target === 'function' ? await evaluate(target) : document.querySelector(target)
        if (gone ? !value : value) return value ?? true
      }
      throw new Error('waitFor persisted value or UI timed out')
    },
    async api(method, route) {
      assert.equal(method, 'GET'); assert.equal(route, '/api/orgs/fresh-org')
      return { auto_cheap_compact: { ...saved } }
    },
    async screenshot(name) { seen.shots.push(name) },
    async sleep() { throw new Error('a fixed sleep cannot prove persistence') },
  }
  const value = await context.module.exports(page, { org: 'fresh-org' })
  return { value: JSON.parse(JSON.stringify(value)), seen }
}

async function checks(value, final = onDefault) {
  const got = []
  let reads = 0
  const rig = { run: { ui: true }, api: async (method, route) => {
    assert.equal(method, 'POST'); assert.equal(route, '/api/orgs'); return { slug: 'fresh-org' }
  } }
  const stored = slug => {
    assert.equal(slug, 'fresh-org')
    return ++reads === 1 ? { has: false, acc: null } : { has: true, acc: final }
  }
  const same = (a, b) => a?.enabled === b.enabled && a?.occ === b.occ && Object.keys(a ?? {}).length === 2
  await uiProof(rig, { dir: '.', check: (what, ok, detail) => got.push({ what, ok: !!ok, detail }) }, stored,
    async () => ({ ok: true, value }), '.', path, same)
  assert.equal(got.length, 5, 'keep all five UI checks (plus the eight unchanged backend checks)')
  return got
}

const receipt = () => ({ untouched: { ...onDefault }, before: { on: true, occ: '25' },
  off: { on: false, occ: null, saved: { ...offDefault } }, shown: '25', savedOn: { ...onDefault } })

test('the actual driver observes untouched ON/25 and waits for delayed OFF/ON persistence', async () => {
  const { value, seen } = await drive()
  assert.deepEqual(value, receipt())
  assert.deepEqual(seen.commits, [offDefault, onDefault])
  assert.equal(seen.reads, 6, 'both delayed writes must be observed, not just local toggle state')
  assert.deepEqual(seen.shots, ['opened', 'reset-off', 'reset-on']); assert.equal(seen.closes, 2)
  assert((await checks(value)).every(row => row.ok))
})

test('a toggle that never persists fails the actual driver before advancing to ON', async () => {
  await assert.rejects(drive({ save: false }), /persisted value or UI timed out/)
})

test('a persisted wrong occupancy cannot pass by looking like 25 in the local input', async () => {
  await assert.rejects(drive({ savedOcc: 0.4 }), /persisted value or UI timed out/)
})

test('the untouched check requires the effective default observed before edits', async () => {
  const value = receipt(); value.untouched.occ = 0.4
  const got = await checks(value)
  assert.equal(got[1].ok, false); assert(got.filter((_, i) => i !== 1).every(row => row.ok))
})

test('OFF must be persisted as well as hiding its occupancy input', async () => {
  const value = receipt(); value.off.saved.enabled = true
  const got = await checks(value)
  assert.equal(got[3].ok, false); assert(got.filter((_, i) => i !== 3).every(row => row.ok))
})

test('ON must reach both the saved receipt and the final SQL setting', async () => {
  const value = receipt(); value.savedOn.enabled = false
  assert.equal((await checks(value))[4].ok, false)
  assert.equal((await checks(receipt(), { enabled: true, occ: 0.4 }))[4].ok, false)
  assert.equal((await checks(receipt())).every(row => row.ok), true)
})
