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
