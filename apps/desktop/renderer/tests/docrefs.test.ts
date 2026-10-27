// tests/docrefs.test.ts — the presentation mention label reader (canvas/docrefs.ts, USER 2026-10-27 m7bb9eb904138):
// it answers the shared label path for 'doc' references by the gallery's bounded `refs` read, an old generic id
// with the presentation it named, and the org socket's documents_changed frame (sent by every orgtree_present)
// reads the kept titles again; any other frame does not.
import { flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { documentsFeed } from '../src/canvas/docrefs'
import { refNames } from '../src/canvas/refnames'

const settle = async () => { for (let i = 0; i < 8; i++) await flush() }

test('a doc reference is named by its title, an old id too; only documents_changed reads them again', async t => {
  const org = 'docrefs-feed', reads: string[][] = []
  let title = 'Launch plan'
  const original = globalThis.fetch
  globalThis.fetch = (async (raw: RequestInfo | URL) => {
    const url = new URL(String(raw), 'http://local')
    const asked = (url.searchParams.get('refs') ?? '').split(',').filter(Boolean)
    reads.push(asked)
    const refs = asked.flatMap(ref => ref === 'launch-plan' || ref === 'd00000000c001'
      ? [{ ref, id: 'launch-plan', title, format: 'markdown' }] : [])
    return new Response(JSON.stringify({ refs }), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  const name = (id: string) => refNames.describe(org, { kind: 'doc', org, id })
  assert.deepEqual(name('launch-plan'), { outcome: 'pending' })
  name('d00000000c001'); name('gone')
  await settle()
  assert.deepEqual(reads, [['launch-plan', 'd00000000c001', 'gone']], 'one bounded read for the references asked together')
  assert.deepEqual([name('launch-plan'), name('d00000000c001')].map(a => a?.label), ['Launch plan', 'Launch plan'])
  assert.equal(name('gone')?.outcome, 'absent', 'the engine left it out: the reader says so (the chip keeps its own verdict)')
  title = 'Launch plan, final'
  assert.equal(documentsFeed(org, { type: 'docket_changed' }), false)
  assert.equal(documentsFeed(org, null), false)
  await settle()
  assert.equal(reads.length, 1, 'no presentation frame, no read')
  assert.equal(documentsFeed(org, { type: 'documents_changed' }), true)
  await settle()
  assert.equal(reads.length, 2)
  assert.equal(name('launch-plan')?.label, 'Launch plan, final')
})
