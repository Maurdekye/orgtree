// hireaccount.test.tsx: the account a hire names by itself.
//
// USER RULING 2026-11-14 08:44:53Z, "Pre-select an account": the hire form
// fills in a signed-in account, visibly, and the user can change it. Which:
// the organization's default account if it can run the model; otherwise the
// signed-in account with the most room, in the order the engine lists them
// (sooner reset first, then lower usage, never one at its limit; an account
// whose usage is not known is never ahead of one that is). A hire that
// named no account landed on a login that was signed out, and its first turn
// failed.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs hireaccount

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { hireAccount } from '../src/canvas/hireaccount'
import { prefetchStaffingOptions, resetStaffingOptionsForTests } from '../src/canvas/staffingoptions'

type Row = { value: string; kind?: 'subscription' | 'apikey'; ambient?: boolean }
type Tier = { tier: string; provider: string; default_ok: boolean; native_ok?: boolean; accounts: Row[] }

/** the organization's warm staffing answer, as the engine gives it */
function staffing(t: { after: (fn: () => void) => void }, tiers: Tier[]) {
  const old = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    tiers: tiers.map((tier) => ({ seat: 10, efforts: ['low', 'high'], ...tier,
      accounts: tier.accounts.map((a) => ({ kind: 'subscription', ambient: false, ...a, id: a.value, provider: tier.provider })) })),
    at: 1, stale: false, errors: [], loading: false, generation: 1,
  }), { headers: { 'Content-Type': 'application/json' } })
  t.after(() => { globalThis.fetch = old; resetStaffingOptionsForTests() })
  return prefetchStaffingOptions('acme')
}

test('the engine\'s own sign-in is signed out: the hire names the first account the engine lists, never a metered key', async (t) => {
  await staffing(t, [
    // a headless engine: nothing on its own sign-in, two account folders and a key
    { tier: 'opus', provider: 'claude', default_ok: false, accounts: [{ value: 'claude-key', kind: 'apikey' }, { value: 'claude-5' }, { value: 'claude-2' }] },
    { tier: 'sol', provider: 'openai', default_ok: false, accounts: [{ value: 'openai-1' }] },
    // only a key can run it: nothing is picked for the user
    { tier: 'haiku', provider: 'claude', default_ok: false, accounts: [{ value: 'claude-key', kind: 'apikey' }] },
  ])
  // the engine's order is the order of room; the key is passed over
  assert.equal(hireAccount('acme', 'opus', null), 'claude-5')
  assert.equal(hireAccount('acme', 'sol', undefined), 'openai-1')
  assert.equal(hireAccount('acme', 'haiku', null), undefined, 'a metered key is chosen by the user, never for them')
})

test('the organization\'s default account comes first when it can run the model', async (t) => {
  await staffing(t, [
    { tier: 'opus', provider: 'claude', default_ok: false, accounts: [{ value: 'claude-5' }, { value: 'claude-2' }] },
    { tier: 'sol', provider: 'openai', default_ok: true, native_ok: true, accounts: [{ value: 'openai-1' }] },
  ])
  assert.equal(hireAccount('acme', 'opus', 'claude-2'), 'claude-2', 'the default account, although another has more room')
  // the default account cannot run it now (signed out or at its limit: the engine left it out)
  assert.equal(hireAccount('acme', 'opus', 'claude-9'), 'claude-5')
  // a default account of another provider says nothing about this model: the own sign-in runs it
  assert.equal(hireAccount('acme', 'sol', 'claude-2'), undefined)
})

test('nothing is named when the login a plain hire lands on can run the model, or when that is not known', async (t) => {
  // control for the first test: the same accounts with the own sign-in working
  await staffing(t, [
    { tier: 'opus', provider: 'claude', default_ok: true, native_ok: true, accounts: [{ value: 'claude-5' }] },
    // the own sign-in is signed in but at its limit: an account with room is named
    { tier: 'fable', provider: 'claude', default_ok: true, native_ok: false, accounts: [{ value: 'claude-5' }] },
    // an engine from before `native_ok`: `default_ok` is what there is
    { tier: 'sonnet', provider: 'claude', default_ok: true, accounts: [{ value: 'claude-5' }] },
    // nobody can run it but the own sign-in
    { tier: 'sol', provider: 'openai', default_ok: true, native_ok: true, accounts: [] },
  ])
  assert.equal(hireAccount('acme', 'opus', null), undefined)
  assert.equal(hireAccount('acme', 'fable', null), 'claude-5')
  assert.equal(hireAccount('acme', 'sonnet', null), undefined)
  assert.equal(hireAccount('acme', 'sol', null), undefined)
  // a model the answer does not list, and an organization with no answer yet: the engine decides at the door
  assert.equal(hireAccount('acme', 'luna', null), undefined)
  assert.equal(hireAccount('other', 'opus', null), undefined)
})
