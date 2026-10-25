// Cheap replay of the actual desktop script and all original layout predicates.
// Synthetic rectangles test the instrument, not real layout; the rig still runs
// every theme/width in an isolated renderer before functional approval.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const read = file => (process.env.NEW_ACCOUNT_FIXTURE_REF
  ? execFileSync('git', ['show', `${process.env.NEW_ACCOUNT_FIXTURE_REF}:${file}`], { cwd: repo, encoding: 'utf8' })
  : fs.readFileSync(path.join(repo, file), 'utf8')).replaceAll('\r\n', '\n')
const script = read('tools/rig/desktop/new-agent-account.cjs')
const proof = read('tools/rig/proofs/new-agent-account.mjs')
const marker = 'export default async function (rig) {'
assert(proof.includes(marker))
const body = proof.slice(proof.indexOf(marker) + marker.length, proof.lastIndexOf('}'))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const execute = new AsyncFunction('rig', 'Proof', 'fs', 'path', 'desk', 'WIDTHS', 'runDesktop', body)
const widths = vm.runInNewContext(proof.match(/const WIDTHS = (\[[^\n]+\])/)[1])
const SEL = 'select[aria-label="Default provider account for new hires"]'
const other = 'claude-5', email = 'a-rather-long-second-address@example.invalid'

async function drive(args, size, options = {}) {
  const width = Number(size.split('x')[0])
  let open = false, account = options.initial ?? '', stored = account, pending = null
  const seen = { commits: [], shots: [], reads: 0, closes: 0 }
  const rect = (left, right) => ({ left, right, width: right-left, top: 20, bottom: 70 })
  const body = { scrollWidth: width, clientWidth: width }
  const scroller = { scrollWidth: width + (options.fault === 'overflow' ? 5 : 0), clientWidth: width, parentElement: body }
  const row = { getBoundingClientRect: () => rect(10, width-10), parentElement: scroller,
    scrollIntoView() {}, querySelectorAll: () => account ? [button] : [],
    querySelector: () => options.fault === 'hint' ? null : { innerText: 'Account help' } }
  const button = { innerText: 'Use machine default', clientWidth: 90,
    scrollWidth: options.fault === 'button' ? 100 : 90,
    getBoundingClientRect: () => rect(width-110, width-20) }
  class Select {
    get value() { return account || 'claude/primary' }
    set value(value) { account = value }
    get title() { return options.fault === 'tooltip' ? 'Truncated' : account ? email : 'Primary account' }
    get selectedOptions() { return [{ innerText: account ? email : 'Primary account' }] }
    closest() { return row }
    getBoundingClientRect() { return rect(20, 20 + Math.min(220, width-140) + (account && options.fault === 'width' ? 20 : 0)) }
    dispatchEvent(event) { assert.equal(event.type, 'change'); pending = { value: account, remaining: 3 } }
  }
  const select = new Select()
  const neighbour = { closest: () => row, getBoundingClientRect: () => rect(20, 130) }
  const document = { body, documentElement: { dataset: { contrastTheme: args.theme } },
    querySelector(selector) {
      if (selector === '.sq.user') return {}
      if (selector === '#org-settings-tab-hiredefaults') return open ? {} : null
      if (selector === SEL) return open ? select : null
      if (selector === 'select[aria-label="File and command access"]') return options.fault === 'neighbour' ? null : neighbour
      if (selector === 'select[aria-label="Provider for default account"]') return neighbour
      return null
    } }
  const context = vm.createContext({ module: { exports: {} }, document,
    window: { innerWidth: width }, location: { pathname: '/o/fixture-org' },
    HTMLSelectElement: Select, Event: class { constructor(type) { this.type = type } },
    fetch: async route => {
      assert.equal(route, '/api/orgs/fixture-org')
      seen.reads++
      if (pending && options.save !== false && --pending.remaining === 0) {
        stored = options.wrongSaved ? 'wrong-account' : pending.value
        seen.commits.push(stored); pending = null
      }
      return { ok: true, json: async () => ({ default_account: stored || null }) }
    } })
  const evaluate = (fn, ...values) => vm.runInContext(`(${fn.toString()})(...${JSON.stringify(values)})`, context)
  vm.runInContext(script, context)
  const page = { eval: evaluate,
    async cdp() {}, async goto(route) { assert.equal(route, '/o/fixture-org') }, async rightClick() {},
    async click(target) {
      if (target?.text === 'Org settings') open = true
      else if (target === '#org-settings-tab-hiredefaults') assert(open)
      else if (target?.text === 'Use machine default') {
        assert(account); assert.equal(pending, null, 'previous edit persisted before reset')
        account = ''; pending = { value: '', remaining: 3 }
      } else if (target?.selector === 'button[aria-label="Close organization settings"]') {
        assert.equal(stored, '', 'restore the machine default before closing'); assert.equal(pending, null)
        open = false; seen.closes++
      } else throw new Error(`obsolete control: ${JSON.stringify(target)}`)
    },
    async waitFor(target, { gone = false } = {}) {
      for (let i=0; i<5; i++) {
        const value = typeof target === 'function' ? await evaluate(target)
          : target?.text === 'Use machine default' ? (account ? button : null) : document.querySelector(target)
        if (gone ? !value : value) return value ?? true
      }
      throw new Error(typeof target === 'function' ? 'persistence wait timed out' : `unavailable selector: ${JSON.stringify(target)}`)
    },
    async sleep() {}, async screenshot(tag) { seen.shots.push(tag) },
  }
  const value = await context.module.exports(page, { args })
  return { value: JSON.parse(JSON.stringify(value)), seen, stored }
}

async function run(options = {}) {
  const checks = [], runs = []
  class Proof {
    dir = '.'
    check(what, ok, detail) { checks.push({ what, ok: !!ok, detail }) }
    summary() { return checks }
  }
  const rig = { data: '/synthetic', org: 'fixture-org', api: async () => ({ id: other }) }
  await execute(rig, Proof, { mkdirSync() {}, writeFileSync() {} }, path, 'actual-driver', widths,
    async (_rig, _desk, opts) => {
      try {
        const result = await drive(opts.args, opts.preset, { ...options, initial: other })
        runs.push({ theme: opts.args.theme, size: opts.preset, ...result }); return { ok: true, value: result.value }
      } catch (error) { return { ok: false, error: String(error) } }
    })
  return { checks, runs }
}

test('all six actual driver variants retain and pass all 36 original proof checks', async () => {
  const { checks, runs } = await run()
  assert.equal(checks.length, 36); assert(checks.every(c => c.ok), JSON.stringify(checks.filter(c => !c.ok)))
  assert.deepEqual(runs.map(r => `${r.theme}-${r.size}`), ['charcoal-1366x900','charcoal-760x900','charcoal-440x900','light-1366x900','light-760x900','light-440x900'])
  for (const r of runs) {
    assert.deepEqual(r.seen.commits, ['', other, ''], 'each variant resets a prior choice and restores it after measurement')
    assert.equal(r.stored, ''); assert.equal(r.seen.closes, 1); assert.equal(r.seen.shots.length, 2)
    assert.equal(r.value.persisted.before.default_account, '')
    assert.equal(r.value.persisted.after.default_account, other)
    assert.equal(r.value.persisted.restored.default_account, '')
  }
})

test('a missing auto-save cannot advance to measurement or reset', async () => {
  await assert.rejects(drive({ org: 'fixture-org', theme: 'charcoal', other, tag: 'no-save' }, '760x900', { save: false }), /persistence wait timed out/)
})

test('saving the wrong account cannot pass from a locally selected option', async () => {
  await assert.rejects(drive({ org: 'fixture-org', theme: 'light', other, tag: 'wrong-save' }, '440x900', { wrongSaved: true }), /persistence wait timed out/)
})

test('missing permission neighbour still fails all six neighbour checks, with all 36 executed', async () => {
  const { checks } = await run({ fault: 'neighbour' })
  assert.equal(checks.length, 36)
  const failed = checks.filter(c => !c.ok)
  assert.equal(failed.length, 6); assert(failed.every(c => c.what.endsWith('the neighbouring rows stay inside the panel')))
})

test('a picker width change remains a failure in every theme and width', async () => {
  const { checks } = await run({ fault: 'width' })
  assert.equal(checks.length, 36)
  const failed = checks.filter(c => !c.ok)
  assert.equal(failed.length, 6); assert(failed.every(c => c.what.includes('the picker keeps its width')))
})

test('the original tooltip, whole-button, hint and horizontal-overflow predicates remain effective', async () => {
  for (const [fault, phrase] of [['tooltip','whole label in the tooltip'],['button','nothing scrolls sideways'],['hint','help line in both states'],['overflow','nothing scrolls sideways']]) {
    const { checks } = await run({ fault })
    assert.equal(checks.length, 36)
    assert.equal(checks.filter(c => !c.ok && c.what.includes(phrase)).length, 6, fault)
  }
})
