// Actual driver replay with synthetic navigation and a clipped Save modal.
// No engine/window or settings write. Full 18-check runtime stays with the rig.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const file = 'tools/rig/desktop/template-quickchat.cjs'
const source = process.env.TEMPLATE_QUICKCHAT_DRIVER_REF
  ? execFileSync('git', ['show', `${process.env.TEMPLATE_QUICKCHAT_DRIVER_REF}:${file}`], { cwd: repo, encoding: 'utf8' })
  : fs.readFileSync(path.join(repo, file), 'utf8')
const proofFile = 'tools/rig/proofs/template-quickchat.mjs'
const proof = process.env.TEMPLATE_QUICKCHAT_DRIVER_REF
  ? execFileSync('git', ['show', `${process.env.TEMPLATE_QUICKCHAT_DRIVER_REF}:${proofFile}`], { cwd: repo, encoding: 'utf8' })
  : fs.readFileSync(path.join(repo, proofFile), 'utf8')
const first = proof.indexOf('  const gs =')
const last = proof.indexOf('  const saved =', first)
assert(first >= 0 && last > first, 'the actual checkbox predicate must be present')
const checkbox = new Function('v', 'p', proof.slice(first, last))
const plain = value => JSON.parse(JSON.stringify(value))

async function drive({ compatibleCase = false, missing = '', rejectSave = false } = {}) {
  const seen = { shots: [], clicks: [], waits: [], routes: [], parentActions: 0 }
  const picks = new Map()
  let org, lastPick = 'opus', modal = false, saved = null, script
  class Input {
    get value() { return this.current }
    set value(value) { this.current = value }
    dispatchEvent() {}
  }
  const input = new Input()
  const template = { superior: 'coordinator', model: 'opus' }
  const shown = () => org === 'seed'
    ? { superior: 'top level', model: lastPick }
    : { ...template, model: picks.get(org) ?? template.model }
  const groups = [
    { text: 'Quick chat defaults · the superior, model and effort it starts with here', checked: true },
    { text: 'Org defaults and project queue/event settings · grant caps', checked: true },
  ]
  const context = vm.createContext({
    module: { exports: {} }, location: { pathname: '/' }, HTMLInputElement: Input,
    Event: class {},
    document: {
      querySelector(selector) {
        if (selector.includes('.quickchat-superior .quickchat-label')) return { textContent: shown().superior }
        if (selector.includes('.quickchat-model .tier')) return { classList: ['tier', `t-${shown().model}`] }
        if (selector.includes('.effort-bar-track')) return { dataset: { effortPinned: '' } }
        if (selector === '.quickchat-pop-model .hsof button.t-haiku') return { click() { picks.set(org, 'haiku'); lastPick = 'haiku' } }
        if (selector === '#save-template-name' && modal) return input
        throw new Error(`unexpected selector ${selector}`)
      },
      querySelectorAll(selector) {
        if (selector === 'button') return [{ title: 'Organization settings', getAttribute: () => null, click() {} }]
        if (selector === '.save-template-groups label' && modal) return groups.map(row => ({
          textContent: row.text, querySelector: () => ({ checked: row.checked }),
        }))
        throw new Error(`unexpected selector ${selector}`)
      },
    },
  })
  context.window = context
  vm.runInContext(source, context)
  function label(target) {
    if (!target?.text) return null
    const labels = ['Save as template…', ...(modal ? ['Save template'] : []), ...(saved ? ['Download qc-from-desktop.json'] : [])]
    const match = labels.find(text => text !== missing && new RegExp(target.text, compatibleCase ? 'i' : target.flags || '').test(text))
    if (!match) throw new Error(`unavailable control ${target.text}`)
    return match
  }
  const page = {
    async cdp(method, args) { if (method === 'Page.addScriptToEvaluateOnNewDocument') script = args.source },
    async goto(route) { seen.routes.push(route); org = route.split('/').at(-1); context.location.pathname = route; vm.runInContext(script, context) },
    async resize(size) { assert.equal(size, '1600x900') },
    async sleep() {},
    async screenshot(shot) { seen.shots.push(shot) },
    async eval(fn, ...args) { context.args = args; return vm.runInContext(`(${fn.toString()})(...args)`, context) },
    async waitFor(target) {
      seen.waits.push(plain(target))
      if (typeof target === 'string') {
        if (target === '#save-template-name') assert.equal(modal, true)
        return true
      }
      label(target)
    },
    async click(target) {
      seen.clicks.push(plain(target))
      if (typeof target === 'string') {
        assert.equal(target, '[data-testid="quickchat"] .quickchat-model')
        return
      }
      const text = label(target)
      if (text === 'Save as template…') modal = true
      else if (text === 'Save template') {
        // At this viewport the Save button is below the modal's scroll clip.
        // An unscrolled coordinate click misses it and dismisses the overlay.
        if (target.scroll !== true) { modal = false; return }
        if (!rejectSave) saved = { name: input.value, quick_chat: { superior: shown().superior, tier: shown().model } }
      } else { seen.parentActions++; throw new Error('unexpected parent settings action') }
    },
  }
  const value = await context.module.exports(page, { args: { a: 'alpha', b: 'beta', seed: 'seed', name: 'QC from desktop' } })
  return { value: plain(value), saved, seen }
}

test('actual driver preserves per-org Quick chat picks and reaches a clipped Save control', async () => {
  const { value, saved, seen } = await drive()
  assert.deepEqual([value.aFresh.model, value.aPicked.model, value.bFresh.model, value.seed.model, value.aAgain.model], ['opus', 'haiku', 'opus', 'haiku', 'haiku'])
  assert.deepEqual([value.aFresh.superior, value.aPicked.superior, value.bFresh.superior, value.seed.superior], ['coordinator', 'coordinator', 'coordinator', 'top level'])
  assert.deepEqual(saved, { name: 'QC from desktop', quick_chat: { superior: 'coordinator', tier: 'haiku' } })
  assert.equal(value.groups.length, 2)
  assert.equal(value.groups.every(group => group.checked), true)
  assert.equal(value.groups[1].text.startsWith('Org defaults and project queue/event settings'), true)
  assert.deepEqual(seen.shots, ['1-org-a-template-defaults', '2-org-a-picked-haiku', '3-org-b-template-defaults', '4-seed-org-last-pick', '5-save-modal', '6-saved'])
  assert.equal(seen.parentActions, 0)
  assert.equal(seen.waits.find(target => target.text === '^Download ')?.scroll, true)
})
test('case-compatible locator isolates the later offscreen Save/Download setup seam', async () => {
  const { saved } = await drive({ compatibleCase: true })
  assert.equal(saved.quick_chat.tier, 'haiku')
})
test('a missing Save as template control still rejects the driver', async () => {
  await assert.rejects(drive({ missing: 'Save as template…' }), /unavailable control/)
})
test('a missing Save template control still rejects the driver', async () => {
  await assert.rejects(drive({ missing: 'Save template' }), /unavailable control/)
})
test('a refused save or missing Download still rejects instead of returning partial values', async () => {
  await assert.rejects(drive({ rejectSave: true }), /unavailable control/)
  await assert.rejects(drive({ missing: 'Download qc-from-desktop.json' }), /unavailable control/)
})
test('actual settings checkbox lookup keeps current caption and strict missing or unticked guards', () => {
  const label = 'Org defaults and project queue/event settings · grant caps'
  const check = groups => {
    let result
    checkbox({ groups }, { check(_name, passed) { result = !!passed } })
    return result
  }
  assert.equal(check([{ text: label, checked: true }]), true)
  assert.equal(check(undefined), false)
  assert.equal(check([]), false)
  assert.equal(check([{ text: label, checked: false }]), false)
  assert.equal(check([{ text: label }]), false)
  assert.equal(check([{ text: 'Unrelated settings', checked: true }]), false)
})
