import { mountView, inAct, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { NativeReplacementToggle, nativeToolCoverage } from '../src/canvas/nativepermissions'
import { AskCard } from '../src/canvas/asks'
import { elicitationFixture } from './elicitation-fixture'

test('native replacement toggle is off initially, respects a blocked superior and submits the explicit choice', async () => {
  const changed: boolean[] = []
  const blocked = await mountView(<NativeReplacementToggle checked={false} disabled harness="claude-code"
    onChange={next => changed.push(next)} />, el => el)
  try {
    const input = blocked.el.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    assert.equal(input.checked, false); assert.equal(input.disabled, true)
    await inAct(async () => { input.click(); await flush(1) })
    assert.equal(changed.length, 0)
    assert.equal(blocked.el.textContent!.includes('superior does not have'), true)
  } finally { await blocked.unmount() }
  function Editable() {
    const [enabled, setEnabled] = useState(false)
    return <NativeReplacementToggle checked={enabled} harness="muse" onChange={next => { changed.push(next); setEnabled(next) }} />
  }
  const view = await mountView(<Editable />, el => el)
  try {
    const input = view.el.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    assert.equal(input.checked, false)
    await inAct(async () => { input.click(); await flush(1) })
    assert.equal(input.checked, true); assert.deepEqual(changed, [true])
    assert.equal(view.el.textContent!.includes('Not affected: reminder observers'), true)
  } finally { await view.unmount() }
})

test('coverage names the restored tools and the approved exclusions for every harness', () => {
  for (const tool of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'Monitor', 'RemoteTrigger']) {
    assert.equal(nativeToolCoverage('claude-code').includes(tool), true)
  }
  assert.equal(nativeToolCoverage('codex-cli').includes('request_user_input'), true)
  assert.equal(nativeToolCoverage('muse').includes('contributor mode'), true)
  assert.equal(nativeToolCoverage('antigravity').includes('no Orgtree replacement tools'), true)
  assert.equal(nativeToolCoverage('opencode').includes('Code Mode security policy'), true)
})

test('native request uses the correlated private card endpoint with an explicit answer and native title', async () => {
  const ask = elicitationFixture('elicitation-native-test')
  ask.elicitation = { ...ask.elicitation!, native_tool: true, server: 'Claude Code plan approval',
    schema: { type: 'object', properties: { q0: { type: 'string', title: 'Approve this plan?', enum: ['Approve', 'Reject'] } } } }
  const original = globalThis.fetch, sent: { url: string; body: unknown }[] = []
  globalThis.fetch = (async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const view = await mountView(<AskCard ask={ask} slug="fixture" toast={() => {}} />, el => el)
  try {
    assert.equal(sent.length, 0)
    assert.equal(view.el.querySelector('strong')!.textContent, 'Claude Code plan approval')
    const choice = view.el.querySelector<HTMLSelectElement>('select')!
    assert.equal(choice.value, '', 'there is no default plan approval')
    await inAct(async () => { choice.value = 'Approve'; choice.dispatchEvent(new Event('change', { bubbles: true })); await flush(1) })
    await inAct(async () => { view.el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush(2) })
    assert.deepEqual(sent, [{ url: '/api/orgs/fixture/asks/elicitation-native-test/answer', body: { action: 'accept', content: { q0: 'Approve' } } }])
  } finally { await view.unmount(); globalThis.fetch = original }
})
