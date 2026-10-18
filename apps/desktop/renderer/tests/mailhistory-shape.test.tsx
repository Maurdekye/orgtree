import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { useMailboxHistory } from '../src/usemailhistory'
import type { InboxPayload } from '../src/types'

const mail = (id: string) => ({ id, from: 'peer', kind: 'message', body: id, at: '2026-10-18T00:00:00Z' })
const head = { pending: [], delivered: [mail('head')], sent: [] }
function Probe({ base }: { base: unknown }) {
  const history = useMailboxHistory('shape', base as InboxPayload | null, 'inbox', true)
  return <div><pre>{JSON.stringify(history.box)}</pre><span className="error">{history.error}</span>
    <span className="more">{String(history.hasMore)}</span><button onClick={history.loadMore}>Next</button>
    <button onClick={history.retry}>Retry</button></div>
}
function responses(t: TestContext, pages: unknown[]) {
  const oldFetch = globalThis.fetch, cursors: (string | null)[] = []
  globalThis.fetch = (async (url: string) => {
    cursors.push(new URL(String(url), 'http://fixture.invalid').searchParams.get('before'))
    return new Response(JSON.stringify(pages.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = oldFetch })
  return cursors
}

test('mailbox history tolerates a live window with missing or null folder arrays', async t => {
  responses(t, [{ delivered: [mail('page')], pending: [], sent: [] }])
  const view = await mountView(<Probe base={{ delivered: [mail('head')], pending: null }} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  const box = JSON.parse(view.el.querySelector('pre')!.textContent!)
  assert.deepEqual(box.pending, []); assert.deepEqual(box.sent, [])
  assert.deepEqual(box.delivered.map((m: { id: string }) => m.id).sort(), ['head', 'page'])
})

test('mailbox history normalizes omitted folders in a partial page before React state update', async t => {
  responses(t, [{ delivered: [mail('older')], next_cursor: '41' }])
  const view = await mountView(<Probe base={head} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  assert.equal(view.el.querySelector('.more')?.textContent, 'true')
  assert.equal(view.el.querySelector('.error')?.textContent, '')
  assert.equal(view.el.querySelector('pre')!.textContent!.includes('older'), true)
})

test('mailbox history rejects an invalid page without dropping rows or cursor and retries it', async t => {
  const cursors = responses(t, [{ delivered: [mail('older')], pending: [], sent: [], next_cursor: '41' },
    null, { delivered: [mail('oldest')], next_cursor: null }])
  const view = await mountView(<Probe base={head} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  await inAct(async () => { view.el.querySelectorAll('button')[0]!.click(); await flush(4) })
  assert.match(view.el.querySelector('.error')!.textContent!, /mail history response/i)
  assert.equal(view.el.querySelector('.more')!.textContent, 'true')
  assert.equal(view.el.querySelector('pre')!.textContent!.includes('older'), true)
  await inAct(async () => { view.el.querySelectorAll('button')[1]!.click(); await flush(4) })
  assert.equal(view.el.querySelector('.error')!.textContent, '')
  assert.equal(view.el.querySelector('.more')!.textContent, 'false')
  assert.equal(view.el.querySelector('pre')!.textContent!.includes('oldest'), true)
  assert.deepEqual(cursors, [null, '41', '41'])
})

test('mailbox history keeps null and undefined live windows loading without requests', async t => {
  const calls = responses(t, [])
  for (const base of [null, undefined]) {
    const view = await mountView(<Probe base={base} />, el => el)
    assert.equal(view.el.querySelector('.more')!.textContent, 'false')
    await view.unmount()
  }
  assert.deepEqual(calls, [])
})
