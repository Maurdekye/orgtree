import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { EMPTY_LAYOUT, TemplatePicker, type LayoutChoice } from '../src/shell/templatepicker'
import type { TemplatePlan, TemplateSummary } from '../src/api'
import { presetPlan, presetSummaries } from './templateavailability.fixture'

function Harness() {
  const [choice, setChoice] = useState<LayoutChoice>(EMPTY_LAYOUT)
  const [plan, setPlan] = useState<TemplatePlan | null>(null)
  return <TemplatePicker choice={choice} onChange={setChoice} plan={plan} onPlan={setPlan} orgName="Availability" dirs={[]} />
}
const settle = () => inAct(async () => { await new Promise(r => setTimeout(r, 240)); await flush(4) })
const click = (el: Element) => inAct(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await flush(4) })
const row = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('.tp-row')]
  .find(e => e.querySelector('.tp-name')?.textContent === name)!
function backend(summary: () => TemplateSummary[], checking = () => false) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const payload = path.endsWith('/resolve') ? presetPlan(body.id, body.overrides, checking()) :
      { templates: summary(), dir: '/fixture', loading: checking() }
    return { ok: true, status: 200, headers: new Headers(), json: async () => payload }
  }) as typeof fetch
}

test('unavailable presets are compact dim rows, still selectable, in filename order', async () => {
  backend(() => presetSummaries())
  const v = await mountView(<Harness />, el => el)
  try {
    await settle()
    const missing = row('devteam (Antigravity)')
    assert.ok(missing.classList.contains('unusable'))
    assert.ok(missing.classList.contains('collapsed'))
    assert.equal(missing.disabled, false)
    assert.ok(missing.querySelector('.tp-mini') === null)
    assert.ok(missing.querySelector('.tp-desc') === null)
    assert.equal(missing.querySelector('.tp-reason')?.textContent, 'needs Antigravity')
    assert.deepEqual([...v.el.querySelectorAll('.tp-name')].map(e => e.textContent),
      ['Empty', 'devteam (Antigravity)', 'devteam (Claude)', 'mixed team'])
    await click(missing); await settle()
    assert.equal(row('devteam (Antigravity)').getAttribute('aria-selected'), 'true')
    assert.ok(!row('devteam (Antigravity)').classList.contains('collapsed'))
  } finally { await v.unmount() }
})

test('selecting an unusable preset warns and lets available model choices clear that warning', async () => {
  backend(() => presetSummaries())
  const v = await mountView(<Harness />, el => el)
  try {
    await settle(); await click(row('devteam (Antigravity)')); await settle()
    assert.match(v.el.querySelector('.tp-unusable-warning')?.textContent ?? '', /unless you change their models/)
    const select = v.el.querySelector<HTMLSelectElement>('select[aria-label="tier of coordinator"]')!
    await inAct(async () => { select.value = 'opus'; select.dispatchEvent(new window.Event('change', { bubbles: true })); await flush(4) })
    await settle()
    assert.ok(v.el.querySelector('.tp-unusable-warning') === null)
    assert.ok(!row('devteam (Antigravity)').classList.contains('unusable'))
    assert.match(v.el.querySelector('.tp-preview .tp-bad')?.textContent ?? '', /Antigravity/)
    assert.match(v.el.textContent ?? '', /1 agent cannot run/, 'remaining blocked slots retain their ordinary notes')
  } finally { await v.unmount() }
})

test('partially available presets stay normal and retain per-slot notes', async () => {
  backend(() => presetSummaries())
  const v = await mountView(<Harness />, el => el)
  try {
    await settle()
    assert.ok(!row('mixed team').classList.contains('collapsed'))
    assert.ok(!row('mixed team').classList.contains('unusable'))
    await click(row('mixed team')); await settle()
    assert.ok(v.el.querySelector('.tp-unusable-warning') === null)
    assert.match(v.el.querySelector('.tp-bad')?.textContent ?? '', /Antigravity/)
  } finally { await v.unmount() }
})

test('checking is not unusable and Reload can show the completed availability result', async () => {
  let checking = true
  backend(() => presetSummaries(checking), () => checking)
  const v = await mountView(<Harness />, el => el)
  try {
    await settle()
    assert.ok(!row('devteam (Antigravity)').classList.contains('unusable'))
    checking = false
    await click([...v.el.querySelectorAll('button')].find(b => b.textContent === 'Reload')!)
    await settle()
    assert.ok(row('devteam (Antigravity)').classList.contains('collapsed'))
  } finally { await v.unmount() }
})

test('invalid preset files retain their disabled validation state', async () => {
  backend(() => [{ id: null, name: 'broken.json', path: '/fixture/broken.json', source: 'folder', agents: [], problems: ['invalid JSON'] }])
  const v = await mountView(<Harness />, el => el)
  try { await settle(); assert.equal(row('broken.json').disabled, true); assert.ok(row('broken.json').classList.contains('invalid')) }
  finally { await v.unmount() }
})

test('unknown availability is not presented as unavailable', async () => {
  backend(() => presetSummaries().map(({ availability: _availability, ...summary }) => summary))
  const v = await mountView(<Harness />, el => el)
  try { await settle(); assert.ok(!row('devteam (Antigravity)').classList.contains('unusable')) }
  finally { await v.unmount() }
})
