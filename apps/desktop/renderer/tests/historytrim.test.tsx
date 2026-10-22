import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useEffect } from 'react'
import { collapseWindow, loadOlder, refreshConvo, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'
import type { ChatMessage } from '../src/types'
import { OrgRecordContext } from '../src/recordsession'

// Rust's chat contract: pages use seq (including imported negative/zero seq),
// not timestamps or rendered-row count. A no-change delta has no history cursor.
async function fixture(t: TestContext, count = 32, legacy = false) {
  const slug = 'history-trim', nid = t.name
  const rows: ChatMessage[] = Array.from({ length: count }, (_, i) => ({
    seq: i - 16, row_id: `r${i - 16}`, event_id: `e${i - 16}`,
    ts: '2026-10-22T00:00:00Z', role: i % 4 === 0 ? 'user' : 'assistant',
    ...(i % 4 === 1 ? { thinking: `thought ${i}`, text: '' }
      : i % 4 === 2 ? { text: '', tools: [{ id: `t${i}`, name: 'read_file', input: {}, result: 'ok' }] }
      : i % 4 === 3 ? { text: '' } : { text: `message ${i}` }),
  }))
  const oldFetch = globalThis.fetch, requests: URL[] = []
  globalThis.fetch = async input => {
    const url = new URL(String(input), 'http://localhost'); requests.push(url)
    const delta = url.searchParams.has('after')
    const before = url.searchParams.get('before'), last = Number(url.searchParams.get('last'))
    const eligible = before === null ? rows : rows.filter(row => row.seq! < Number(before.replace('opaque:', '')))
    const selected = delta ? [] : eligible.slice(-last)
    const more = !delta && eligible.length > last
    return new Response(JSON.stringify({ busy: false, responding: false, queued: 0,
      messages: selected, message_updates: [], incremental: delta, windowed: true,
      conversation_id: legacy ? 'legacy-session' : 'a101', after: '32:15',
      before: more ? `${legacy ? 'opaque:' : ''}${selected[0]!.seq}` : null,
      has_older: more, pending_mail: [], transient: [] }))
  }
  let current!: Convo
  function Panel() {
    current = useConvo(slug, nid)
    useEffect(() => { if (!current.loaded) void refreshConvo(slug, nid) }, [])
    return null
  }
  const views: Array<Awaited<ReturnType<typeof mountView>>> = []
  const open = async () => {
    const view = await mountView(<OrgRecordContext.Provider value={{ slug, session: null }}><Panel /></OrgRecordContext.Provider>, el => el)
    views.push(view); await inAct(flush); return view
  }
  t.after(async () => {
    for (const v of views) await v.unmount()
    resetConvos(); globalThis.fetch = oldFetch
  })
  const page = async () => {
    await inAct(async () => { assert.equal(loadOlder(slug, nid), true); await flush() })
  }
  const all = async () => {
    for (let i = 0; current.chat?.has_older && i < count; i++) await page()
    assert.deepEqual(current.chat!.messages.map(r => r.seq), rows.map(r => r.seq))
    assert.equal(current.chat!.has_older, false)
  }
  return { slug, nid, rows, requests, open, page, all, now: () => current }
}

test('history remains pageable after returning from the true start to a taller live tail', async t => {
  const f = await fixture(t); await f.open(); await f.all()
  await inAct(async () => { collapseWindow(f.slug, f.nid, 12); await flush() })
  assert.equal(f.now().chat!.messages.length, 12)
  assert.equal(f.now().win, 12, 'the desk end marker is eligible at this window size')
  assert.equal(f.now().chat!.has_older, true, 'discarded history is not the start of the conversation')
  const from = f.now().chat!.messages[0]!.seq
  await f.page()
  assert.equal(f.requests.at(-1)!.searchParams.get('before'), String(from))
  assert.equal(f.requests.at(-1)!.searchParams.has('after'), false)
  await f.all()
})

test('closing and reopening an exhausted history retains a usable older cursor', async t => {
  const f = await fixture(t); const view = await f.open(); await f.all()
  await view.unmount(); await f.open()
  assert.equal(f.now().chat!.messages.length, 8)
  assert.equal(f.now().chat!.has_older, true, 'reopening must not inherit the discarded window end')
  assert.equal(f.now().chat!.before, '8')
  await f.all()
})

test('trimming before the true start still preserves paging across seq zero', async t => {
  const f = await fixture(t); await f.open(); await f.page()
  assert.equal(f.now().chat!.messages[0]!.seq, 0)
  await inAct(async () => { collapseWindow(f.slug, f.nid, 12); await flush() })
  assert.equal(f.now().chat!.before, '4', 'a delta refresh cannot replace the trimmed cursor')
  await f.all()
})

test('a complete short transcript keeps its true start through collapse and reopen', async t => {
  const f = await fixture(t, 6); const view = await f.open()
  await inAct(async () => { collapseWindow(f.slug, f.nid, 12); await flush() })
  await view.unmount(); await f.open()
  assert.equal(f.now().chat!.has_older, false)
  assert.equal(f.now().chat!.before, null)
  assert.equal(loadOlder(f.slug, f.nid), false)
  assert.deepEqual(f.now().chat!.messages.map(r => r.seq), f.rows.map(r => r.seq))
})

test('an unchanged history window preserves its valid zero cursor', async t => {
  const f = await fixture(t); await f.open(); await f.page()
  assert.equal(f.now().chat!.before, '0')
  await inAct(async () => { collapseWindow(f.slug, f.nid, 16); await flush() })
  assert.equal(f.now().chat!.before, '0')
  assert.equal(f.now().chat!.has_older, true)
  await f.all()
})

test('legacy opaque cursors refresh a trimmed tail in full before paging', async t => {
  const f = await fixture(t, 32, true); await f.open(); await f.all()
  await inAct(async () => { collapseWindow(f.slug, f.nid, 12); await flush() })
  assert.equal(f.requests.at(-1)!.searchParams.has('after'), false, 'an old opaque cursor cannot describe the new tail')
  assert.equal(f.now().chat!.before, 'opaque:4')
  assert.equal(f.now().chat!.has_older, true)
  await f.all()
})
