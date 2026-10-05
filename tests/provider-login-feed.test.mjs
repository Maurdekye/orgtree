import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const temp = mkdtempSync(path.join(tmpdir(), 'orgtree-login-feed-'))
const output = path.join(temp, 'feed.cjs')
await build({ entryPoints: ['packages/contracts/provider-login-feed.ts'], outfile: output,
  bundle: true, platform: 'node', format: 'cjs' })
const { subscribeProviderLogin } = createRequire(import.meta.url)(output)
test.after(() => rmSync(temp, { recursive: true, force: true }))
const status = phase => ({ phase, ok: null, output: '', ageMs: 0, timedOut: false })
function setup() {
  const listeners = new Set(), copies = [], received = []
  const bridge = {
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    getProviderLoginStatus(provider) {
      assert.equal(listeners.size, 1, 'listener must exist before snapshot request')
      return new Promise(resolve => copies.push(resolve))
    },
  }
  const emit = (value, provider = 'claude') => {
    for (const fn of listeners) fn({ type: 'provider-login-status', data: { provider, status: value } })
  }
  return { bridge, listeners, copies, received, emit,
    mount: () => subscribeProviderLogin(bridge, 'claude', value => received.push(value)) }
}

test('subscribe before copy: a delayed idle copy cannot overwrite awaiting code', async () => {
  const f = setup(), sub = f.mount()
  f.emit(status('awaiting_code'))
  f.copies[0](status('idle'))
  await Promise.resolve()
  assert.deepEqual(f.received.map(s => s.phase), ['awaiting_code'])
  sub.close()
})

test('reload mid-login re-snapshots and teardown ends events and pending copies', async () => {
  const f = setup(), old = f.mount()
  old.close()
  assert.equal(f.listeners.size, 0)
  f.copies[0](status('idle'))
  const sub = f.mount()
  f.copies[1](status('awaiting_code'))
  await Promise.resolve()
  assert.deepEqual(f.received.map(s => s.phase), ['awaiting_code'])
  sub.close()
  f.emit(status('done'))
  assert.equal(f.received.length, 1)
})

test('start response cannot overwrite success, failure or cancel events', async () => {
  for (const final of [{ ...status('done'), ok: true }, { ...status('done'), ok: false }, status('idle')]) {
    const f = setup(), sub = f.mount()
    f.copies[0](status('idle'))
    await Promise.resolve()
    let resolve
    const action = sub.action(new Promise(r => { resolve = r }))
    f.emit(status('starting'))
    f.emit(final)
    resolve(status('starting'))
    await action
    assert.deepEqual(f.received.at(-1), final)
    sub.close()
  }
})

test('unrelated provider events leave the snapshot and action result usable', async () => {
  const f = setup(), sub = f.mount()
  f.emit(status('done'), 'codex')
  f.copies[0](status('starting'))
  await Promise.resolve()
  await sub.action(Promise.resolve(status('error')))
  assert.deepEqual(f.received.map(s => s.phase), ['starting', 'error'])
  sub.close()
})
