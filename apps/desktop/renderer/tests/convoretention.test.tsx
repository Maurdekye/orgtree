import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  addPending, dismissPending, failPending, ingestPulse, ingestStream,
  loadOlder, refreshConvo, renameConvo, resetConvos, useConvo,
} from '../src/convo'
import type { Convo } from '../src/convo'
import type { ChatPayload, ChatMessage } from '../src/types'

let fixture = 0
function setup(t: TestContext) {
  const slug = `retention-${++fixture}`
  const original = globalThis.fetch
  const bodies = new Map<string, Partial<ChatPayload>>()
  const held = new Map<string, Array<(r: Response) => void>>()
  const hold = new Set<string>()
  const response = (id: string) => new Response(JSON.stringify({
    busy: false, responding: false, queued: 0, last_error: null, occupancy: 0,
    messages: [{ role: 'assistant', text: id, seq: 1 }],
    pending_mail: [], mail_pending: 0, windowed: true, has_older: false,
    ...bodies.get(id),
  }), { headers: { 'Content-Type': 'application/json' } })
  globalThis.fetch = (async (input: unknown) => {
    const path = new URL(String(input), 'http://localhost').pathname.split('/')
    const id = decodeURIComponent(path[path.length - 2]!)
    if (!hold.has(id)) return response(id)
    return new Promise<Response>(resolve => {
      const list = held.get(id) ?? []; list.push(resolve); held.set(id, list)
    })
  }) as typeof fetch
  const views: Array<{ unmount(): Promise<void> }> = []
  const view = async (id: string) => {
    let current!: Convo
    function Probe() { current = useConvo(slug, id); return null }
    const mounted = await mountView(<Probe />, () => current)
    let closed = false
    const result = {
      now: () => current,
      unmount: async () => { if (!closed) { closed = true; await mounted.unmount() } },
    }
    views.push(result)
    return result
  }
  let batch = 0
  const pressure = async (n = 40) => {
    const prefix = ++batch
    for (let i = 0; i < n; i++) await refreshConvo(slug, `old-${prefix}-${i}`)
    await flush(2)
  }
  t.after(async () => {
    for (const v of views) await v.unmount()
    for (const [id, list] of held) for (const resolve of list) resolve(response(id))
    await flush(4)
    resetConvos(); await flush(2)
    globalThis.fetch = original
  })
  return { slug, view, pressure, bodies, held, hold, response }
}

test('conversation tail retention stays flat after 40 versus 400 inactive visits', async t => {
  const f = setup(t)
  const counts: number[] = []
  for (const history of [40, 400]) {
    resetConvos(); await flush(2)
    for (let i = 0; i < history; i++) await refreshConvo(f.slug, `history-${i}`)
    let count = 0
    for (let i = history - 1; i >= 0; i--) {
      const v = await f.view(`history-${i}`)
      const loaded = v.now().loaded
      if (loaded) assert.equal(v.now().chat?.messages[0]?.text, `history-${i}`)
      await v.unmount()
      if (!loaded) break
      count++
    }
    counts.push(count)
  }
  console.log(JSON.stringify({ historicalVisits: [40, 400], retainedTails: counts }))
  assert.deepEqual(counts, [32, 32])
})

test('subscribed tails survive pressure, last unsubscribe allows eviction', async t => {
  const f = setup(t)
  const a = await f.view('open'), b = await f.view('open')
  await inAct(() => refreshConvo(f.slug, 'open'))
  await a.unmount(); await f.pressure()
  assert.equal(b.now().chat?.messages[0]?.text, 'open')
  const c = await f.view('open')
  assert.equal(c.now().loaded, true)
  await b.unmount(); await c.unmount(); await f.pressure()
  assert.equal((await f.view('open')).now().loaded, false)
})

test('serialized byte cap releases an oversized inactive tail', async t => {
  const f = setup(t)
  f.bodies.set('large', { messages: [{ role: 'assistant', text: 'x'.repeat(5 * 1024 * 1024) }] })
  const v = await f.view('large')
  await inAct(() => refreshConvo(f.slug, 'large'))
  assert.equal(v.now().chat?.messages[0]?.text?.length, 5 * 1024 * 1024)
  await v.unmount(); await flush(2)
  assert.equal((await f.view('large')).now().loaded, false)
})

test('failed local sends retain exact text, attachments and recovery state until dismissed', async t => {
  const f = setup(t)
  const ghost = addPending(f.slug, 'send', 'unsent words', null,
    [{ path: '/attachment', name: 'file.txt', size: 7 }] as never, 'client-op')
  failPending(f.slug, 'send', ghost, 'offline')
  await f.pressure()
  const v = await f.view('send')
  assert.equal(v.now().pending[0]?.text, 'unsent words')
  assert.equal(v.now().pending[0]?.failed, true)
  assert.equal(v.now().pending[0]?.op, 'client-op')
  assert.equal(v.now().pending[0]?.attachments?.[0]?.name, 'file.txt')
  await v.unmount()
  dismissPending(f.slug, 'send', ghost); await f.pressure()
  assert.equal((await f.view('send')).now().pending.length, 0)
})

test('unpublished text and thinking survive inactive pressure and rename', async t => {
  const f = setup(t)
  ingestStream(f.slug, { node: 'stream', kind: 'delta', text: 'not yet saved' } as never)
  ingestStream(f.slug, { node: 'stream', kind: 'thinking', text: 'still reasoning' } as never)
  renameConvo(f.slug, 'stream', 'renamed')
  await f.pressure()
  const v = await f.view('renamed')
  assert.equal(v.now().draft, 'not yet saved')
  assert.equal(v.now().thinking, 'still reasoning')
})

test('assistant snapshots and committed rows awaiting reconciliation survive pressure', async t => {
  const f = setup(t)
  const assistant: ChatMessage = { role: 'assistant', text: 'partial answer',
    assistant_id: 'a', assistant_ids: ['a'], assistant_scope: 's',
    assistant_revision: 1, assistant_state: 'partial', assistant_pending: true }
  ingestStream(f.slug, { node: 'assistant', kind: 'text', assistant_row: assistant } as never)
  const row = { role: 'user', text: 'durable steer', steered: true,
    row_id: 'u', ts: '2026-09-27T10:00:00Z' }
  ingestStream(f.slug, { node: 'committed', kind: 'steered', committed_row: row } as never)
  // Refresh with idle server snapshots lacking these rows: retain the
  // reconciliation maps themselves, not merely the initial busy flag.
  f.bodies.set('assistant', { assistant_scope: 's', assistant_identity: 1 })
  await refreshConvo(f.slug, 'assistant')
  await refreshConvo(f.slug, 'committed')
  await f.pressure()
  assert.ok((await f.view('assistant')).now().chat?.messages.some(row => row.text === 'partial answer'))
  assert.ok((await f.view('committed')).now().chat?.messages.some(row => row.text === 'durable steer'))
})

test('known active turns and queued mail remain protected until a settled snapshot', async t => {
  const f = setup(t)
  for (const [id, state] of Object.entries({ busy: { busy: true },
    responding: { responding: true }, queued: { queued: 1 }, mail: { mail_pending: 1 } })) {
    f.bodies.set(id, state)
    await refreshConvo(f.slug, id)
  }
  await f.pressure()
  for (const id of ['busy', 'responding', 'queued', 'mail']) {
    const v = await f.view(id)
    assert.equal(v.now().loaded, true, id)
    await v.unmount()
    f.bodies.delete(id)
    await refreshConvo(f.slug, id)
  }
  await f.pressure()
  for (const id of ['busy', 'responding', 'queued', 'mail']) {
    assert.equal((await f.view(id)).now().loaded, false, id)
  }
})

test('older outstanding refresh remains protected after newer refresh fails', async t => {
  const f = setup(t)
  await refreshConvo(f.slug, 'fetch')
  f.hold.add('fetch')
  const old = refreshConvo(f.slug, 'fetch', { force: true })
  const newer = refreshConvo(f.slug, 'fetch', { force: true })
  await flush(2)
  assert.equal(f.held.get('fetch')?.length, 2)
  f.held.get('fetch')!.pop()!(new Response('{}', { status: 500 }))
  await newer; await f.pressure()
  const v = await f.view('fetch')
  assert.equal(v.now().loaded, true, 'older outstanding request still owns a retained entry')
  f.held.get('fetch')!.shift()!(f.response('fetch'))
  await inAct(() => old)
  assert.equal(v.now().chat?.messages[0]?.text, 'fetch')
  await v.unmount(); await f.pressure()
  assert.equal((await f.view('fetch')).now().loaded, false)
})

test('older-page fetch is retained until it settles after last unsubscribe', async t => {
  const f = setup(t)
  f.bodies.set('page', { before: 'cursor', conversation_id: 'conversation', has_older: true })
  const v = await f.view('page')
  await inAct(() => refreshConvo(f.slug, 'page'))
  f.hold.add('page')
  await inAct(() => { assert.equal(loadOlder(f.slug, 'page'), true) })
  await v.unmount(); await f.pressure()
  const during = await f.view('page')
  assert.equal(during.now().loaded, true)
  assert.equal(during.now().loadingOlder, true)
  await during.unmount()
  f.held.get('page')!.shift()!(f.response('page'))
  await flush(4); await f.pressure()
  assert.equal((await f.view('page')).now().loaded, false)
})

test('reset keeps subscribed identity working and unwatched pulses do not accumulate', async t => {
  const f = setup(t)
  const v = await f.view('reset')
  await inAct(() => refreshConvo(f.slug, 'reset'))
  await inAct(() => resetConvos())
  for (let i = 0; i < 400; i++) ingestPulse(f.slug, { node: `unseen-${i}`, event: 'changed' } as never)
  await flush(2)
  await inAct(() => refreshConvo(f.slug, 'reset'))
  assert.equal(v.now().loaded, true)
  assert.equal(v.now().chat?.messages[0]?.text, 'reset')
})
