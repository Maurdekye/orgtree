// Argon is opt-in legacy only while the providers payload offers Carbon.
// USER 2026-11-17 m32a4af643c1c; coordinator snapshot decision m16095bd84384.
// From renderer/: node tests/run.mjs argonlegacy.test
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  antigravityTierOffer, hireTierChoices, legacyMark, optInLegacyHidden,
  setOfferedConditionalTiers, setShowLegacyModelsOn, showLegacyModelsOn,
  useShowLegacyModels,
} from '../src/canvas/shared'
import type { HireState } from '../src/canvas/shared'
import { AccountsPanel } from '../src/canvas/accounts'

const noop = () => {}
const hire = (...offeredTiers: string[]): HireState => ({
  enabled: true, installed: true, reason: null, offeredTiers,
})
const offered = (...tiers: string[]) => setOfferedConditionalTiers(tiers.map(tier => ({ tier })))

function fresh(t: TestContext) {
  localStorage.clear()
  installFetch(new FakeServer())
  setShowLegacyModelsOn(false)
  offered()
  t.after(() => { offered(); setShowLegacyModelsOn(false); localStorage.clear() })
}

test('Carbon and Argon offered, legacy off: Argon is hidden from the shared hire choices', (t) => {
  fresh(t)
  offered('carbon', 'argon')
  const h = hire('carbon', 'argon')
  assert.equal(optInLegacyHidden('argon'), true)
  assert.equal(antigravityTierOffer(h, 'argon'), 'hide')
  assert.equal(hireTierChoices({ antigravityHire: h }).some(c => c.tier === 'argon'), false)
  assert.equal(antigravityTierOffer(h, 'carbon'), 'offer', 'the successor stays current')
})

test('Carbon and Argon offered, legacy on: Argon is offered and marked legacy', (t) => {
  fresh(t)
  offered('carbon', 'argon')
  setShowLegacyModelsOn(true)
  assert.equal(antigravityTierOffer(hire('carbon', 'argon'), 'argon'), 'offer')
  assert.equal(legacyMark('argon'), ' · legacy')
  assert.equal(legacyMark('carbon'), '')
  assert.equal(antigravityTierOffer(hire('carbon'), 'argon'), 'hide', 'Argon still needs its own offer')
})

test('Argon offered without Carbon: Argon stays current with the checkbox off', (t) => {
  fresh(t)
  offered('argon')
  const h = hire('argon')
  assert.equal(optInLegacyHidden('argon'), false)
  assert.equal(antigravityTierOffer(h, 'argon'), 'offer')
  assert.equal(hireTierChoices({ antigravityHire: h }).some(c => c.tier === 'argon'), true)
  assert.equal(legacyMark('argon'), '')
})

test('Carbon membership flips re-render a legacy subscriber with the checkbox unchanged', async (t) => {
  fresh(t)
  offered('argon')
  let renders = 0
  function Probe() {
    const on = useShowLegacyModels()
    renders++
    return <span>{String(on)}:{String(optInLegacyHidden('argon'))}</span>
  }
  const v = await mountView(<Probe />, el => el.textContent)
  t.after(() => v.unmount())
  const before = renders
  await inAct(() => { offered('argon', 'carbon') })
  assert.equal(showLegacyModelsOn(), false)
  assert.ok(renders > before, 'the unchanged checkbox snapshot suppressed the Carbon render')
  assert.equal(v.last(), 'false:true')
  const withCarbon = renders
  await inAct(() => { offered('argon') })
  assert.ok(renders > withCarbon, 'losing Carbon did not re-render the subscriber')
  assert.equal(v.last(), 'false:false')
  const withoutCarbon = renders
  await inAct(() => { offered('argon', 'krypton') })
  assert.equal(renders, withoutCarbon, 'unrelated conditional tiers should not notify legacy subscribers')
})

test('the mounted legacy toggle names Gemini Argon only while Carbon is offered', async (t) => {
  fresh(t)
  offered('argon')
  const v = await mountView(<AccountsPanel toast={noop} close={noop} />, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(10) })
  const label = () => [...v.el.querySelectorAll('label')]
    .find(el => el.textContent?.includes('Show legacy models'))?.textContent ?? ''
  assert.match(label(), /Show legacy models \(Gemini Pro, Gemini Flash\)/)
  assert.doesNotMatch(label(), /Gemini Argon/)
  await inAct(() => { offered('argon', 'carbon') })
  assert.match(label(), /Show legacy models \(Gemini Pro, Gemini Flash, Gemini Argon\)/)
  await inAct(() => { offered('argon') })
  assert.doesNotMatch(label(), /Gemini Argon/)
})
