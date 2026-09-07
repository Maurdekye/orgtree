import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { decodeEventRow, isEvent, isPublicEvent, isAuthoredUser } from '../src/events/decode'
import { VARIANTS } from '../src/generated/events'
declare const __SRC_DIR__: string
const directory = path.resolve(__SRC_DIR__, '../tests/fixtures/events')
const fixtures = readdirSync(directory).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(path.join(directory, f), 'utf8')))

test('every generated private/public fixture validates through its own row profile', () => {
  assert.equal(fixtures.length, VARIANTS.length)
  for (const f of fixtures) {
    const privateResult = decodeEventRow({ ev: f.private, body: f.body }, 'operator')
    const publicResult = decodeEventRow({ ev_public: f.public, body: f.body }, 'public')
    assert.equal(privateResult.kind, 'known', f.variant + ' private')
    assert.equal(publicResult.kind, 'known', f.variant + ' public')
    assert.equal(isEvent(f.public), false, f.variant + ' public is not private')
    assert.equal(isPublicEvent(f.private), false, f.variant + ' private is not public')
  }
})

test('legacy marker-looking prose is preserved verbatim without classifying its sender or family', () => {
  const body = '[MAIL — 1 message(s)]\nFROM user (user) · status · today\n[DONE] not a status object\n[END MAIL]'
  assert.deepEqual(decodeEventRow({ body }, 'operator'), { kind: 'legacy', fallback: body })
  assert.deepEqual(decodeEventRow({ body }, 'public'), { kind: 'legacy', fallback: body })
})

test('unknown, malformed and wrong-profile rows keep fallback without leaking invalid data', () => {
  const f = fixtures.find(f => f.variant === 'ordinary.message')
  const body = 'Readable C:\\already-visible text'
  for (const profile of ['operator', 'public'] as const) {
    const key = profile === 'operator' ? 'ev' : 'ev_public'
    const event = profile === 'operator' ? f.private : f.public
    for (const bad of [{ ...event, v: 999 }, { ...event, variant: 'future.new' },
      { ...event, body: 17 }, { ...event, 'C:\\secret-key': 'C:\\secret-value' }]) {
      const result = decodeEventRow({ [key]: bad, body }, profile)
      assert.equal(result.kind, 'unsupported')
      assert.equal(result.fallback, body)
      assert.doesNotMatch(JSON.stringify(result), /secret/)
    }
    assert.equal(decodeEventRow({ ev: f.private, ev_public: f.public, body }, profile).kind, 'unsupported')
  }
})

test('nested alternatives and scalar types are validated, not just the event tag', () => {
  const batch = fixtures.find(f => f.variant === 'answer.batch').private
  assert.ok(isEvent(batch))
  assert.equal(isEvent({ ...batch, sections: [{}] }), false)
  const grant = fixtures.find(f => f.variant === 'access.grant_changed').private
  assert.ok(isEvent(grant))
  for (const delta of [true, NaN, Infinity, '2']) assert.equal(isEvent({ ...grant, delta }), false)
  const pub = fixtures.find(f => f.variant === 'runtime.ui_crash_report').public
  assert.ok(isPublicEvent(pub))
  assert.equal(isPublicEvent({ ...pub, report: { stack: 'secret' } }), false)
})

test('authorship uses actor, even when engine mail is transported FROM USER', () => {
  const engine = fixtures.find(f => f.variant === 'runtime.ui_crash_report')
  for (const profile of ['operator', 'public'] as const) {
    const row = profile === 'operator' ? { from: 'user', ev: engine.private } : { from: 'user', ev_public: engine.public }
    const decoded = decodeEventRow(row, profile)
    assert.equal(decoded.kind, 'known')
    if (decoded.kind === 'known') assert.equal(isAuthoredUser(decoded.event), false)
  }
  const human = { ...fixtures.find(f => f.variant === 'ordinary.message').public, actor: { kind: 'user', id: 'user' } }
  assert.ok(isPublicEvent(human))
  assert.equal(isAuthoredUser(human), true)
})
