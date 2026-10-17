import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolChip } from '../src/canvas/desk'
import { HelperTranscript } from '../src/canvas/helpertranscript'
import { FoldProvider, useFoldState } from '../src/canvas/foldstate'

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

test('completed helper reads stop polling and explain retained truncation', async t => {
  useFakeClock()
  const originalFetch = globalThis.fetch
  let reads = 0
  globalThis.fetch = (async input => {
    const helper = String(input).includes('/helpertranscript/')
    if (helper) reads++
    return new Response(JSON.stringify(helper ? { messages: [{ id: 'm', text: 'Retained result' }], live: false, truncated: true } : { input: {} }),
      { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const view = await mountView(<ToolChip t={{ id: 'finished', name: 'Task', input_seq: 12, result: 'done' }} slug="org" nid="worker" />, el => el.textContent ?? '')
  t.after(async () => { await view.unmount(); globalThis.fetch = originalFetch; realClock() })
  await inAct(() => view.el.querySelector<HTMLElement>('.tline')!.click()); await flush()
  assert.match(view.last(), /Retained result/)
  assert.match(view.last(), /size limit/)
  await advance(3000)
  assert.equal(reads, 1)
})

test('helper messages use desk Markdown, thinking and ordered expandable tool chips with supplied metadata', async t => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  const text = '**Before**After'
  globalThis.fetch = (async input => {
    calls.push(String(input))
    return new Response(JSON.stringify({ live: false, messages: [{ id: 'm', text,
      thinking: '*Reasoning*', think_secs: 3, tools: [{ id: 'nested', name: 'Agent',
        input_text: '{"prompt":"Retained input"}', result: 'Retained output',
        started_at: '2026-10-17T15:00:00Z', ended_at: '2026-10-17T15:00:02Z', task: { tokens: 2000 } }],
      content_blocks: [{ kind: 'text', start: 0, end: 10 }, { kind: 'thinking', start: 0, end: 11 },
        { kind: 'tool', id: 'nested' }, { kind: 'text', start: 10, end: text.length }] }] }),
      { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const view = await mountView(<HelperTranscript slug="org" nid="worker" seq={8} tool="root" />, el => el.textContent ?? '')
  t.after(async () => { await view.unmount(); globalThis.fetch = originalFetch })
  await flush()
  assert.ok(view.el.querySelector('.msg.assistant .msgtext.md strong'), 'normal desk Markdown renders helper prose')
  const message = view.el.querySelector('.msg.assistant')!
  assert.deepEqual(Array.from(message.children).slice(0, 4).map(el => el.className), ['msgtext md', 'reply-event', 'tools tchip', 'msgtext md'])
  assert.match(view.last(), /thought for 3s/)
  assert.ok(view.el.querySelector('[aria-label="ran for 2.0s"]'))
  assert.match(view.last(), /2k tok/)
  await inAct(() => view.el.querySelector<HTMLElement>('.thoughtline')!.click())
  assert.ok(view.el.querySelector('.thoughtbody.md em'))
  await inAct(() => view.el.querySelector<HTMLElement>('.helper-transcript .tline')!.click())
  await flush()
  assert.match(view.last(), /Retained input/)
  assert.match(view.last(), /Retained output/)
  assert.equal(view.last().includes('older tool call'), false, 'retained input does not use parent toolinput lookup')
  assert.equal(view.el.querySelectorAll('.helper-transcript').length, 1)
  assert.equal(calls.length, 1, 'nested helper tools never read parent toolinput or recurse')
})

test('helper clipped arguments remain visible and absent timing and token values stay unknown', async t => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ live: false,
    messages: [{ id: 'm', text: '', tools: [{ id: 'read', name: 'Read', input_text: '{"file_path":"clipped', result: 'ok' }] }] }),
    { headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  const view = await mountView(<HelperTranscript slug="org" nid="worker" seq={9} tool="root" />, el => el.textContent ?? '')
  t.after(async () => { await view.unmount(); globalThis.fetch = originalFetch })
  await flush()
  const chip = view.el.querySelector<HTMLElement>('.tline')
  assert.ok(chip, 'normal tool chip renders even without clocks')
  await inAct(() => chip.click()); await flush()
  assert.match(view.last(), /clipped/)
  assert.ok(view.el.querySelector('[aria-label="execution time unavailable"]'))
  assert.equal(view.last().includes('tok'), false)
  assert.equal(view.last().includes('ran for'), false)
})

test('helper native IDs cannot share a fold with parent or sibling helper calls', async t => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ live: false,
    messages: [{ id: 'same', text: '', tools: [{ id: 'same', name: 'Read', input_text: '{}', result: 'private result' }] }] }),
    { headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  function Fixture() {
    const folds = useFoldState()
    return <FoldProvider value={folds.store}>
      <ToolChip t={{ id: 'same', name: 'Read', result: 'parent result' }} slug="org" nid="worker" />
      <HelperTranscript slug="org" nid="worker" seq={9} tool="a" />
      <HelperTranscript slug="org" nid="worker" seq={9} tool="b" />
    </FoldProvider>
  }
  const view = await mountView(<Fixture />, el => el.textContent ?? '')
  t.after(async () => { await view.unmount(); globalThis.fetch = originalFetch })
  await flush()
  const chips = view.el.querySelectorAll<HTMLElement>('.helper-transcript .tline')
  assert.equal(chips.length, 2)
  await inAct(() => chips[0].click())
  const helpers = view.el.querySelectorAll('.helper-transcript')
  assert.match(helpers[0].textContent ?? '', /private result/)
  assert.equal((helpers[1].textContent ?? '').includes('private result'), false)
  assert.equal(view.el.firstElementChild?.textContent?.includes('parent result') ?? false, false)
})
