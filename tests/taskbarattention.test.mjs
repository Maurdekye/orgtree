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
const { TaskbarAttention, attentionIdentities } = createRequire(import.meta.url)(file)
test.after(() => rmSync(temp, { recursive: true, force: true }))

// TaskbarAttention branches its start()/stop() on the REAL process.platform
// (matching apps/desktop/main/index.ts's process.platform === 'win32' gating
// convention elsewhere). This dev/CI machine's real platform is whatever it
// is, so every pre-existing flashFrame-based assertion below is pinned to
// 'win32' - deterministic regardless of host OS, exactly like
// tests/resolve-packaged-python-path.test.mjs's own withPlatform helper.
function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
  try { return fn() } finally { Object.defineProperty(process, 'platform', original) }
}

function window() {
  const calls = []
  return {
    calls, focusedNow: false, destroyed: false,
    isDestroyed() { return this.destroyed },
    isFocused() { return this.focusedNow },
    flashFrame(flag) { calls.push(flag) },
  }
}

function dock() {
  const calls = []
  let nextId = 1
  return {
    calls,
    bounce(type) { const id = nextId++; calls.push(['bounce', type, id]); return id },
    cancelBounce(id) { calls.push(['cancelBounce', id]) },
  }
}

test('a new request pulses the taskbar and the same request polled again does not', () => withPlatform('win32', () => {
  const w = window(), attention = new TaskbarAttention(() => w)
  assert.equal(attention.set(['a']), true, 'the first waiting request pulses')
  assert.deepEqual(w.calls, [true])
  for (let i = 0; i < 5; i++) assert.equal(attention.set(['a']), false, 'polling is not an event')
  assert.deepEqual(w.calls, [true], 'the pulse is never restarted by the poll')
}))

test('resolving one of several requests neither clears nor restarts the pulse', () => withPlatform('win32', () => {
  const w = window(), attention = new TaskbarAttention(() => w)
  attention.set(['a', 'b', 'c'])
  assert.deepEqual(w.calls, [true])
  assert.equal(attention.set(['a', 'c']), false, 'one resolving is not a new arrival')
  assert.equal(attention.set(['c']), false)
  assert.deepEqual(w.calls, [true], 'the taskbar is left exactly as it was while work remains')
  assert.equal(attention.set([]), false, 'the last one resolving clears it')
  assert.deepEqual(w.calls, [true, false])
}))

test('a genuinely new request pulses even while older ones are still waiting', () => withPlatform('win32', () => {
  const w = window(), attention = new TaskbarAttention(() => w)
  attention.set(['a'])
  assert.equal(attention.set(['a', 'b']), true, 'b is new and claims attention of its own')
  assert.deepEqual(w.calls, [true, true])
}))

test('the window the user is already looking at is never flashed, and can pulse once they leave it', () => withPlatform('win32', () => {
  const w = window(), attention = new TaskbarAttention(() => w)
  w.focusedNow = true
  assert.equal(attention.set(['a']), false, 'no pulse while the user is in the window')
  assert.deepEqual(w.calls, [])
  assert.equal(attention.set(['a']), false, 'and the poll still does not start one')
  w.focusedNow = false
  assert.equal(attention.set(['a', 'b']), true, 'a later arrival pulses normally')
  assert.deepEqual(w.calls, [true])
}))

test('activation stops the pulse without discarding what is still waiting', () => withPlatform('win32', () => {
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
}))

test('a destroyed or missing window is survivable', () => withPlatform('win32', () => {
  const w = window()
  const missing = new TaskbarAttention(() => undefined)
  assert.equal(missing.set(['a']), false)
  const gone = new TaskbarAttention(() => w)
  w.destroyed = true
  assert.equal(gone.set(['a']), false)
  assert.deepEqual(w.calls, [])
}))

test('identities are validated at the boundary', () => {
  assert.deepEqual(attentionIdentities(['a', 'b']), ['a', 'b'])
  assert.deepEqual(attentionIdentities([]), [])
  for (const bad of [null, undefined, 'a', 1, {}, [1], [''], [null], [Array(401).fill('x').join('')]])
    assert.throws(() => attentionIdentities(bad), /Invalid attention identit/)
  assert.throws(() => attentionIdentities(Array.from({ length: 5001 }, (_, i) => String(i))),
    /Invalid attention identities/)
})

// ── macOS: dock bounce, injected via a constructor accessor (UI-01) ───────
test('darwin: a new arrival bounces the dock, a later poll of the same id does not re-bounce', () => withPlatform('darwin', () => {
  const d = dock(), attention = new TaskbarAttention(() => undefined, () => d)
  assert.equal(attention.set(['a']), true, 'the first waiting request bounces')
  assert.deepEqual(d.calls, [['bounce', 'critical', 1]])
  for (let i = 0; i < 5; i++) assert.equal(attention.set(['a']), false, 'polling is not an event')
  assert.deepEqual(d.calls, [['bounce', 'critical', 1]], 'the bounce is never restarted by the poll')
}))

test('darwin: the set draining to empty cancels the bounce with the stored id', () => withPlatform('darwin', () => {
  const d = dock(), attention = new TaskbarAttention(() => undefined, () => d)
  attention.set(['a', 'b'])
  assert.deepEqual(d.calls, [['bounce', 'critical', 1]])
  assert.equal(attention.set(['a']), false, 'one resolving does not cancel the bounce')
  assert.deepEqual(d.calls, [['bounce', 'critical', 1]])
  assert.equal(attention.set([]), false, 'the last one resolving cancels it')
  assert.deepEqual(d.calls, [['bounce', 'critical', 1], ['cancelBounce', 1]])
}))

test('darwin: an id seen again on a later poll after a full drain-and-return bounces again with a new id', () => withPlatform('darwin', () => {
  const d = dock(), attention = new TaskbarAttention(() => undefined, () => d)
  attention.set(['a'])
  attention.set([])
  assert.deepEqual(d.calls, [['bounce', 'critical', 1], ['cancelBounce', 1]])
  assert.equal(attention.set(['a']), true, 'a genuinely new arrival after a full drain bounces again')
  assert.deepEqual(d.calls, [['bounce', 'critical', 1], ['cancelBounce', 1], ['bounce', 'critical', 2]])
}))

test('darwin: no dock accessor is survivable, matching the missing-window shape on win32', () => withPlatform('darwin', () => {
  const attention = new TaskbarAttention(() => undefined)
  assert.equal(attention.set(['a']), false)
}))
