// treestatus.test.tsx — how fresh the tree on screen is, for Attention's
// completeness gate.
//
// The gate's queue has three sources and it polls only two; unanswered
// QUESTIONS come out of App's `tree`. So a gate built from its own feeds alone
// can answer cleanly and empty while the tree is a poll behind or its refresh
// has failed, and print "nothing is waiting on you here" with a question
// actually waiting. This is the signal that stops that, and the properties
// below are the ones that make it worth trusting.
//
// Run:  node apps/desktop/renderer/tests/run.mjs treestatus
import { flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { treeStatusOf } from '../src/shell/treestatus'
import type { TreePayload } from '../src/types'

declare const __SRC_DIR__: string
const src = (name: string) => fs.readFileSync(path.join(__SRC_DIR__, name), 'utf8')
void flush

const tree = (slug: string) => ({ slug, name: slug, roots: [] } as unknown as TreePayload)
const ok = { at: 1_000, error: null }
const bad = { at: 1_000, error: 'signal timed out' }
const never = { at: null, error: null }
const neverThenBad = { at: null, error: 'signal timed out' }

test('a first read in flight is loading, and claims nothing', () => {
  const s = treeStatusOf(never, null, 'studio')
  assert.deepEqual([s.loading, s.failed, s.stale, s.unavailable], [true, false, false, false])
  assert.equal(s.at, null, 'no successful read to date')
})

test('a held tree with a clean last read is none of the four — ordinary latency is CURRENT', () => {
  // ⚠ THE PROPERTY THAT KEEPS THE HEDGE MEANINGFUL. Only a FAILED refresh is
  // stale. If plain age counted, the hedge would be permanent, and a
  // permanent hedge is one nobody reads — which costs exactly the trust this
  // signal exists to buy.
  const s = treeStatusOf(ok, tree('studio'), 'studio')
  assert.deepEqual([s.loading, s.failed, s.stale, s.unavailable], [false, false, false, false])
  assert.equal(s.at, 1_000, 'and it says when it last really succeeded')
})

test('a failed refresh over a tree we DO hold is stale, not unavailable', () => {
  // this is the case the gate must hedge on: rows are on screen and one of
  // their sources stopped being able to confirm itself
  const s = treeStatusOf(bad, tree('studio'), 'studio')
  assert.deepEqual([s.loading, s.failed, s.stale, s.unavailable], [false, true, true, false])
  assert.equal(s.error, 'signal timed out')
  assert.equal(s.at, 1_000, 'the age of the last good read is still reported')
})

test('a failure with NOTHING held is unavailable, not stale', () => {
  const s = treeStatusOf(neverThenBad, null, 'studio')
  assert.deepEqual([s.loading, s.failed, s.stale, s.unavailable], [false, true, false, true])
  assert.equal(s.at, null)
})

test('recovery clears it — the signal is the LATEST read, not a latch', () => {
  const failing = treeStatusOf(bad, tree('studio'), 'studio')
  assert.equal(failing.stale, true)
  const recovered = treeStatusOf({ at: 2_000, error: null }, tree('studio'), 'studio')
  assert.deepEqual([recovered.stale, recovered.failed], [false, false])
  assert.equal(recovered.at, 2_000)
})

test('a tree for ANOTHER organization is not a tree we hold', () => {
  // ⚠ mid-switch, the predecessor's payload certifies nothing about the
  // organization now on screen, so this reports loading rather than
  // vouching for somebody else's tree
  const s = treeStatusOf(never, tree('workshop'), 'studio')
  assert.equal(s.loading, true)
  assert.equal(s.stale, false)
  // and with a failure recorded it is unavailable, not stale, because what we
  // hold is not for here
  const f = treeStatusOf(neverThenBad, tree('workshop'), 'studio')
  assert.deepEqual([f.unavailable, f.stale], [true, false])
})

test('no organization at all holds nothing', () => {
  assert.equal(treeStatusOf(ok, tree('studio'), null).loading, true)
})

// ---------------------------------------------- the wiring, pinned at source

test('only an APPLICABLE body refreshes the stamp', () => {
  const app = src('App.tsx')
  // the same test that decides whether to paint a body decides whether it
  // certifies one — one rule, not two that can drift
  assert.match(app, /if \(t && wantSlug\.current === want\) \{[\s\S]{0,600}?setTreeRead\(\{ at: Date\.now\(\), error: null \}\)/,
    'a null body or one for an organization we have left does not stamp')
})

test('a LATE failure for an organization we have left is ignored', () => {
  const app = src('App.tsx')
  assert.match(app, /if \(wantSlug\.current === want\) \{\s*setTreeRead\(\(r\) => \(\{ \.\.\.r, error: e\.message \|\| 'unavailable' \}\)\)/,
    'the failure is scoped to the organization it was for')
})

test('the shared banner is NOT the source, and an org-list success cannot clear a tree failure', () => {
  const app = src('App.tsx')
  // ⚠ fetchOk/fetchErr are shared with the organization-list poller and the
  // banner deliberately waits for TWO consecutive failures. Neither can stand
  // in for this: an org-list SUCCESS would clear a failed tree, and here the
  // FIRST failure already matters.
  assert.match(app, /const \[treeRead, setTreeRead\]/, 'the tree keeps its own record')
  // setTreeRead must appear ONLY inside the tree fetch, never in the org-list
  // path — count the call sites and name them
  const writes = [...app.matchAll(/setTreeRead\(/g)].length
  assert.equal(writes, 3, 'exactly three: the reset on org change, the success, the failure')
  assert.doesNotMatch(app, /onOk: \(\) => setTreeRead|onError: \(\) => setTreeRead/,
    'the organization-list poller never touches it')
})

test('a different organization resets the record rather than inheriting it', () => {
  const app = src('App.tsx')
  assert.match(app, /useEffect\(\(\) => \{ setTreeRead\(\{ at: null, error: null \}\) \}, \[slug\]\)/)
})

test('no second tree fetch was added', () => {
  const app = src('App.tsx')
  // the whole signal rides the one coalesced fetch; a second poller would be
  // a second source of truth about the same thing
  assert.equal([...app.matchAll(/getTree\(/g)].length, 1,
    'getTree is called in exactly one place')
})
