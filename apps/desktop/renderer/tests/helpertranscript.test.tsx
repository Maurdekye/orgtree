import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolChip } from '../src/canvas/desk'

test('expanding a helper call reads its transcript live, one level only, and stops reading on collapse', async t => {
  useFakeClock()
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  let text = 'Inspecting the synthetic fixture'
  globalThis.fetch = (async input => {
    const url = String(input); calls.push(url)
    return new Response(JSON.stringify(url.includes('/helpertranscript/')
      ? { messages: [{ id: 'helper-message', text, tools: [{ id: 'nested', name: 'Agent', input: { prompt: 'Nested task' }, result: 'Nested result' }] }], live: true }
      : { input: { prompt: 'Synthetic task' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const view = await mountView(<ToolChip t={{ id: 'helper/1', name: 'Agent', input_seq: 7, helper_transcript: true }} slug="test org" nid="worker" />, el => el.textContent ?? '')
  t.after(async () => { await view.unmount(); globalThis.fetch = originalFetch; realClock() })
  assert.equal(calls.length, 0, 'collapsed calls do not fetch')
  await inAct(() => view.el.querySelector<HTMLElement>('.tline')!.click()); await flush()
  assert.match(view.last(), /Inspecting the synthetic fixture/)
  assert.ok(calls.includes('/api/orgs/test%20org/nodes/worker/helpertranscript/7/helper%2F1'))
  text = 'The helper is still working'
  await advance(1500)
  assert.match(view.last(), /The helper is still working/)
  const nested = view.el.querySelector<HTMLDetailsElement>('.helper-transcript details')
  assert.ok(nested, 'helper tools keep ordinary expandable details')
  await inAct(() => { nested.open = true; nested.dispatchEvent(new Event('toggle')) })
  assert.match(view.last(), /Nested task/)
  assert.equal(view.el.querySelectorAll('.helper-transcript').length, 1, 'no recursive helper transcript')
  assert.equal(calls.some(url => url.includes('/nested')), false, 'no nested transcript request')
  await inAct(() => view.el.querySelector<HTMLElement>('.tline')!.click()); await flush()
  const count = calls.length
  await advance(3000)
  assert.equal(calls.length, count, 'collapse removes the live reader')
})

test('unavailable helper transcripts explain the limit and offer retry after a read error', async t => {
  const originalFetch = globalThis.fetch
  let failed = true
  globalThis.fetch = (async input => new Response(JSON.stringify(String(input).includes('/helpertranscript/')
    ? failed ? { error: 'Synthetic read failed' } : { messages: [], live: false, note: 'This harness did not expose a helper transcript.' }
    : { input: {} }), { status: String(input).includes('/helpertranscript/') && failed ? 503 : 200,
      headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  const view = await mountView(<ToolChip t={{ id: 'unsupported', name: 'invoke_subagent', input_seq: 9, result: 'done' }} slug="org" nid="worker" />, el => el.textContent ?? '')
  t.after(async () => { await view.unmount(); globalThis.fetch = originalFetch })
  await inAct(() => view.el.querySelector<HTMLElement>('.tline')!.click()); await flush()
  assert.ok(view.el.querySelector('.helper-transcript [role="alert"]'))
  failed = false
  await inAct(() => view.el.querySelector<HTMLButtonElement>('.helper-transcript button')!.click()); await flush()
  assert.match(view.last(), /This harness did not expose a helper transcript/)
})

test('an ordinary tool expansion does not request a helper transcript', async t => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async input => { calls.push(String(input)); return new Response('{"input":{}}', { headers: { 'Content-Type': 'application/json' } }) }) as typeof fetch
  const view = await mountView(<ToolChip t={{ id: 'read', name: 'Read', input_seq: 11 }} slug="org" nid="worker" />, el => el.textContent ?? '')
  t.after(async () => { await view.unmount(); globalThis.fetch = originalFetch })
  await inAct(() => view.el.querySelector<HTMLElement>('.tline')!.click()); await flush()
  assert.equal(calls.some(url => url.includes('/helpertranscript/')), false)
})
