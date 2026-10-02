import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { decodeEventRow, isEvent, isAuthoredUser } from '../src/events/decode'
import { VARIANTS } from '../src/generated/events'
declare const __SRC_DIR__: string
const directory = path.resolve(__SRC_DIR__, '../tests/fixtures/events')
const fixtures = readdirSync(directory).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(path.join(directory, f), 'utf8')))

test('every generated fixture validates through the row decoder', () => {
  assert.equal(fixtures.length, VARIANTS.length)
  for (const f of fixtures) {
    const privateResult = decodeEventRow({ ev: f.private, body: f.body }, 'operator')
    assert.equal(privateResult.kind, 'known', f.variant + ' private')
  }
})

test('legacy marker-looking prose is preserved verbatim without classifying its sender or family', () => {
  const body = '[MAIL — 1 message(s)]\nFROM user (user) · status · today\n[DONE] not a status object\n[END MAIL]'
  assert.deepEqual(decodeEventRow({ body }, 'operator'), { kind: 'legacy', fallback: body })
})

test('unknown and malformed rows keep fallback without leaking invalid data', () => {
  const f = fixtures.find(f => f.variant === 'ordinary.message')
  const body = 'Readable C:\\already-visible text'
  const event = f.private
  for (const bad of [{ ...event, v: 999 }, { ...event, variant: 'future.new' },
    { ...event, body: 17 }, { ...event, 'C:\\secret-key': 'C:\\secret-value' }]) {
    const result = decodeEventRow({ ev: bad, body }, 'operator')
    assert.equal(result.kind, 'unsupported')
    assert.equal(result.fallback, body)
    assert.doesNotMatch(JSON.stringify(result), /secret/)
  }
})

test('nested alternatives and scalar types are validated, not just the event tag', () => {
  const batch = fixtures.find(f => f.variant === 'answer.batch').private
  assert.ok(isEvent(batch))
  assert.equal(isEvent({ ...batch, sections: [{}] }), false)
  const grant = fixtures.find(f => f.variant === 'access.grant_changed').private
  assert.ok(isEvent(grant))
  for (const delta of [true, NaN, Infinity, '2']) assert.equal(isEvent({ ...grant, delta }), false)
})

test('authorship uses actor, even when engine mail is transported FROM USER', () => {
  const engine = fixtures.find(f => f.variant === 'runtime.ui_crash_report')
  const decoded = decodeEventRow({ from: 'user', ev: engine.private }, 'operator')
  assert.equal(decoded.kind, 'known')
  if (decoded.kind === 'known') assert.equal(isAuthoredUser(decoded.event), false)
  const human = { ...fixtures.find(f => f.variant === 'ordinary.message').private, actor: { kind: 'user', id: 'user' } }
  assert.ok(isEvent(human))
  assert.equal(isAuthoredUser(human), true)
})
