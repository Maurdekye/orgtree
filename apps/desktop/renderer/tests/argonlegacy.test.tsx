// USER 2026-11-19 me5cc210883ca: Argon always legacy, Carbon legacy when Neon is offered.
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

test('Carbon is hidden from shared hire choices while Neon is offered and legacy is off', (t) => {
  fresh(t)
  offered('carbon', 'neon')
  const h = hire('carbon', 'neon')
  assert.equal(optInLegacyHidden('carbon'), true)
  assert.equal(antigravityTierOffer(h, 'carbon'), 'hide')
  assert.equal(hireTierChoices({ antigravityHire: h }).some(c => c.tier === 'carbon'), false)
  assert.equal(antigravityTierOffer(h, 'neon'), 'offer')
})

test('Carbon is offered and marked legacy with Neon offered and the checkbox on', (t) => {
  fresh(t)
  offered('carbon', 'neon')
  setShowLegacyModelsOn(true)
  assert.equal(antigravityTierOffer(hire('carbon', 'neon'), 'carbon'), 'offer')
  assert.equal(legacyMark('carbon'), ' · legacy')
  assert.equal(antigravityTierOffer(hire('neon'), 'carbon'), 'hide', 'Carbon still needs its own offer')
})

test('Carbon stays current while Neon is absent', (t) => {
  fresh(t)
  offered('argon', 'carbon')
  assert.equal(antigravityTierOffer(hire('argon', 'carbon'), 'carbon'), 'offer')
  assert.equal(legacyMark('carbon'), '')
})

test('Argon is hidden with the checkbox off whether or not Carbon is offered', (t) => {
  fresh(t)
  for (const tiers of [['argon'], ['argon', 'carbon']]) {
    offered(...tiers)
    assert.equal(optInLegacyHidden('argon'), true)
    assert.equal(antigravityTierOffer(hire(...tiers), 'argon'), 'hide')
  }
})

test('Argon is offered and marked legacy when the checkbox is on, even without Carbon', (t) => {
  fresh(t)
  offered('argon')
  setShowLegacyModelsOn(true)
  assert.equal(antigravityTierOffer(hire('argon'), 'argon'), 'offer')
  assert.equal(legacyMark('argon'), ' · legacy')
})

test('Neon membership flips re-render a legacy subscriber with the checkbox unchanged', async (t) => {
  fresh(t)
  offered('carbon')
  let renders = 0
  function Probe() {
    const on = useShowLegacyModels()
    renders++
    return <span>{String(on)}:{String(optInLegacyHidden('carbon'))}</span>
  }
  const v = await mountView(<Probe />, el => el.textContent)
  t.after(() => v.unmount())
  const before = renders
  await inAct(() => { offered('carbon', 'neon') })
  assert.equal(showLegacyModelsOn(), false)
  assert.ok(renders > before, 'Neon membership must notify legacy subscribers')
  assert.equal(v.last(), 'false:true')
  const withNeon = renders
  await inAct(() => { offered('carbon') })
  assert.ok(renders > withNeon)
  assert.equal(v.last(), 'false:false')
  const withoutNeon = renders
  await inAct(() => { offered('carbon', 'krypton') })
  assert.equal(renders, withoutNeon, 'unrelated conditional tiers should not notify legacy subscribers')
})

test('the legacy toggle always names Argon and names Carbon only while Neon is offered', async (t) => {
  fresh(t)
  offered('argon', 'carbon')
  const v = await mountView(<AccountsPanel toast={noop} close={noop} />, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(10) })
  const label = () => [...v.el.querySelectorAll('label')]
    .find(el => el.textContent?.includes('Show legacy models'))?.textContent ?? ''
  assert.match(label(), /Show legacy models \(Gemini Pro, Gemini Flash, Gemini Argon\)/)
  assert.doesNotMatch(label(), /Gemini Carbon/)
  await inAct(() => { offered('argon', 'carbon', 'neon') })
  assert.match(label(), /Show legacy models \(Gemini Pro, Gemini Flash, Gemini Argon, Gemini Carbon\)/)
  await inAct(() => { offered('argon', 'carbon') })
  assert.doesNotMatch(label(), /Gemini Carbon/)
})
