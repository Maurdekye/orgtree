import test from 'node:test'
import assert from 'node:assert/strict'
import { forgetNodeDetail, nodeDetail } from '../src/archived'

// Exercise the public fetch API, not a second implementation or cache-size
// debug counter. The first miss ends the probe before it changes retention.
test('detail retention is flat after 100 versus 1000 inactive visits', async () => {
  const counts: number[] = []
  for (const history of [100, 1000]) {
    forgetNodeDetail()
    let calls = 0
    const fetcher = async (_slug: string, id: string) => {
      calls++
      return { charter: id }
    }
    const seat = (i: number) => ({ id: `seat-${i}`, detail: false, detail_rev: 'r' })
    for (let i = 0; i < history; i++) await nodeDetail('org', seat(i), fetcher)
    assert.equal(calls, history, 'every historical visit actually fetched')
    let hits = 0
    for (let i = history - 1; i >= 0; i--) {
      const before = calls
      assert.equal((await nodeDetail('org', seat(i), fetcher)).charter, `seat-${i}`)
      if (calls !== before) break
      hits++
    }
    counts.push(hits)
  }
  console.log(JSON.stringify({ historicalVisits: [100, 1000], retainedAnswers: counts }))
  assert.deepEqual(counts, [64, 64], 'tenfold history must not grow retained answers')
  forgetNodeDetail()
})
