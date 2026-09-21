import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const temp = mkdtempSync(path.join(tmpdir(), 'orgtree-taskbar-attention-'))
const file = path.join(temp, 'taskbar-attention.cjs')
await build({ entryPoints: ['apps/desktop/main/taskbar-attention.ts'], outfile: file,
  bundle: true, platform: 'node', format: 'cjs' })
const { TaskbarAttention, attentionIdentities, attentionItems, attentionPayload } = createRequire(import.meta.url)(file)
test.after(() => rmSync(temp, { recursive: true, force: true }))

function window() {
  const calls = []
  return {
    calls, focusedNow: false, destroyed: false,
    isDestroyed() { return this.destroyed },
    isFocused() { return this.focusedNow },
    flashFrame(flag) { calls.push(flag) },
  }
}

test('a new request pulses the taskbar and the same request polled again does not', () => {
  const w = window(), attention = new TaskbarAttention(() => w)
  assert.equal(attention.set(['a']), true, 'the first waiting request pulses')
  assert.deepEqual(w.calls, [true])
  for (let i = 0; i < 5; i++) assert.equal(attention.set(['a']), false, 'polling is not an event')
  assert.deepEqual(w.calls, [true], 'the pulse is never restarted by the poll')
})

test('resolving one of several requests neither clears nor restarts the pulse', () => {
  const w = window(), attention = new TaskbarAttention(() => w)
  attention.set(['a', 'b', 'c'])
  assert.deepEqual(w.calls, [true])
  assert.equal(attention.set(['a', 'c']), false, 'one resolving is not a new arrival')
  assert.equal(attention.set(['c']), false)
  assert.deepEqual(w.calls, [true], 'the taskbar is left exactly as it was while work remains')
  assert.equal(attention.set([]), false, 'the last one resolving clears it')
  assert.deepEqual(w.calls, [true, false])
})

test('a genuinely new request pulses even while older ones are still waiting', () => {
  const w = window(), attention = new TaskbarAttention(() => w)
  attention.set(['a'])
  assert.equal(attention.set(['a', 'b']), true, 'b is new and claims attention of its own')
  assert.deepEqual(w.calls, [true, true])
})

test('the window the user is already looking at is never flashed, and can pulse once they leave it', () => {
  const w = window(), attention = new TaskbarAttention(() => w)
  w.focusedNow = true
  assert.equal(attention.set(['a']), false, 'no pulse while the user is in the window')
  assert.deepEqual(w.calls, [])
  assert.equal(attention.set(['a']), false, 'and the poll still does not start one')
  w.focusedNow = false
  assert.equal(attention.set(['a', 'b']), true, 'a later arrival pulses normally')
  assert.deepEqual(w.calls, [true])
})

test('activation stops the pulse without discarding what is still waiting', () => {
  const w = window(), attention = new TaskbarAttention(() => w)
  attention.set(['a'])
  assert.deepEqual(w.calls, [true])
  w.focusedNow = true; attention.focused()
  assert.equal(attention.set(['a']), false, 'the same request does not pulse again after it was seen')
  w.focusedNow = false
  assert.equal(attention.set(['a']), false, 'nor when the user simply looks away')
  assert.deepEqual(w.calls, [true])
  attention.set([])
  assert.deepEqual(w.calls, [true], 'clearing a flash the platform already cancelled touches nothing')
})

test('a destroyed or missing window is survivable', () => {
  const w = window()
  const missing = new TaskbarAttention(() => undefined)
  assert.equal(missing.set(['a']), false)
  const gone = new TaskbarAttention(() => w)
  w.destroyed = true
  assert.equal(gone.set(['a']), false)
  assert.deepEqual(w.calls, [])
})

test('identities are validated at the boundary', () => {
  assert.deepEqual(attentionIdentities(['a', 'b']), ['a', 'b'])
  assert.deepEqual(attentionIdentities([]), [])
  for (const bad of [null, undefined, 'a', 1, {}, [1], [''], [null], [Array(401).fill('x').join('')]])
    assert.throws(() => attentionIdentities(bad), /Invalid attention identit/)
  assert.throws(() => attentionIdentities(Array.from({ length: 5001 }, (_, i) => String(i))),
    /Invalid attention identities/)
})

// ------------------------------------------------- which window pulses
// User ruling 2026-09-21 (relayed through coordinator-sol): the pulse belongs
// to the organization that owns the affected item; with no window for that
// organization it falls back to the last-used main window; every main window
// is never flashed. These are the negative controls for exactly that.

/** A resolver shaped like the one index.ts builds: organization first, the
 *  last-used window as the fallback. */
const routed = (byOrg, fallback) => org => (org && byOrg[org]) || fallback

test('an item pulses the window of ITS organization and no other', () => {
  const acme = window(), beta = window(), lastUsed = window()
  const attention = new TaskbarAttention(routed({ acme, beta }, lastUsed))
  assert.equal(attention.set([{ id: 'q1', org: 'acme' }]), true)
  assert.deepEqual(acme.calls, [true])
  assert.deepEqual(beta.calls, [], 'an unaffected organization is left alone')
  assert.deepEqual(lastUsed.calls, [], 'and so is the window the user happens to be in')
})

test('an item whose organization has no window falls back to the last-used main', () => {
  const acme = window(), lastUsed = window()
  const attention = new TaskbarAttention(routed({ acme }, lastUsed))
  assert.equal(attention.set([{ id: 'q1', org: 'unopened' }]), true)
  assert.deepEqual(lastUsed.calls, [true])
  assert.deepEqual(acme.calls, [], 'the fallback is the last-used window, not some other organization')
})

test('NEGATIVE CONTROL: several windows open, only the affected ones ever flash', () => {
  const acme = window(), beta = window(), gamma = window(), lastUsed = window()
  const attention = new TaskbarAttention(routed({ acme, beta, gamma }, lastUsed))
  attention.set([{ id: 'q1', org: 'beta' }])
  assert.deepEqual([acme.calls, beta.calls, gamma.calls, lastUsed.calls], [[], [true], [], []])

  // two organizations get an arrival in the same poll: each pulses once, and
  // the untouched ones still never do
  assert.equal(attention.set([{ id: 'q1', org: 'beta' }, { id: 'q2', org: 'acme' }, { id: 'q3', org: 'gamma' }]), true)
  assert.deepEqual([acme.calls, beta.calls, gamma.calls, lastUsed.calls], [[true], [true], [true], []],
    'beta does not pulse a second time for an item it already knew')
})

test('several items arriving for one organization pulse its window once', () => {
  const acme = window(), lastUsed = window()
  const attention = new TaskbarAttention(routed({ acme }, lastUsed))
  attention.set([{ id: 'q1', org: 'acme' }, { id: 'q2', org: 'acme' }, { id: 'q3', org: 'acme' }])
  assert.deepEqual(acme.calls, [true], 'one arrival event, one pulse')
})

test('activation clears only the window that was activated', () => {
  const acme = window(), beta = window(), lastUsed = window()
  const attention = new TaskbarAttention(routed({ acme, beta }, lastUsed))
  attention.set([{ id: 'q1', org: 'acme' }, { id: 'q2', org: 'beta' }])
  assert.deepEqual([acme.calls, beta.calls], [[true], [true]])

  acme.focusedNow = true
  attention.focused(acme)
  attention.set([])                    // everything resolved
  assert.deepEqual(acme.calls, [true], 'the platform already cancelled the one that was activated')
  assert.deepEqual(beta.calls, [true, false], 'the one still pulsing is cleared')
})

test('the org-bearing payload is validated at the boundary, and the v2 shape still works', () => {
  assert.deepEqual(attentionItems(['a', 'b']), [{ id: 'a' }, { id: 'b' }],
    'a bare identity list means "no organization known" and routes to the fallback')
  assert.deepEqual(attentionItems([{ id: 'a', org: 'acme' }, { id: 'b' }]), [{ id: 'a', org: 'acme' }, { id: 'b' }])
  assert.deepEqual(attentionItems([]), [])
  for (const bad of [null, undefined, 'a', 1, {}, [1], [''], [null], [[]],
    [{ id: '' }], [{ id: 'a', org: '' }], [{ id: 'a', extra: 1 }], [{ org: 'acme' }],
    [{ id: 'a', org: 'x'.repeat(129) }], [{ id: 'x'.repeat(401) }]])
    assert.throws(() => attentionItems(bad), /Invalid attention identit/, JSON.stringify(bad))
  assert.throws(() => attentionItems(Array.from({ length: 5001 }, (_, i) => String(i))),
    /Invalid attention identities/)
})

test('the organization arrives as DATA, never parsed out of the dedup encoding', () => {
  // summarizePending encodes a row as JSON.stringify([org, id]) and the first
  // version of this read the organization back out of that string. It is the
  // renderer's dedup ENCODING, not a contract: it may change the day the dedup
  // key needs to, and nothing on either side would fail to compile or go red -
  // the pulse would simply stop reaching the right window. So the organization
  // is supplied alongside, and an identity is never reinterpreted.
  const encoded = JSON.stringify(['acme', 'q1'])
  assert.deepEqual(attentionPayload([encoded], undefined), [{ id: encoded }],
    'the encoding alone tells native nothing about the organization')
  assert.deepEqual(attentionPayload([encoded], [{ org: 'acme', id: 'q1' }]),
    [{ id: encoded, org: 'acme' }])
  assert.equal(attentionPayload([encoded], [{ org: 'acme', id: 'q1' }])[0].id, encoded,
    'and the identity itself is untouched, so the genuinely-new dedup compares what it always compared')
})

test('the paired payload is refused when the two halves disagree', () => {
  // The correspondence is positional and structural - both halves come out of
  // one pass - so a length mismatch is a real disagreement about what was
  // published, not something to zip as far as it goes.
  assert.throws(() => attentionPayload(['a', 'b'], [{ org: 'acme', id: 'a' }]), /Invalid attention identities/)
  assert.throws(() => attentionPayload(['a'], [{ org: 'acme', id: 'a' }, { org: 'beta', id: 'b' }]), /Invalid attention identities/)
  assert.deepEqual(attentionPayload([], []), [])
  // the v2 call, unchanged in meaning: no organizations, so the fallback
  assert.deepEqual(attentionPayload(['a', 'b'], null), [{ id: 'a' }, { id: 'b' }])
})

test('an item routed from the supplied organization reaches its own window', () => {
  const acme = window(), beta = window(), lastUsed = window()
  const attention = new TaskbarAttention(routed({ acme, beta }, lastUsed))
  const ids = [JSON.stringify(['beta', 'q1'])]
  assert.equal(attention.set(attentionPayload(ids, [{ org: 'beta', id: 'q1' }])), true)
  assert.deepEqual([acme.calls, beta.calls, lastUsed.calls], [[], [true], []])
})

test('NEGATIVE CONTROL: clearing flashes the windows that actually pulsed, not whoever is last-used NOW', () => {
  // The hazard: a resolver consulted again at clear time answers with today's
  // last-used window, which may be a window that never flashed - leaving the
  // real pulse running and touching an innocent window instead. The flashing
  // windows are therefore remembered, not re-derived.
  const acme = window()
  let fallback = window()
  const attention = new TaskbarAttention(org => (org === 'acme' ? acme : fallback))
  attention.set([{ id: 'q1', org: 'unopened' }])
  assert.deepEqual(fallback.calls, [true], 'it pulsed the last-used window of the time')

  const pulsed = fallback
  fallback = window()                       // the user moved on; last-used changed
  attention.set([])                         // everything resolved
  assert.deepEqual(pulsed.calls, [true, false], 'the window that actually pulsed is the one cleared')
  assert.deepEqual(fallback.calls, [], 'and the window that never pulsed is never touched')
})

test('a batch affecting a subset of the open organizations leaves the rest untouched', () => {
  const acme = window(), beta = window(), gamma = window(), lastUsed = window()
  const attention = new TaskbarAttention(routed({ acme, beta, gamma }, lastUsed))
  attention.set(attentionPayload(
    [JSON.stringify(['acme', 'q1']), JSON.stringify(['gamma', 'q2'])],
    [{ org: 'acme', id: 'q1' }, { org: 'gamma', id: 'q2' }]))
  assert.deepEqual([acme.calls, beta.calls, gamma.calls, lastUsed.calls], [[true], [], [true], []])

  // and resolving one of the two neither clears nor re-flashes anything
  attention.set(attentionPayload([JSON.stringify(['acme', 'q1'])], [{ org: 'acme', id: 'q1' }]))
  assert.deepEqual([acme.calls, beta.calls, gamma.calls, lastUsed.calls], [[true], [], [true], []])
})
