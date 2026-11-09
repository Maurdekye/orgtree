import test from 'node:test'
import assert from 'node:assert/strict'
import { syncFastModes } from '../src/canvas/fastmode'
import { blankVersionLabel, versionScopePayload } from '../src/canvas/modelversion'

const row = (tier: string, extra: object = {}) => ({ tier, provider: 'claude', seat: 1, model: 'm', letter: 'x', ...extra })
syncFastModes([{ tiers: [row('fable', { legacy_version: '5.1' }), row('opus')] }])

test('an existing unpinned Fable seat names what blank resolves to; other tiers keep latest', () => {
  assert.equal(blankVersionLabel('fable', false), 'default (5.1)')
  assert.match(blankVersionLabel('opus', false), /^latest \(/)
})
test('a switch INTO Fable names the pin it will get', () => {
  assert.equal(blankVersionLabel('fable', true), 'latest (5.2)')
})
test('an explicit 5.2 in the gear saves model_version 5.2', () => {
  assert.deepEqual(versionScopePayload({ tier: 'fable', switching: false, edited: true, version: '5.2' }), { model_version: '5.2' })
})
test('an explicit blank on an existing Fable seat keeps meaning legacy 5.1 (clears the pin)', () => {
  assert.deepEqual(versionScopePayload({ tier: 'fable', switching: false, edited: true, version: '' }), { model_version: '' })
})
test('a switch into Fable with no version leaves it to the engine to pin 5.2', () => {
  assert.deepEqual(versionScopePayload({ tier: 'fable', switching: true, edited: false, version: '' }), {})
})
test('a switch into another tier with no version still clears a stale one', () => {
  assert.deepEqual(versionScopePayload({ tier: 'opus', switching: true, edited: false, version: '' }), { model_version: '' })
})
test('a within-Fable edit that never touched the version sends none (absent stays absent)', () => {
  assert.deepEqual(versionScopePayload({ tier: 'fable', switching: false, edited: false, version: '' }), {})
})
