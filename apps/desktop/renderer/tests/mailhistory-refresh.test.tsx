import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useMailboxHistory } from '../src/usemailhistory'
import type { InboxPayload, MailEntry } from '../src/types'

const mail = (id: string, body = id): MailEntry => ({ id, from: 'peer', kind: 'message', body, at: '2026-10-21T20:00:00Z' })
const page = (pending: MailEntry[], delivered: MailEntry[], cursor: string | null = null): InboxPayload =>
  ({ pending, delivered, sent: [], next_cursor: cursor })

for (const node of [undefined, 'agent', 'project']) for (const change of ['delete', 'read', 'head'] as const)
test(`${node ?? 'user'} retained history reconciles remote ${change}`, async t => {
  let revision = 1, latest: ReturnType<typeof useMailboxHistory> | undefined
  const requests: string[] = [], oldFetch = globalThis.fetch
  const head = () => [mail('head', revision === 2 && change === 'head' ? 'updated' : 'original')]
  globalThis.fetch = (async (input: string) => {
    const url = new URL(String(input), 'http://synthetic.invalid')
    assert.equal(url.pathname.endsWith('/inbox'), true)
    assert.equal(url.pathname.includes('/nodes/'), !!node)
    const ids = url.searchParams.get('ids')
    requests.push(ids ? `ids:${ids}` : url.searchParams.get('before') ?? 'head')
    const body = ids
      ? { ...page(revision === 2 && change === 'read' ? [] : [mail('old')],
        revision === 2 && change === 'read' ? [mail('old')] : []), refreshed_ids: JSON.parse(ids) }
      : url.searchParams.has('before') ? page([mail('old')], [], '5') : page([], head(), '9')
    if (ids && revision === 2 && change === 'delete') body.pending = []
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = oldFetch })
  function Probe({ rev }: { rev: number }) {
    latest = useMailboxHistory('refresh', { pending: [], delivered: head(), sent: [], mail_revision: String(rev) }, 'inbox', true, 0, node)
    return <span>{latest.box?.pending.map(m => m.id).join(',')}</span>
  }
  const view = await mountView(<Probe rev={1} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(5); latest!.loadMore(); await flush(5) })
  assert.deepEqual(requests, ['head', '9'], 'control: bounded older page really loaded')
  assert.equal(latest!.box!.pending.some(m => m.id === 'old'), true)
  revision = 2
  await view.render(<Probe rev={2} />)
  await inAct(async () => { await flush(5) })
  assert.equal(requests.filter(r => r === 'head').length, 2, 'control: mail revision really refreshed head')
  if (change === 'delete') assert.equal([...latest!.box!.pending, ...latest!.box!.delivered].some(m => m.id === 'old'), false)
  if (change === 'read') {
    assert.equal(latest!.box!.pending.some(m => m.id === 'old'), false)
    assert.equal(latest!.box!.delivered.some(m => m.id === 'old'), true)
  }
  if (change === 'head') assert.equal(latest!.box!.delivered.find(m => m.id === 'head')?.body, 'updated')
  assert.equal(latest!.hasMore, true, 'refresh preserves the next older cursor')
  await inAct(async () => { latest!.loadMore(); await flush(5) })
  assert.equal(requests.at(-1), '5', 'refresh cannot reset pagination to the head cursor')
})

for (const failure of ['http', 'coverage', 'shape'] as const)
test(`retained refresh ${failure} failure preserves rows and can retry`, async t => {
  let rev = 1, fail = true, latest: ReturnType<typeof useMailboxHistory> | undefined
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (input: string) => {
    const url = new URL(String(input), 'http://synthetic.invalid'), ids = url.searchParams.get('ids')
    let body: unknown = url.searchParams.has('before') ? page([mail('old')], [], '5') : page([], [mail('head')], '9')
    if (ids) {
      if (fail && failure === 'http') return new Response('refresh unavailable', { status: 503 })
      body = fail && failure === 'shape' ? null : { ...page([], []), ...(fail && failure === 'coverage' ? {} : { refreshed_ids: JSON.parse(ids) }) }
    }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = oldFetch })
  function Probe() {
    latest = useMailboxHistory('retry', { pending: [], delivered: [mail('head')], sent: [], mail_revision: String(rev) }, 'inbox', true)
    return <span>{latest.error}</span>
  }
  const view = await mountView(<Probe />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(5); latest!.loadMore(); await flush(5) })
  rev++
  await view.render(<Probe />); await inAct(async () => { await flush(5) })
  assert.equal(!!latest!.error, true)
  assert.equal(latest!.box!.pending.some(m => m.id === 'old'), true, 'failed refresh is never evidence of deletion')
  fail = false
  await inAct(async () => { latest!.retry(); await flush(5) })
  assert.equal(latest!.error, null)
  assert.equal(latest!.box!.pending.some(m => m.id === 'old'), false)
  assert.equal(latest!.hasMore, true)
})

test('retained refresh requests at most 200 known IDs and preserves rows outside a shifted head', async t => {
  let rev = 1, latest: ReturnType<typeof useMailboxHistory> | undefined
  const known = Array.from({ length: 205 }, (_, i) => mail(`old${i}`))
  const counts: number[] = [], oldFetch = globalThis.fetch
  globalThis.fetch = (async (input: string) => {
    const url = new URL(String(input), 'http://synthetic.invalid'), encoded = url.searchParams.get('ids')
    let body: unknown
    if (encoded) {
      const ids = JSON.parse(encoded) as string[]; counts.push(ids.length)
      body = { ...page([], ids.map(id => mail(id))), refreshed_ids: ids }
    } else body = url.searchParams.has('before') ? page([], known) : page([], [mail(rev === 1 ? 'old-head' : 'new-head')], '9')
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = oldFetch })
  function Probe() {
    latest = useMailboxHistory('bounded', page([], [mail(rev === 1 ? 'old-head' : 'new-head')]), 'inbox', true, rev)
    return <span />
  }
  const view = await mountView(<Probe />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(5); latest!.loadMore(); await flush(5) })
  rev++
  await view.render(<Probe />); await inAct(async () => { await flush(5) })
  assert.deepEqual(counts, [200, 6])
  assert.equal(latest!.box!.delivered.some(m => m.id === 'old-head'), true, 'absence from a bounded head is not deletion')
  assert.equal(latest!.box!.delivered.length, 207)
})
