import test from 'node:test'
import assert from 'node:assert/strict'
import { mailReadCloseGate, rendererMailReadFlushScript } from '../../main/mail-read-close'

test('native close stays open until the renderer save completes, then retries policy once', async () => {
  let finish!: () => void, closes = 0, prevents = 0, flushes = 0
  const pending = new Promise<void>(resolve => { finish = resolve })
  const gate = mailReadCloseGate(() => { flushes++; return pending }, () => { closes++ }, error => { throw error })
  const event = {preventDefault: () => { prevents++ }}
  assert.equal(gate(event), true)
  assert.equal(gate(event), true)
  await Promise.resolve(); assert.equal(flushes, 1); assert.equal(closes, 0)
  finish(); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(closes, 1); assert.equal(prevents, 2)
  assert.equal(gate(event), false, 'only the drain retry reaches existing close policy')
})

test('renderer drain failure keeps the window alive and permits retry', async () => {
  let closes = 0, errors = 0
  const gate = mailReadCloseGate(() => Promise.reject(Error('renderer gone')), () => { closes++ }, () => { errors++ })
  gate({preventDefault() {}})
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(closes, 0); assert.equal(errors, 1)
})

test('native exit script returns a promise for the exact renderer pending saves', async () => {
  let finish!: () => void, done = false
  const pending = new Promise<void>(resolve => { finish = resolve })
  const fakeWindow = {dispatchEvent(event: {detail: {waitUntil(p: Promise<unknown>): void}}) { event.detail.waitUntil(pending); return true }}
  class FakeEvent { constructor(public type: string, public detailObject: {detail: unknown}) {} get detail() { return this.detailObject.detail } }
  const run = new Function('window', 'CustomEvent', `return ${rendererMailReadFlushScript('orgtree:before-exit')}`)
  const result = run(fakeWindow, FakeEvent).then(() => { done = true })
  await Promise.resolve(); assert.equal(done, false)
  finish(); await result; assert.equal(done, true)
})
