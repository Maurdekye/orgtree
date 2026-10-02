import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { TurnLimitsSetting, splitLimit, limitSeconds } from '../src/canvas/turnlimitssetting'

const W = window as unknown as Window & typeof globalThis

test('seconds split into a readable amount and back', () => {
  assert.deepEqual(splitLimit(86400), { off: false, amount: '24', unit: 'hours' })
  assert.deepEqual(splitLimit(600), { off: false, amount: '10', unit: 'minutes' })
  assert.equal(splitLimit(0).off, true)
  assert.equal(limitSeconds('24', 'hours'), 86400)
  assert.equal(limitSeconds('10', 'minutes'), 600)
  for (const bad of ['', '0', '-3', 'abc']) assert.equal(limitSeconds(bad, 'hours'), null)
  assert.equal(limitSeconds('9000', 'hours'), null)
})

test('shows stored values, writes the exact keys, and off sends 0', async t => {
  const old = globalThis.fetch
  let stored: Record<string, unknown> = { turn_timeout_s: 86400, turn_idle_s: 600 }
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_url, init) => {
    if (init?.body) { const b = JSON.parse(String(init.body)) as Record<string, unknown>
      bodies.push(b); stored = { ...stored, ...b } }
    return new Response(JSON.stringify(stored))
  }
  t.after(() => { globalThis.fetch = old })
  const v = await mountView(<TurnLimitsSetting />, h => h); t.after(() => v.unmount()); await flush()
  const q = <T extends Element>(l: string) => document.querySelector<T>(`[aria-label="${l}"]`)!
  assert.equal(q<HTMLInputElement>('Total limit amount').value, '24')
  assert.equal(q<HTMLSelectElement>('Total limit unit').value, 'hours')
  assert.equal(q<HTMLInputElement>('Silence limit amount').value, '10')
  assert.equal(q<HTMLSelectElement>('Silence limit unit').value, 'minutes')

  await inAct(() => { q<HTMLInputElement>('Silence limit off').click() }); await flush()
  assert.deepEqual(bodies.at(-1), { turn_idle_s: 0 })
  assert.equal(q<HTMLInputElement>('Silence limit amount').disabled, true)

  await inAct(() => { q<HTMLInputElement>('Total limit off').click() }); await flush()
  assert.deepEqual(bodies.at(-1), { turn_timeout_s: 0 })

  await inAct(() => { q<HTMLInputElement>('Total limit off').click() }); await flush()
  assert.deepEqual(bodies.at(-1), { turn_timeout_s: 86400 })

  const amount = q<HTMLInputElement>('Total limit amount')
  await inAct(() => {
    const set = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, 'value')!.set!
    set.call(amount, '2'); amount.dispatchEvent(new W.Event('input', { bubbles: true }))
    amount.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }); await flush()
  assert.deepEqual(bodies.at(-1), { turn_timeout_s: 7200 })
})

test('an invalid amount sends nothing', async t => {
  const old = globalThis.fetch
  const bodies: unknown[] = []
  globalThis.fetch = async (_url, init) => {
    if (init?.body) bodies.push(init.body)
    return new Response(JSON.stringify({ turn_timeout_s: 86400, turn_idle_s: 600 }))
  }
  t.after(() => { globalThis.fetch = old })
  const v = await mountView(<TurnLimitsSetting />, h => h); t.after(() => v.unmount()); await flush()
  const amount = document.querySelector<HTMLInputElement>('[aria-label="Total limit amount"]')!
  await inAct(() => {
    const set = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, 'value')!.set!
    set.call(amount, '-5'); amount.dispatchEvent(new W.Event('input', { bubbles: true }))
    amount.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }); await flush()
  assert.equal(bodies.length, 0)
  assert.equal(amount.getAttribute('aria-invalid'), 'true')
})
