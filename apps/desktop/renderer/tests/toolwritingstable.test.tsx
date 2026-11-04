// "Desk transcript scrollbar occasionally oscillates" (docket desk-transcript-scrollbar-occasionally-oscillate; rig-opus measured):
// while pinned to the bottom, when a Claude tool input starts streaming the transcript height dips 28-29 px for one frame: the live
// "writing input…" row is missing in one render and back in the next. Cause: an HTTP chat snapshot that was REQUESTED after the
// websocket frame that carried the writing row, but was BUILT before the engine knew of the call, replaced the row's list with its
// own (empty) one. The websocket is authoritative for tool_writing (frame order wins), so a snapshot never takes a row away.
import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RETIRE_MS, ingestStream, refreshConvo, resetConvos, socketLost, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'
import type { ChatTransient } from '../src/types'

const SL = 'org', ND = 'scrolldip'
const WRITTEN = '2026-11-04T20:00:00.000Z'
const writing = (id: string): ChatTransient => ({ event_id: `tool-writing-1-${id}`, role: 'assistant', kind: 'tool_writing', text: 'Bash', tool_id: id,
  started_at: WRITTEN, stream_order: 1, tool: { id, name: 'Bash', arg: '', preview_input: {}, writing_started_at: WRITTEN } } as ChatTransient)
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })

test('an HTTP chat snapshot built before the call never takes the websocket-delivered writing row away (no one-frame dip)', async t => {
  const globals = globalThis as unknown as { fetch: typeof fetch }
  const saved = globals.fetch
  let transient: ChatTransient[] = []
  globals.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (path.endsWith('/chat')) return json({ messages: [], live: [], pending_mail: [], busy: true, windowed: true, has_older: false, before: null, draft_epoch: 'f:0', transient })
    return json({})
  }) as typeof fetch
  resetConvos()
  const frames: boolean[] = []
  let snap: Convo | null = null
  function Probe() { snap = useConvo(SL, ND); frames.push(!!snap.chat?.transient?.some(r => r.kind === 'tool_writing')); return null }
  const view = await mountView(<Probe />, h => h)
  t.after(async () => { await view.unmount(); resetConvos(); globals.fetch = saved })
  await inAct(async () => { await flush(10) })
  // the websocket frame carries the writing row
  await inAct(async () => { ingestStream(SL, { node: ND, kind: 'convo', tool_writing: [writing('call-1')] } as never); await flush(4) })
  assert.equal(snap!.chat?.transient?.some(r => r.kind === 'tool_writing'), true, 'the frame shows the writing row')
  const shown = frames.length
  // a snapshot requested AFTER the frame, built before the call: no writing row in it
  await inAct(async () => { void refreshConvo(SL, ND, { force: true }); await flush(20) })
  const after = frames.slice(shown - 1)
  assert.equal(after.every(Boolean), true, 'no render after the frame lacks the writing row: ' + JSON.stringify(after))
  assert.equal(snap!.chat?.transient?.some(r => r.kind === 'tool_writing'), true)
  // a clear frame (empty list) still removes it
  await inAct(async () => { ingestStream(SL, { node: ND, kind: 'convo', tool_writing: [] } as never); await flush(4) })
  await inAct(async () => { void refreshConvo(SL, ND, { force: true }); await flush(20) })
  // (the row is kept as a retiring row until a saved chip claims it or RETIRE_MS passes; the next test covers that)
  await inAct(async () => { await new Promise(r => setTimeout(r, RETIRE_MS + 300)); await flush(4) })
  assert.equal(snap!.chat?.transient?.some(r => r.kind === 'tool_writing'), false, 'the websocket clear is honoured once the retire window passes')
})

test('after the websocket drops, the websocket is no longer the authority: a snapshot without the row removes a writing row whose clear frame was missed', async t => {
  const globals = globalThis as unknown as { fetch: typeof fetch }
  const saved = globals.fetch
  globals.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (path.endsWith('/chat')) return json({ messages: [], live: [], pending_mail: [], busy: false, windowed: true, has_older: false, before: null, draft_epoch: 'f:0', transient: [] })
    return json({})
  }) as typeof fetch
  resetConvos()
  let snap: Convo | null = null
  function Probe() { snap = useConvo(SL, ND); return null }
  const view = await mountView(<Probe />, h => h)
  t.after(async () => { await view.unmount(); resetConvos(); globals.fetch = saved })
  await inAct(async () => { await flush(10) })
  await inAct(async () => { ingestStream(SL, { node: ND, kind: 'convo', tool_writing: [writing('call-9')] } as never); await flush(4) })
  assert.equal(snap!.chat?.transient?.some(r => r.kind === 'tool_writing'), true)
  // while connected, a snapshot without the row does not take it away (the first test); the socket drops and the clear frame is missed
  await inAct(async () => { socketLost(SL); void refreshConvo(SL, ND, { force: true }); await flush(20) })
  assert.equal(snap!.chat?.transient?.some(r => r.kind === 'tool_writing'), false, 'the snapshot decides again: no stale writing row')
})

test('rig trace hook: inert by default; with a hook installed it reports each change of the writing rows with the caller stack', async t => {
  const globals = globalThis as unknown as { fetch: typeof fetch; __ORGTREE_CONVO_TRACE__?: (e: unknown) => void }
  const saved = globals.fetch
  globals.fetch = (async () => json({})) as typeof fetch
  resetConvos()
  const seen: { before: string[]; after: string[]; stack: string[] }[] = []
  let snap: Convo | null = null
  function Probe() { snap = useConvo(SL, ND); return null }
  const view = await mountView(<Probe />, h => h)
  t.after(async () => { await view.unmount(); resetConvos(); globals.fetch = saved; delete globals.__ORGTREE_CONVO_TRACE__ })
  await inAct(async () => { await flush(10) })
  await inAct(async () => { ingestStream(SL, { node: ND, kind: 'convo', tool_writing: [writing('call-a')] } as never); await flush(4) })
  assert.equal(seen.length, 0, 'no hook installed: nothing reported')
  globals.__ORGTREE_CONVO_TRACE__ = e => { seen.push(e as never) }
  await inAct(async () => { ingestStream(SL, { node: ND, kind: 'convo', tool_writing: [writing('call-a'), writing('call-b')] } as never); await flush(4) })
  await inAct(async () => { ingestStream(SL, { node: ND, kind: 'convo', tool_writing: [] } as never); await flush(4) })
  await inAct(async () => { socketLost(SL); await flush(4) })
  assert.deepEqual(seen.map(s => [s.before.length, s.after.length]), [[1, 2], [2, 0]], 'the clear frame keeps the rows (retiring); socketLost ends them')
  assert.ok(seen[0]!.stack.length > 0)
  assert.equal(snap!.chat?.transient?.some(r => r.kind === 'tool_writing'), false)
})

test('a clear frame keeps the writing row until a saved chip claims it, or RETIRE_MS passes, or the socket drops (no render with neither row)', async t => {
  const globals = globalThis as unknown as { fetch: typeof fetch }
  const saved = globals.fetch
  let messages: unknown[] = []
  globals.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (path.endsWith('/chat')) return json({ messages, live: [], pending_mail: [], busy: true, windowed: true, has_older: false, before: null, draft_epoch: 'f:0', transient: [] })
    return json({})
  }) as typeof fetch
  resetConvos()
  const frames: { writing: boolean; saved: boolean }[] = []
  let snap: Convo | null = null
  function Probe() {
    snap = useConvo(SL, ND)
    frames.push({ writing: !!snap.chat?.transient?.some(r => r.kind === 'tool_writing'), saved: !!snap.chat?.messages.some(m => m.tools?.some(tc => tc?.id === 'call-7')) })
    return null
  }
  const view = await mountView(<Probe />, h => h)
  t.after(async () => { await view.unmount(); resetConvos(); globals.fetch = saved })
  await inAct(async () => { await flush(10) })
  const writingNow = () => !!snap!.chat?.transient?.some(r => r.kind === 'tool_writing')
  // the measured order: writing frame, then the CLEAR frame, then (a render later) the committed row
  await inAct(async () => { ingestStream(SL, { node: ND, kind: 'convo', tool_writing: [writing('call-7')] } as never); await flush(4) })
  await inAct(async () => { ingestStream(SL, { node: ND, kind: 'convo', tool_writing: [] } as never); await flush(4) })
  assert.equal(writingNow(), true, 'the clear frame alone does not drop the row (the saved row has not arrived)')
  messages = [{ role: 'assistant', text: '', ts: WRITTEN, row_id: 'r1', event_id: 'e1', seq: 1, convo_revision: 1, tools: [{ id: 'call-7', name: 'Bash', arg: 'echo hi', input: { command: 'echo hi' } }] }]
  await inAct(async () => { void refreshConvo(SL, ND, { force: true }); await flush(20) })
  const after = frames.slice(frames.findIndex(f => f.writing))
  assert.equal(after.every(f => f.writing || f.saved), true, 'no render has neither the writing row nor the saved chip: ' + JSON.stringify(after))
  assert.equal(snap!.chat?.messages.some(m => m.tools?.some(tc => tc?.id === 'call-7')), true, 'the saved chip arrived (the desk dedup hides the writing row from here)')
  // a call that never commits does not linger: the fallback timeout drops it
  await inAct(async () => { await new Promise(r => setTimeout(r, RETIRE_MS + 300)); await flush(4) })
  assert.equal(writingNow(), false, 'dropped after RETIRE_MS')
  // and a socket drop ends it at once
  await inAct(async () => { ingestStream(SL, { node: ND, kind: 'convo', tool_writing: [writing('call-8')] } as never); await flush(4) })
  await inAct(async () => { ingestStream(SL, { node: ND, kind: 'convo', tool_writing: [] } as never); await flush(4) })
  assert.equal(writingNow(), true)
  await inAct(async () => { socketLost(SL); await flush(4) })
  assert.equal(writingNow(), false, 'socketLost ends it at once')
})
