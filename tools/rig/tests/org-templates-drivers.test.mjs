// Replay the actual bridge, drivers and restore predicates without a window or
// engine. This checks the instrument; the full 22-check proof remains separate.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const read = file => (process.env.ORG_TEMPLATE_FIXTURE_REF
  ? execFileSync('git', ['show', `${process.env.ORG_TEMPLATE_FIXTURE_REF}:${file}`], { cwd: repo, encoding: 'utf8' })
  : fs.readFileSync(path.join(repo, file), 'utf8')).replaceAll('\r\n', '\n')
const driver = name => read(`tools/rig/desktop/org-templates-${name}.cjs`)
const proof = read('tools/rig/proofs/org-templates.mjs')
const plain = value => JSON.parse(JSON.stringify(value))

async function bridge() {
  const context = vm.createContext({ module: { exports: {} }, window: {} })
  vm.runInContext(driver('create'), context)
  const stop = new Error('stop before loading a renderer')
  let installed = false
  await assert.rejects(context.module.exports({
    async cdp(method, args) {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        vm.runInContext(args.source, context)
        installed = true
      } else assert.equal(method, 'Page.enable')
    },
    async goto(route) { assert.equal(route, '/'); throw stop },
  }, { args: {} }), error => error === stop)
  assert.equal(installed, true)
  return context.window.orgtreeDesktop
}

const downloadText = JSON.stringify({ id: 'rig-layout-two', agents: [{ name: 'boss', tier: 'sol' }] })
async function drive(name, { buttons = ['Save as template…', 'Save template', 'Download rig-layout-two.json', 'Restore'] } = {}) {
  const seen = { waits: [], clicks: [], shots: [], events: [] }
  class Input {
    set value(value) { this.current = value }
    get value() { return this.current }
    dispatchEvent() {}
  }
  class Anchor { click() {} }
  const input = new Input()
  const body = 'Runtime Charter documents Organization templates Restored 2 templates · 3 already present and untouched'
  const context = vm.createContext({
    module: { exports: {} }, Blob, HTMLInputElement: Input, HTMLAnchorElement: Anchor,
    Event: class { constructor(type) { this.type = type } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } },
    URL: { createObjectURL: () => 'blob:synthetic-template' },
    document: {
      body: { innerText: body },
      querySelector(selector) {
        if (selector === '#save-template-name') return input
        if (selector === '.save-template') return { innerText: 'Saved rig-layout-two.json' }
        throw new Error(`unexpected document selector ${selector}`)
      },
      querySelectorAll(selector) {
        assert.equal(selector, 'h4, .set-group-title, legend')
        return ['Charter documents', 'Organization templates'].map(innerText => ({ innerText }))
      },
    },
    dispatchEvent(event) { seen.events.push(plain(event)) },
  })
  context.window = context
  vm.runInContext(driver(name), context)
  function locate(target) {
    if (target?.text && !buttons.some(text => target.regex
      ? new RegExp(target.text, target.flags || '').test(text) : text === target.text)) {
      throw new Error(`unavailable button ${target.text}`)
    }
  }
  const page = {
    async waitFor(target) { seen.waits.push(plain(target)); locate(target) },
    async click(target) {
      seen.clicks.push(plain(target)); locate(target)
      if (target?.text === '^Download ') {
        context.payload = downloadText
        vm.runInContext("URL.createObjectURL(new Blob([payload], { type: 'application/json' })); const anchor = new HTMLAnchorElement(); anchor.download = 'rig-layout-two.json'; anchor.click()", context)
      }
    },
    async sleep() {},
    async screenshot(shot) { seen.shots.push(shot) },
    async eval(fn, ...args) {
      context.args = args
      return vm.runInContext(`(${fn.toString()})(...args)`, context)
    },
  }
  const value = await context.module.exports(page, { args: { shot: name, name: 'Rig layout two' } })
  return { value: plain(value), seen, name: input.value }
}

function predicate(begin, end, args) {
  const start = proof.indexOf(begin)
  const finish = proof.indexOf(end, start)
  assert(start >= 0 && finish > start, 'the actual proof predicate must be present')
  return new Function(...args, proof.slice(start, finish))
}
const restored = predicate("  p.check('desktop: App settings → Runtime", '  const pop =', ['shotApp', 'fs', 'path', 'tpDir', 'p'])
const idempotent = predicate("  p.check('restoring again changes nothing", '  return p.summary()', ['pop', 'p'])
function restoreCheck({ ok = true, snippet = 'Restored 2 templates · 3 already present and untouched', files = ['devteam-claude.json', 'devteam-codex.json'] } = {}) {
  let passed
  restored({ ok, value: { snippet } }, { existsSync: file => files.includes(path.basename(file)) }, path, 'synthetic', { check(_name, pass) { passed = !!pass } })
  return passed
}
function idempotencyCheck(pop) {
  let passed
  idempotent(pop, { check(_name, pass) { passed = !!pass } })
  return passed
}

test('fresh create bridge returns a null Promise for the changelog and synchronous cleanup', async () => {
  const desktop = await bridge()
  const pending = desktop.takeChangelogAfterUpdate()
  assert.equal(typeof pending.then, 'function')
  assert.equal(await pending, null)
  const cleanup = desktop.onEvent(() => {})
  assert.equal(typeof cleanup, 'function')
  assert.equal(cleanup(), undefined)
  assert.equal(await desktop.requestOrg(), null)
})
test('create bridge still refuses unknown methods by name', async () => {
  const desktop = await bridge()
  assert.throws(() => desktop.futureUnknownMethod, /unsupported member futureUnknownMethod; add a contract-correct stub/)
  assert.equal(desktop.then, undefined)
})
test('actual Save driver reaches the modal and captures exact downloaded name and content', async () => {
  const { value, seen, name } = await drive('save')
  assert.equal(name, 'Rig layout two')
  assert.deepEqual(seen.shots, ['save-settings', 'save-modal', 'save-saved'])
  assert(value.downloads.some(row => row.anchor === 'rig-layout-two.json'))
  assert(value.downloads.some(row => row.text === downloadText && row.size === Buffer.byteLength(downloadText)))
  assert(seen.waits.some(target => target.text === '^Save as template…$'))
})
test('actual Runtime driver clicks Restore and reads its result', async () => {
  const { value, seen } = await drive('app')
  assert.deepEqual(seen.shots, ['app-before', 'app-generated'])
  assert.deepEqual(seen.events, [{ type: 'orgtree:open-app-settings', detail: { tab: 'runtime' } }])
  assert(seen.clicks.some(target => target.text === '^Restore$'))
  assert.equal(restoreCheck({ snippet: value.snippet }), true)
})
test('missing Save or Restore controls still reject their actual drivers', async () => {
  await assert.rejects(drive('save', { buttons: [] }), /unavailable button/)
  await assert.rejects(drive('app', { buttons: [] }), /unavailable button/)
})
test('actual restore predicate requires both default files, successful driver and exact restored count', () => {
  assert.equal(restoreCheck(), true)
  assert.equal(restoreCheck({ ok: false }), false)
  assert.equal(restoreCheck({ files: ['devteam-claude.json'] }), false)
  assert.equal(restoreCheck({ snippet: 'Restored 1 template' }), false)
  assert.equal(restoreCheck({ snippet: '' }), false)
})
test('actual final restore predicate retains zero created, five existing and antigravity identity guards', () => {
  const existing = ['devteam-claude.json', 'devteam-codex.json', 'devteam-muse.json', 'devteam-antigravity.json', 'heavy-dev-shop.json']
  assert.equal(idempotencyCheck({ created: [], existing }), true)
  assert.equal(idempotencyCheck({ created: ['devteam-claude.json'], existing }), false)
  assert.equal(idempotencyCheck({ created: [], existing: existing.slice(1) }), false)
  assert.equal(idempotencyCheck({ created: [], existing: existing.map(file => file === 'devteam-antigravity.json' ? 'unknown.json' : file) }), false)
})
