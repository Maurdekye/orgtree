import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ForegroundWorkReader, WORK_FOREGROUND_FORMAT as format } from '../src/workforeground'

const row = (slug: string) => ({ slug, title: slug })
const first = (old: string[] = [], cursor: string | null = null, catalog = [1]) => ({
  format, items: [row('active')], archived: old.map(row), references: old.map(row),
  counts: { active: 1, archived: old.length, attention: 0, backlogged: 0 }, now: 'now',
  catalog, next_cursor: cursor,
})
const reply = (body: unknown, status = 200, etag?: string) => new Response(JSON.stringify(body),
  { status, headers: etag ? { ETag: etag } : {} })
const noLegacy = async (): Promise<never> => { throw new Error('unexpected legacy call') }

test('closed reader requests no archive; open reader completes pages without caching history', async () => {
  const calls: string[] = []
  const reader = new ForegroundWorkReader(async path => {
    calls.push(path)
    if (path.includes('archive-page')) return reply(first(['b']))
    if (path.includes('archive_limit=100')) return reply(first(['a'], 'next'))
    const { archived, catalog, next_cursor, ...body } = first()
    return reply(body, 200, 'foreground')
  }, noLegacy)
  const closed = await reader.get('org')
  assert.equal(closed.archived, undefined)
  for (let n = 0; n < 2; ++n) {
    assert.deepEqual((await reader.get('org', true)).archived?.map(x => x.slug), ['a', 'b'])
  }
  assert.equal(calls.filter(x => x.includes('archive-page')).length, 2)
  assert.equal(calls.filter(x => x.includes('archive_limit=100')).length, 2)
  assert.match(calls[0], /archive_limit=0$/)
})

test('reset discards every partial row; continuing churn uses one whole legacy response', async () => {
  let starts = 0, legacy = 0
  const reader = new ForegroundWorkReader(async path => {
    if (path.includes('archive-page')) return reply({ kind: 'reset' }, 409)
    return reply(first([`discard-${++starts}`], 'next'))
  }, async () => { ++legacy; return first(['legacy']) as any })
  assert.deepEqual((await reader.get('org', true)).archived?.map(x => x.slug), ['legacy'])
  assert.equal(starts, 2); assert.equal(legacy, 1)
})

test('catalog mismatch and duplicate rows cannot produce a mixed successful answer', async () => {
  for (const page of [first(['other'], null, [2]), first(['a'])]) {
    let fallback = 0
    const reader = new ForegroundWorkReader(async path => reply(
      path.includes('archive-page') ? page : first(['a'], 'next')),
      async () => { ++fallback; return first(['whole']) as any })
    assert.deepEqual((await reader.get('org', true)).archived?.map(x => x.slug), ['whole'])
    assert.equal(fallback, 1)
  }
})

test('ordinary transport errors do not hide behind compatibility; cycles stop', async () => {
  const failure = new ForegroundWorkReader(async () => reply({ detail: 'offline' }, 503), noLegacy)
  await assert.rejects(failure.get('org'), /offline/)
  let n = 0
  const cycle = new ForegroundWorkReader(async () => reply(first([String(++n)], 'same')), noLegacy)
  await assert.rejects(cycle.get('org', true), /did not advance/)
  assert.equal(n, 2)
})

test('invalidation detaches old promises and prevents stale cache replacement', async () => {
  const resolvers: ((r: Response) => void)[] = []
  const etags: (string | undefined)[] = []
  const reader = new ForegroundWorkReader((_path, etag) => {
    etags.push(etag)
    return new Promise(resolve => resolvers.push(resolve))
  }, noLegacy)
  const old = reader.get('org')
  assert.equal(reader.get('org'), old)
  reader.invalidate()
  const newer = reader.get('org')
  resolvers[1](reply(first(), 200, 'new'))
  await newer
  resolvers[0](reply(first(), 200, 'old'))
  await old
  const final = reader.get('org')
  assert.equal(etags[2], 'new')
  resolvers[2](new Response(null, { status: 304 }))
  await final
})
