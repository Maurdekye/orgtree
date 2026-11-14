// hirespent.test.tsx: a hire tile is greyed when every signed-in account is at its limit.
//
// COORDINATOR'S RULING 2026-11-14 on "nothing usable" (the hiring fix of the
// 4.6.0-alpha.1 test): the tile is greyed when NO candidate can take the hire:
// the eligible default account, the engine's own sign-in and the registered
// accounts are all signed out or known to be at 100% in a window the model
// spends. Usage nobody has read counts as usable. In the all-spent case the
// hire does not fall through to a default account that cannot run the model:
// the tile is greyed and says why.
//
// The engine names those tiers (`spent` of the staffing answer, 4.6.0 on). An
// engine from before it keeps such a tier in its answer with nothing that can
// run it, when its own sign-in is the one at its limit.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs hirespent

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { hireTierChoices, hireTierDisabledReason, hireTierOffer, type HireState } from '../src/canvas/shared'
import { invalidateStaffingOptions, prefetchStaffingOptions, resetStaffingOptionsForTests, spentHireTiers } from '../src/canvas/staffingoptions'

type Row = { value: string; kind?: 'subscription' | 'apikey'; ambient?: boolean }
type Tier = { tier: string; provider: string; default_ok: boolean; native_ok?: boolean; by_room?: string[]; accounts: Row[] }

/** the organization's warm staffing answer, as the engine gives it */
function staffing(t: { after: (fn: () => void) => void }, tiers: Tier[], more: Record<string, unknown> = {}) {
  const old = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    tiers: tiers.map((tier) => ({ seat: 10, efforts: ['low', 'high'], ...tier,
      accounts: tier.accounts.map((a) => ({ kind: 'subscription', ambient: false, ...a, id: a.value, provider: tier.provider })) })),
    at: 1, stale: false, errors: [], loading: false, generation: 1, ...more,
  }), { headers: { 'Content-Type': 'application/json' } })
  t.after(() => { globalThis.fetch = old; resetStaffingOptionsForTests() })
  return prefetchStaffingOptions('acme')
}

/** Claude as the providers answer has it while something of it is signed in */
const signedIn: HireState = { enabled: true, installed: true, reason: null, userEnabled: true, offeredTiers: ['opus', 'sonnet', 'haiku'] }
const LIMIT = /^Every signed-in account is at its limit for /

test('every signed-in account is at its limit for the model: the tile is greyed and says so', async (t) => {
  await staffing(t, [
    // the own sign-in is at 100% for opus, the default account is signed out, no other account: the engine keeps
    // the row (its own sign-in is signed in) with nothing in it that can run the model
    { tier: 'opus', provider: 'claude', default_ok: true, native_ok: false, by_room: [], accounts: [] },
    { tier: 'sonnet', provider: 'claude', default_ok: true, native_ok: true, by_room: ['claude/primary'], accounts: [] },
    // haiku is not in the answer at all: the own sign-in is signed out and every account folder is at 100%
  ], { spent: ['opus', 'haiku'] })
  assert.deepEqual(spentHireTiers(), ['opus', 'haiku'])
  assert.equal(hireTierOffer('claude', signedIn, 'opus'), 'disable')
  assert.equal(hireTierOffer('claude', signedIn, 'haiku'), 'disable')
  assert.equal(hireTierOffer('claude', signedIn, 'sonnet'), 'offer')
  assert.match(hireTierDisabledReason('opus', signedIn, 'Claude'), LIMIT)
  assert.equal(hireTierDisabledReason('opus', signedIn, 'Claude'), 'Every signed-in account is at its limit for Opus.')
  // the menus and the form's model chooser read the same verdict and the same sentence
  const choices = hireTierChoices({ claudeHire: signedIn })
  assert.equal(choices.find((c) => c.tier === 'opus')?.offer, 'disable')
  assert.match(choices.find((c) => c.tier === 'opus')?.reason ?? '', LIMIT)
  assert.equal(choices.find((c) => c.tier === 'sonnet')?.offer, 'offer')
})

test('usage nobody has read is usable, and a signed-out provider keeps its own sentence', async (t) => {
  await staffing(t, [
    // an engine that reports no usage (4.5.11): its signed-in account folders are offered
    { tier: 'opus', provider: 'claude', default_ok: false, native_ok: false, by_room: ['claude-2'], accounts: [{ value: 'claude-2' }] },
    // only a metered key can run it: the tile stays, the user may name the key in the form
    { tier: 'haiku', provider: 'claude', default_ok: false, native_ok: false, by_room: [], accounts: [{ value: 'claude-key', kind: 'apikey' }] },
  ], { spent: [] })
  assert.deepEqual(spentHireTiers(), [])
  assert.equal(hireTierOffer('claude', signedIn, 'opus'), 'offer')
  assert.equal(hireTierOffer('claude', signedIn, 'haiku'), 'offer')
  // not signed in at all is said as before, whatever the list holds
  const signedOut: HireState = { ...signedIn, enabled: false, signedOut: true }
  assert.equal(hireTierOffer('claude', signedOut, 'opus'), 'disable')
  assert.match(hireTierDisabledReason('opus', signedOut, 'Claude'), /isn't signed in/)
})

test('an engine from before the list: a row with nothing that can run the model is the same case', async (t) => {
  await staffing(t, [
    { tier: 'opus', provider: 'claude', default_ok: true, native_ok: false, by_room: [], accounts: [] },
    // the row that stands for the own sign-in is not an account that could take it
    { tier: 'haiku', provider: 'claude', default_ok: true, native_ok: false, accounts: [{ value: 'primary', ambient: true }] },
    { tier: 'sonnet', provider: 'claude', default_ok: true, native_ok: false, by_room: ['claude-5'], accounts: [{ value: 'claude-5' }] },
    // an older engine still: it does not say whether its own sign-in is at a limit, so nothing is concluded
    { tier: 'fable', provider: 'claude', default_ok: true, accounts: [] },
  ])
  assert.deepEqual(spentHireTiers(), ['opus', 'haiku'])
  assert.equal(hireTierOffer('claude', signedIn, 'opus'), 'disable')
  assert.equal(hireTierOffer('claude', signedIn, 'sonnet'), 'offer')
  assert.equal(hireTierOffer('claude', signedIn, 'fable'), 'offer')
})

test('nothing is greyed before an answer, while the engine still checks sign-ins, or after another organization opens', async (t) => {
  assert.deepEqual(spentHireTiers(), [])
  assert.equal(hireTierOffer('claude', signedIn, 'opus'), 'offer')
  await staffing(t, [], { spent: ['opus'], loading: true })
  assert.deepEqual(spentHireTiers(), [], 'an answer given while sign-ins are being checked concludes nothing')
  await staffing(t, [], { spent: ['opus'] })
  resetStaffingOptionsForTests()
  await staffing(t, [], { spent: ['opus'] })
  assert.equal(hireTierOffer('claude', signedIn, 'opus'), 'disable')
  // availability moved for this organization: the list stays until the next answer replaces it
  invalidateStaffingOptions('acme')
  assert.deepEqual(spentHireTiers(), ['opus'])
  // another organization opens: everything held is dropped
  invalidateStaffingOptions()
  assert.deepEqual(spentHireTiers(), [])
  assert.equal(hireTierOffer('claude', signedIn, 'opus'), 'offer')
})
