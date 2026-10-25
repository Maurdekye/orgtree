// Cheap controls for both actual Done seams and the complete original proof.
// Synthetic page/results only: no window, engine, server, database or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const read = file => (process.env.PROVIDER_CHIPS_FIXTURE_REF
  ? execFileSync('git', ['show', `${process.env.PROVIDER_CHIPS_FIXTURE_REF}:${file}`], { cwd: repo, encoding: 'utf8' })
  : fs.readFileSync(path.join(repo, file), 'utf8')).replaceAll('\r\n', '\n')
const driver = read('tools/rig/desktop/provider-chips.cjs')
const proof = read('tools/rig/proofs/provider-chips.mjs')
const scopeNames = ['.ls-browser .orr-pager', '.orr-picker .orr-pager']
const seams = [...driver.matchAll(/await tagButton\('[^\n]+\n  await press\('[^\n]+/g)].map(m => m[0])
assert.equal(seams.length, 2)
const helpers = driver.slice(driver.indexOf('  const scrollTo ='), driver.indexOf('  /** click the chip'))
assert(helpers.includes('const tagButton =') && helpers.includes('const press ='))

// Execute the actual tagButton/press closures and each original call site.
// Centre-hit geometry is synthetic; the real rig retains its native hit test.
async function pressDone(index, { present = true, covered = false } = {}) {
  let clicked = 0
  const attrs = new Map()
  const button = { innerText: 'Done', setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: k => attrs.delete(k), scrollIntoView() {}, contains: () => false,
    getBoundingClientRect: () => ({ x: 20, y: 30, width: 80, height: 30 }) }
  const document = {
    querySelectorAll(selector) {
      if (selector === `${scopeNames[index]} button`) return present ? [button] : []
      if (selector === '[data-done-target]') return attrs.has('data-done-target') ? [button] : []
      throw new Error(`unexpected selector: ${selector}`)
    },
    querySelector(selector) {
      assert.equal(selector, '[data-done-target]')
      return attrs.has('data-done-target') ? button : null
    },
    elementFromPoint: () => covered ? {} : button,
  }
  const context = vm.createContext({ document, window: {}, assert })
  const page = {
    async eval(fn, ...args) { return vm.runInContext(`(${fn.toString()})(...${JSON.stringify(args)})`, context) },
    async waitFor(fn, options) {
      assert.equal(options.timeout, 30000)
      if (!await this.eval(fn)) throw new Error('Done target unavailable or covered')
    },
    async click(selector) { assert.equal(selector, '[data-done-target]'); clicked++ },
    async mouse() {},
  }
  context.page = page
  await vm.runInContext(`(async () => { ${helpers}\n${seams[index]} })()`, context)
  assert.equal(clicked, 1)
}

for (const [index, scope] of scopeNames.entries()) {
  test(`actual ${scope} Done seam finds the Sentence-case button`, () => pressDone(index))
}
test('either absent or covered Done still rejects before clicking', async () => {
  for (const index of [0, 1]) {
    await assert.rejects(pressDone(index, { present: false }), /Done target unavailable/)
    await assert.rejects(pressDone(index, { covered: true }), /Done target unavailable/)
  }
})

const Q = 'qwen3.6-35b-a3b:latest', Q64 = `${Q}-64k`
const Q38 = 'qwen3.8-27b:latest', Q38V = `${Q38}-64k`
const favorites = ['anthropic/claude-sonnet-5', 'openai/gpt-5.6-luna', 'moonshotai/kimi-k3',
  'google/gemini-3-pro', 'x-ai/grok-5', 'deepseek/deepseek-v4', 'mistralai/mistral-large-3',
  'z-ai/glm-5.2', 'minimax/minimax-m3']
const twelve = Array.from({ length: 12 }, (_, i) => `${['gemma', 'llama', 'mistral', 'phi', 'qwen', 'deepseek'][i % 6]}-${i}:latest`)
const chip = (name, on, title = `${name} · synthetic model`) => ({ name, on, title,
  opacity: on ? '1' : '0.55', border: on ? 'solid' : 'dashed', height: 32, font: '12px' })
const row = (names, on, extra = {}) => ({ chips: names.map((n, i) => chip(n, on[i])),
  icons: false, more: '+', editing: false, browser: false, ...extra })
const userNames = [Q, Q64, Q38, Q38V]
const orNames = favorites.map(id => id.split('/')[1])
const orRow = (on, icons = true) => row(orNames, on, { icons,
  chips: orNames.map((n, i) => chip(n, on[i], i ? `${n} · model` : 'claude-sonnet-5 · Claude Sonnet 5 — anthropic · model')) })
const offered = ids => ids.map(id => ({ id, told: 65536 }))
function goodValue() {
  return {
    start: {
      user: row(userNames, [true, true, false, false]),
      down: row(['llama-4-scout:latest', Q], [true, true], { more: null,
        digest: ['not answering: nothing is answering at that address (is the server running?)'] }),
      ten: row([...twelve].sort((a, b) => a.localeCompare(b)), Array.from({ length: 12 }, (_, i) => i < 10), { icons: true }),
      many: row([Q, Q64], [true, true], { more: '+ 300 more' }),
    },
    afterOffer: { row: row(userNames, [true, true, false, true]), offered: offered([Q, Q64, Q38V]) },
    afterWithdraw: { row: row(userNames, [false, true, false, true]), offered: offered([Q64, Q38V]) },
    down: { row: row(['llama-4-scout:latest', Q], [false, true]), offered: offered([Q]) },
    browser: { title: 'Models on Many models · 2 offered · each change is saved at once',
      after: 'Models on Many models · 3 offered · each change is saved at once', editing: false,
      offered: offered([Q, Q64, 'model-000:7b']), closed: true },
    many: row([Q, Q64, 'model-000:7b'], [true, true, true], { more: '+ 299 more' }),
    or: { start: orRow(Array(9).fill(true)), favorites: [...favorites],
      deselected: { row: orRow([false, ...Array(8).fill(true)], false), favorites: favorites.slice(1) },
      reselected: { row: orRow(Array(9).fill(true)), favorites: [...favorites.slice(1), favorites[0]] },
      picked: { favorites: [...favorites, 'xiaomi/mimo-v2.6-pro'] }, closed: true,
      end: row([...orNames, 'mimo-v2.6-pro'], Array(10).fill(true), { icons: true }) },
    light: { user: row(userNames, [false, true, false, true]) },
  }
}

// Run the entire unchanged default proof body. All imported side effects are
// replaced here, before evaluation: these fake services never listen or write.
async function checkProof({ value = goodValue(), ok = true, consoleErrors = [], reverseCatalog = false } = {}) {
  let closed = 0
  const seen = { value, ok, consoleErrors, shots: [] }
  const context = vm.createContext({ path, RIG_DIR: '/synthetic', SEED_SETTLE_TIMEOUT: 1,
    Proof: class {
      constructor() { this.dir = '/synthetic'; this.checks = [] }
      check(what, pass, detail) { this.checks.push({ what, ok: !!pass, detail }) }
      note() {}
      summary() { return this.checks }
    },
    startFakeLlm: async () => ({ url: 'http://synthetic.invalid', close: async () => { closed++ } }),
    runDesktop: async () => seen,
    fs: new Proxy({}, { get() { throw new Error('proof must not touch files in this control') } }),
  })
  const script = proof.replace(/^import .*\n/gm, '').replace('export async function setup()', 'async function setup()')
    .replace('export default async function (rig)', 'globalThis.prove = async function (rig)')
  vm.runInContext(script, context)
  const rig = { run: { ui: '/synthetic' }, sql: () => [],
    async waitFor(fn) { assert(await fn()) },
    async api(method, route) {
      if (method !== 'GET') return {}
      if (route.startsWith('/api/openrouter/models')) return { total: 12, items: favorites.concat(['extra1', 'extra2', 'extra3']).map(id => ({ id })) }
      if (route === '/api/openrouter') return { connected: true, tiers: (reverseCatalog ? [...favorites].reverse() : favorites).map(model => ({ model })) }
      if (route === '/api/langservers') return { servers: [{ label: 'Ollama', models: {
        [Q38V]: { tier: 'fixture-offered' }, [Q]: { tier: 'fixture-withdrawn' } } }] }
      if (route === '/api/providers') return { providers: [{ id: 'langserver', tiers: [{ tier: 'fixture-offered' }] }] }
      throw new Error(`unexpected API: ${method} ${route}`)
    },
  }
  const result = JSON.parse(JSON.stringify(await context.prove(rig)))
  assert.equal(closed, 3)
  assert.equal(result.length, 16, 'retain all original checks, including the catalog and hire guards')
  return result
}
const failed = rows => rows.filter(r => !r.ok).map(r => r.what)
test('the complete original proof still executes all 16 checks on synthetic good data', async () => {
  assert.deepEqual(failed(await checkProof()), [])
})
test('catalog order, raw SvgIcon/MenuIcon warning and all four OpenRouter negatives remain failures', async () => {
  const value = goodValue()
  value.or.start.icons = false
  value.or.deselected.favorites = favorites
  value.or.reselected.row.icons = false
  value.or.closed = false
  const warning = 'Warning: invalid children supplied to SvgIcon at MenuIcon'
  const rows = await checkProof({ value, consoleErrors: [warning], reverseCatalog: true })
  assert.deepEqual(rows.map((r, i) => !r.ok ? i : -1).filter(i => i >= 0), [0, 1, 10, 11, 12, 13])
  assert.deepEqual(rows[1].detail.consoleErrors, [warning])
})
test('failed-driver empty data retains the original 1 pass / 15 failures', async () => {
  const rows = await checkProof({ value: null, ok: false, reverseCatalog: true })
  assert.equal(failed(rows).length, 15)
  assert.equal(rows[5].ok, true, 'the independent hire-offers guard still executes')
})
test('unsaved offers, unclosed browser/picker, wrong sizes and undimmed light chips still fail', async () => {
  const value = goodValue()
  value.afterOffer.offered = offered([Q, Q64])
  value.browser.closed = false
  value.or.picked.favorites = favorites
  value.start.user.chips[0].height = 40
  value.light.user.chips[0].opacity = '1'
  const rows = await checkProof({ value })
  assert.deepEqual(rows.map((r, i) => !r.ok ? i : -1).filter(i => i >= 0), [3, 9, 13, 14, 15])
})
