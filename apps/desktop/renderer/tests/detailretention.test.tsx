import { flush, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { forgetNodeDetail, nodeDetail, retainNodeDetail } from '../src/archived'
import type { NodeDetail } from '../src/archived'
import { useNodeDetail } from '../src/nodedetail'

const seat = (id: string, rev = 'r') => ({ id, detail: false, detail_rev: rev })
const detail = async (_s: string, id: string) => ({ charter: id })
async function pressure() {
  for (let i = 0; i < 100; i++) await nodeDetail('other', seat(`old-${i}`), detail)
}
function pending() {
  let resolve!: (d: NodeDetail) => void
  let reject!: (e: Error) => void
  const p = new Promise<NodeDetail>((yes, no) => { resolve = yes; reject = no })
  return { p, resolve, reject }
}

test('least recently used inactive answer refetches; a touched answer survives', async () => {
  forgetNodeDetail()
  for (let i = 0; i < 64; i++) await nodeDetail('o', seat(`${i}`), detail)
  let fetches = 0
  const fetcher = async () => { fetches++; return { charter: 'refetched' } }
  assert.equal((await nodeDetail('o', seat('0'), fetcher)).charter, '0')
  await nodeDetail('o', seat('64'), detail)
  assert.equal((await nodeDetail('o', seat('0'), fetcher)).charter, '0')
  assert.equal((await nodeDetail('o', seat('1'), fetcher)).charter, 'refetched')
  assert.equal(fetches, 1)
})

test('serialized size budget evicts large answers below the entry limit', async () => {
  forgetNodeDetail()
  const large = 'x'.repeat(5 * 1024 * 1024)
  await nodeDetail('o', seat('a'), async () => ({ charter: large }))
  await nodeDetail('o', seat('b'), async () => ({ charter: large }))
  let calls = 0
  const fetcher = async () => { calls++; return { charter: 'refetched' } }
  assert.equal((await nodeDetail('o', seat('b'), fetcher)).charter?.length, large.length)
  assert.equal((await nodeDetail('o', seat('a'), fetcher)).charter, 'refetched')
  assert.equal(calls, 1)
  forgetNodeDetail()
})

test('multiple open consumers protect an answer until the last close', async () => {
  forgetNodeDetail()
  const a = retainNodeDetail('o', seat('open'))
  const b = retainNodeDetail('o', seat('open'))
  try {
    const first = await nodeDetail('o', seat('open'), detail)
    a(); a() // cleanup is idempotent
    await pressure()
    assert.equal(await nodeDetail('o', seat('open'), detail), first)
    b()
    await pressure()
    assert.notEqual(await nodeDetail('o', seat('open'), detail), first)
  } finally { a(); b(); forgetNodeDetail() }
})

test('pending requests survive pressure and still deduplicate after consumers close', async () => {
  forgetNodeDetail()
  const d = pending()
  const release = retainNodeDetail('o', seat('pending'))
  const first = nodeDetail('o', seat('pending'), () => d.p)
  release()
  await pressure()
  assert.equal(nodeDetail('o', seat('pending'), detail), first)
  d.resolve({ charter: 'late answer' })
  assert.equal((await first).charter, 'late answer')
  assert.equal(nodeDetail('o', seat('pending'), detail), first)
  await pressure()
  assert.notEqual(nodeDetail('o', seat('pending'), detail), first)
})

test('invalidated pending completion cannot resurrect or remove its replacement', async () => {
  for (const outcome of ['resolve', 'reject'] as const) {
    forgetNodeDetail()
    const d = pending()
    const release = retainNodeDetail('o', seat('same'))
    try {
      const old = nodeDetail('o', seat('same'), () => d.p)
      const caught = old.catch(() => null)
      forgetNodeDetail('o', 'same')
      const fresh = nodeDetail('o', seat('same'), detail)
      await fresh
      if (outcome === 'resolve') d.resolve({ charter: 'stale' })
      else d.reject(new Error('old request failed'))
      await caught
      assert.equal(nodeDetail('o', seat('same'), detail), fresh)
      forgetNodeDetail()
      assert.notEqual(nodeDetail('o', seat('same'), detail), fresh,
        'global mutation invalidation must win even while retained')
    } finally { release() }
  }
})

test('open useNodeDetail hook retains its answer and releases it on unmount', async () => {
  forgetNodeDetail()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response(JSON.stringify({ charter: 'displayed detail' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  function Probe() {
    const { node, ready } = useNodeDetail('o', seat('hook'))
    return <div>{ready ? (node as NodeDetail).charter : 'loading'}</div>
  }
  const views: Awaited<ReturnType<typeof mountView>>[] = []
  try {
    const first = await mountView(<Probe />, h => h.textContent)
    views.push(first)
    await flush(4)
    assert.equal(first.last(), 'displayed detail')
    await pressure()
    const second = await mountView(<Probe />, h => h.textContent)
    views.push(second)
    await flush(4)
    assert.equal(second.last(), 'displayed detail')
    assert.equal(calls, 1, 'mounted consumers must share the protected answer')
    await first.unmount(); await second.unmount(); views.length = 0
    await pressure()
    const third = await mountView(<Probe />, h => h.textContent)
    views.push(third)
    await flush(4)
    assert.equal(third.last(), 'displayed detail')
    assert.equal(calls, 2, 'unmount must make detail eligible for eviction')
  } finally {
    for (const v of views) await v.unmount()
    globalThis.fetch = originalFetch
    forgetNodeDetail()
  }
})
