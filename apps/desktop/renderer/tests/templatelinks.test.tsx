import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SaveTemplateModal, DEFAULT_INCLUDE } from '../src/canvas/templates'
import { TemplatePicker } from '../src/shell/templatepicker'
import type { TemplatePlan } from '../src/api'

const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })

test('template save opts in portable watchdogs and audiences and opts out machine dogs', async () => {
  assert.equal(DEFAULT_INCLUDE.watchdogs, true)
  assert.equal(DEFAULT_INCLUDE.audiences, true)
  assert.equal(DEFAULT_INCLUDE.machine_watchdogs, false)
  const seen: { include?: Record<string, boolean> } = {}
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.include = JSON.parse(String(init?.body)).include
    return response({ id: 'saved', file: 'saved.json', path: '/fixture/saved.json', content: '{}', agents: 2, problems: [], watchdogs: 3, audiences: 2, warnings: ['Dropped audience grant: outside the saved layout.'] })
  }) as typeof fetch
  const view = await mountView(<SaveTemplateModal slug="fixture" orgName="Fixture" close={() => {}} />, e => e)
  try {
    const dialog = document.querySelector<HTMLElement>('[aria-label="Save as template"]')!
    const input = (label: string) => [...dialog.querySelectorAll('label')].find(l => l.textContent?.includes(label))!.querySelector<HTMLInputElement>('input')!
    assert.equal(input('Include watchdogs').checked, true)
    assert.equal(input('Include audiences').checked, true)
    assert.equal(input('Include machine-specific watchdogs').checked, false)
    await inAct(async () => { input('Include watchdogs').click(); await flush(1) })
    assert.equal(input('Include machine-specific watchdogs').disabled, true)
    await inAct(async () => { input('Include watchdogs').click(); input('Include machine-specific watchdogs').click(); await flush(1) })
    // The second click follows the committed enabling render.
    await inAct(async () => { if (!input('Include machine-specific watchdogs').checked) input('Include machine-specific watchdogs').click(); await flush(1) })
    await inAct(async () => { [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Save template')!.click(); await flush(3) })
    assert.equal(seen.include?.watchdogs, true)
    assert.equal(seen.include?.audiences, true)
    assert.equal(seen.include?.machine_watchdogs, true)
    assert.match(dialog.textContent ?? '', /3 watchdogs · 2 explicit audience grants/)
    assert.match(dialog.textContent ?? '', /Dropped audience grant/)
  } finally { await view.unmount() }
})

test('template preview discloses watchdog count and user extern grants beside the node', async () => {
  const plan: TemplatePlan = { id: 'layout', name: 'Layout', ok: true, blocked: [], org_md: false, top_grant: 2, offered: [], warnings: ['Machine-specific watchdog remains paused.'], agents: [{
    slot: 'worker', name: 'builder', parent: null, depth: 0, tier: 'sol', requested_tier: 'sol', note: null, account: 'primary', provider: 'openai', seat: 2, grant: 2, charter: 'text', team_charter: null, kickoff: false, blocked: false, dirs_dropped: [], watchdogs: 2, audiences: ['@user', '@extern', 'coordinator'],
  }] }
  globalThis.fetch = (async () => response({ templates: [], loading: false })) as typeof fetch
  const view = await mountView(<TemplatePicker choice={{ id: 'layout', overrides: {}, removed: [], kickoff: false }} onChange={() => {}} plan={plan} onPlan={() => {}} orgName="Fixture" dirs={[]} />, e => e)
  try {
    await inAct(async () => { await flush(2) })
    const row = view.el.querySelector('input[aria-label="name of worker"]')!.closest('tr')!
    assert.match(row.textContent ?? '', /2 watchdogs/)
    assert.match(row.textContent ?? '', /Audience grants: user, outside mail, coordinator/)
    assert.match(view.el.querySelector('[role="alert"]')?.textContent ?? '', /remains paused/)
  } finally { await view.unmount() }
})
