import test from 'node:test'
import assert from 'node:assert/strict'
import { syncFastModes } from '../src/canvas/fastmode'
import { blankVersionLabel, versionScopePayload } from '../src/canvas/modelversion'

// LATEST OR PINNED (USER 2026-11-18 m62f2d7627923: 'all hires and all nodes start on "latest" as their model version,
// which updates dynamically ... there should be no "default" setting'). Even an older engine's tier row that still
// names a legacy version does not bring a "default (x)" back.
const row = (tier: string, extra: object = {}) => ({ tier, provider: 'claude', seat: 1, model: 'm', letter: 'x', ...extra })
syncFastModes([{ tiers: [row('fable', { legacy_version: '5.1' }), row('opus'),
  row('sol', { provider: 'openai', legacy_version: '6.1' }), row('astra', { provider: 'openai', legacy_version: '6' })] }])

test('the blank option is always latest: on a seat, on a move into a tier, on a retired seat', () => {
  assert.equal(blankVersionLabel('fable'), 'latest (5.2)')
  assert.equal(blankVersionLabel('sol'), 'latest (6.2)')
  assert.equal(blankVersionLabel('astra'), 'latest (6.2)')
  assert.match(blankVersionLabel('opus'), /^latest \(/)
})
test('an explicit version in the gear saves that pin', () => {
  assert.deepEqual(versionScopePayload({ tier: 'fable', switching: false, edited: true, version: '5.1' }), { model_version: '5.1' })
  assert.deepEqual(versionScopePayload({ tier: 'astra', switching: false, edited: true, version: '6.2' }), { model_version: '6.2' })
})
test('an explicit blank in the gear clears the pin: the seat follows the latest', () => {
  assert.deepEqual(versionScopePayload({ tier: 'astra', switching: false, edited: true, version: '' }), { model_version: '' })
})
test('a switch into any tier with no version clears a stale one: it starts on latest', () => {
  for (const tier of ['fable', 'sol', 'astra', 'opus']) {
    assert.deepEqual(versionScopePayload({ tier, switching: true, edited: false, version: '' }), { model_version: '' }, tier)
  }
})
test('an edit that never touched the version sends none (absent stays absent)', () => {
  assert.deepEqual(versionScopePayload({ tier: 'fable', switching: false, edited: false, version: '' }), {})
})
