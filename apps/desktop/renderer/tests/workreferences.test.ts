import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkReferenceReader, type WorkReference } from '../src/workreferences'
const row = (slug: string) => ({ slug, title: slug }) as WorkReference

test('requests are bounded, deduplicated and both positive/negative answers are evicted', async () => {
  const calls: string[][] = []
  const reader = new WorkReferenceReader(async (_org, names) => {
    calls.push(names); return names.filter(n => n !== 'absent').map(row)
  }, 3)
  await reader.get('org', 'r1', ['one', 'one', 'absent'])
  await reader.get('org', 'r1', ['one', 'absent'])
  assert.equal(calls.length, 1)
  await reader.get('org', 'r1', ['two', 'three', 'four'])
  await reader.get('org', 'r1', ['one', 'absent'])
  assert.deepEqual(calls.at(-1), ['one', 'absent'])
  const ids = Array.from({ length: 1000 }, (_, n) => `old-${n}`)
  const result = await reader.get('org', 'r1', ids)
  assert.equal(result.size, 1000)
  assert.ok(calls.every(c => c.length <= 128))
  assert.equal((result.get('old-0'))?.slug, 'old-0', 'cache eviction cannot lose pending answers')
})

test('org/revision and invalidation isolate cached absence; old requests cannot replace new answers', async () => {
  const callbacks: ((r: WorkReference[]) => void)[] = []
  const reader = new WorkReferenceReader(() => new Promise(resolve => callbacks.push(resolve)))
  const old = reader.get('org', 'r1', ['one'])
  reader.invalidate()
  const fresh = reader.get('org', 'r1', ['one'])
  callbacks[1]([row('one')]); await fresh
  callbacks[0]([]); await old
  assert.equal((await reader.get('org', 'r1', ['one'])).get('one')?.slug, 'one')
  const other = reader.get('other', 'r1', ['one'])
  callbacks[2]([]); await other
  const changed = reader.get('org', 'r2', ['one'])
  callbacks[3]([]); await changed
  assert.equal(callbacks.length, 4)
})

test('transport failures are retryable rather than permanently cached absence', async () => {
  let calls = 0
  const reader = new WorkReferenceReader(async () => {
    if (++calls === 1) throw new Error('offline')
    return [row('one')]
  })
  await assert.rejects(reader.get('org', '', ['one']), /offline/)
  assert.equal((await reader.get('org', '', ['one'])).get('one')?.slug, 'one')
  assert.equal(calls, 2)
})

test('concurrent views share pending lookups and at most four batches run', async () => {
  const callbacks: (() => void)[] = []
  let running = 0, peak = 0, calls = 0
  const reader = new WorkReferenceReader(async (_org, names) => {
    ++calls; peak = Math.max(peak, ++running)
    await new Promise<void>(resolve => callbacks.push(resolve))
    --running; return names.map(row)
  })
  const tasks = Array.from({ length: 6 }, (_, n) => reader.get('org', '', [`id-${n}`]))
  const duplicate = reader.get('org', '', ['id-0'])
  assert.equal(calls, 4)
  for (let n = 0; n < 6; ++n) {
    callbacks[n]()
    await new Promise(resolve => setImmediate(resolve))
  }
  await Promise.all([...tasks, duplicate])
  assert.equal(calls, 6); assert.equal(peak, 4)
})
