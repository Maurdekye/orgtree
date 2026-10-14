import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Msg } from '../src/canvas/desk'
import { ToolOutputDetails } from '../src/canvas/tooloutput'
import { isFailedShellCall } from '../src/canvas/shellerror'
import type { ToolChip } from '../src/types'

const message = (tool: ToolChip) => ({ role: 'assistant', text: '', tools: [tool] })
test('failed shell hides error by default and fetches full output only on expansion; history uses same fold', async t => {
  const prior = globalThis.fetch
  let reads = 0
  const full = `BEGIN\n${'synthetic output\n'.repeat(500)}END_MARKER`
  globalThis.fetch = (async (url: string) => { assert.match(String(url), /tooloutput\/7\/call/); reads++
    return new Response(JSON.stringify({ output: full })) }) as typeof fetch
  t.after(() => { globalThis.fetch = prior })
  const tool = { id: 'call', name: 'Bash', arg: 'synthetic command', error: 'INLINE_ERROR', result: 'CLIPPED', truncated: true, output_seq: 7 }
  const view = await mountView(<Msg m={message(tool)} slug="org" nid="node" />, el => el.textContent ?? '')
  t.after(view.unmount)
  assert.match(view.last(), /an error occurred/); assert.doesNotMatch(view.last(), /INLINE_ERROR|CLIPPED|END_MARKER/)
  assert.equal(reads, 0)
  await inAct(() => { view.el.querySelector<HTMLElement>('.tline')!.click() }); await flush()
  assert.equal(view.el.querySelector('pre.respre')?.textContent, full)
  assert.equal(reads, 1); assert.ok(view.el.querySelector('.code-copy'))
  await inAct(() => { view.el.querySelector<HTMLElement>('.tline')!.click() }); await flush()
  assert.doesNotMatch(view.last(), /END_MARKER/)
  await view.render(<Msg key="history" m={JSON.parse(JSON.stringify(message(tool)))} slug="org" nid="node" />)
  assert.match(view.last(), /an error occurred/); assert.equal(reads, 1)
  await inAct(() => { view.el.querySelector<HTMLElement>('.tline')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) }); await flush()
  assert.equal(view.el.querySelector('pre.respre')?.textContent, full)
  assert.equal(reads, 2)
})

test('successful shells and other tools errors retain the existing display; error-only historical shell stays expandable', async t => {
  const view = await mountView(<Msg m={message({ name: 'Bash', result: 'SUCCESS_OUTPUT', result_lines: 1 })} slug="org" nid="node" />, el => el.textContent ?? '')
  t.after(view.unmount)
  assert.doesNotMatch(view.last(), /an error occurred|1 line/)
  await inAct(() => { view.el.querySelector<HTMLElement>('.tline')!.click() }); await flush()
  assert.match(view.last(), /SUCCESS_OUTPUT/)
  assert.equal(view.el.querySelector('.tool-line-count')?.textContent, '1 line')
  await view.render(<Msg key="read" m={message({ name: 'Read', error: 'OTHER_ERROR', result: 'read output' })} slug="org" nid="node" />)
  assert.match(view.last(), /OTHER_ERROR/)
  await view.render(<Msg key="shell" m={message({ name: 'PowerShell', error: 'ONLY_ERROR' })} slug="org" nid="node" />)
  assert.doesNotMatch(view.last(), /ONLY_ERROR/)
  await inAct(() => { view.el.querySelector<HTMLElement>('.tline')!.click() }); await flush()
  assert.match(view.last(), /ONLY_ERROR/)
  for (const name of ['Bash', 'PowerShell', 'exec_command', 'run_command', 'shell']) {
    assert.equal(isFailedShellCall({ name, error: '' }), true)
    assert.equal(isFailedShellCall({ name, exit_code: 1 }), true)
    assert.equal(isFailedShellCall({ name, result: 'success' }), false)
  }
})

test('expanded output notes the exact cap/provider clipping and rejects old identity completion', async t => {
  const prior = globalThis.fetch
  let release: (r: Response) => void = () => {}
  globalThis.fetch = (() => new Promise<Response>(r => { release = r })) as typeof fetch
  t.after(() => { globalThis.fetch = prior })
  const fixture = (nid: string) => <ToolOutputDetails slug="org" nid={nid} seq={1} tool="call" fallback=""
    renderOutput={text => <pre>{text}</pre>} />
  const view = await mountView(fixture('a'), el => el.textContent ?? '')
  t.after(view.unmount)
  const old = release
  await view.render(fixture('b'))
  await inAct(() => old(new Response(JSON.stringify({ output: 'STALE_A' })))); await flush()
  assert.doesNotMatch(view.last(), /STALE_A/)
  await inAct(() => release(new Response(JSON.stringify({ output: 'CURRENT_B', truncated: true, provider_truncated: true })))); await flush()
  assert.match(view.last(), /CURRENT_B/); assert.match(view.last(), /output truncated at 1 MiB/)
  assert.match(view.last(), /provider supplied truncated output/)
})
