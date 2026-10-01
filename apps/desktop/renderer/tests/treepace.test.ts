/** App's org-tree read pacing (src/treepace.ts).
 *
 * N1000 attempt 9: every ws frame asked for the tree, the trailing read began
 * the instant the previous one landed, and four windows re-read a 6.9 MB tree
 * 93 times a minute. The rule under test: one read in flight, requests during
 * it coalesce into exactly ONE trailing read (never dropped), and a read of
 * the same org starts no sooner than max(1.5 s, 2 x the last read's duration,
 * 10 s while hidden), capped at 15 s, after the previous one FINISHED. A
 * different org and an urgent (user-driven selection) request skip the gap.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { TREE_HIDDEN_GAP_MS, TREE_MAX_GAP_MS, TREE_MIN_GAP_MS, TreeReadPacer, treeGap } from '../src/treepace'

type Rig = { pacer: TreeReadPacer; started: string[]; finish: (ok?: boolean) => Promise<void>
  advance: (ms: number) => Promise<void>; hidden: { value: boolean } }

function rig(t: import('node:test').TestContext): Rig {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 1_000_000
  const hidden = { value: false }
  const started: string[] = []
  const open: Array<{ resolve: () => void; reject: (e: Error) => void }> = []
  const pacer = new TreeReadPacer(slug => {
    started.push(slug)
    return new Promise<void>((resolve, reject) => { open.push({ resolve, reject }) })
  }, () => hidden.value, () => clock)
  const flush = async () => { for (let i = 0; i < 5; ++i) await Promise.resolve() }
  return {
    pacer, started, hidden,
    finish: async (ok = true) => {
      const read = open.shift()
      assert.ok(read, 'no read in flight to finish')
      if (ok) read.resolve(); else read.reject(new Error('engine down'))
      await flush()
    },
    advance: async (ms: number) => { clock += ms; t.mock.timers.tick(ms); await flush() },
  }
}

test('an idle request reads at once; requests during a read coalesce into ONE trailing read', async (t) => {
  const r = rig(t)
  r.pacer.request('acme')
  assert.deepEqual(r.started, ['acme'])
  for (let i = 0; i < 20; ++i) r.pacer.request('acme')
  await r.advance(100)
  await r.finish()
  await r.advance(TREE_MIN_GAP_MS)
  assert.deepEqual(r.started, ['acme', 'acme'], 'twenty frames, exactly one trailing read')
  await r.finish()
  await r.advance(60_000)
  assert.equal(r.started.length, 2, 'nothing more without another request')
})

test('the trailing read of the same org waits the gap after the last read finished', async (t) => {
  const r = rig(t)
  r.pacer.request('acme')
  await r.advance(100)                      // took 100 ms: the 1.5 s floor applies
  await r.finish()
  r.pacer.request('acme')
  await r.advance(TREE_MIN_GAP_MS - 1)
  assert.equal(r.started.length, 1, 'not before the gap')
  await r.advance(1)
  assert.equal(r.started.length, 2, 'exactly at the gap')
})

test('a slow read widens the gap to twice its duration, capped', async (t) => {
  const r = rig(t)
  r.pacer.request('acme')
  await r.advance(2000)
  await r.finish()
  r.pacer.request('acme')
  await r.advance(3999)
  assert.equal(r.started.length, 1)
  await r.advance(1)
  assert.equal(r.started.length, 2)
  await r.advance(30_000)                   // a 30 s read: capped at 15 s
  await r.finish()
  r.pacer.request('acme')
  await r.advance(TREE_MAX_GAP_MS - 1)
  assert.equal(r.started.length, 2)
  await r.advance(1)
  assert.equal(r.started.length, 3)
})

test('a request that arrives mid-gap is not dropped and does not add a read', async (t) => {
  const r = rig(t)
  r.pacer.request('acme')
  await r.finish()
  r.pacer.request('acme')
  await r.advance(500)
  r.pacer.request('acme')
  r.pacer.request('acme')
  await r.advance(TREE_MIN_GAP_MS)
  assert.deepEqual(r.started, ['acme', 'acme'])
})

test('another org and an urgent request skip the gap; a hidden window waits longer', async (t) => {
  const r = rig(t)
  r.pacer.request('acme')
  await r.finish()
  r.pacer.request('acme')                   // waiting on the gap...
  r.pacer.request('other')                  // ...an org switch replaces it and reads now
  assert.deepEqual(r.started, ['acme', 'other'])
  await r.finish()
  r.pacer.request('other', { urgent: true })
  assert.deepEqual(r.started, ['acme', 'other', 'other'])
  await r.finish()
  r.hidden.value = true
  r.pacer.request('other')
  await r.advance(TREE_HIDDEN_GAP_MS - 1)
  assert.equal(r.started.length, 3)
  await r.advance(1)
  assert.equal(r.started.length, 4)
})

test('an urgent request during a read runs right after it, without the gap', async (t) => {
  const r = rig(t)
  r.pacer.request('acme')
  r.pacer.request('acme', { urgent: true })
  await r.finish()
  assert.deepEqual(r.started, ['acme', 'acme'])
})

test('keep leaves an already queued org in place', async (t) => {
  const r = rig(t)
  r.pacer.request('acme')
  r.pacer.request('other')
  r.pacer.request('acme', { keep: true, urgent: true })
  await r.finish()
  assert.deepEqual(r.started, ['acme', 'other'])
})

test('a failed read still settles, and its trailing read still runs', async (t) => {
  const r = rig(t)
  r.pacer.request('acme')
  r.pacer.request('acme')
  await r.finish(false)
  await r.advance(TREE_MIN_GAP_MS)
  assert.deepEqual(r.started, ['acme', 'acme'])
})

test('dispose cancels a waiting read', async (t) => {
  const r = rig(t)
  r.pacer.request('acme')
  await r.finish()
  r.pacer.request('acme')
  r.pacer.dispose()
  await r.advance(60_000)
  assert.equal(r.started.length, 1)
})

test('treeGap: no previous read or another org is 0; otherwise measured from the finish', () => {
  assert.equal(treeGap(null, 'a', 0, false), 0)
  assert.equal(treeGap({ slug: 'b', at: 0, took: 10 }, 'a', 0, false), 0)
  assert.equal(treeGap({ slug: 'a', at: 0, took: 10 }, 'a', 0, false), TREE_MIN_GAP_MS)
  assert.equal(treeGap({ slug: 'a', at: 0, took: 10 }, 'a', 5000, false), 0)
})
