// hireaccount.test.tsx: the account a hire names by itself.
//
// USER RULING 2026-11-14 08:44:53Z, "Pre-select an account": the hire form
// fills in a signed-in account, visibly, and the user can change it. The
// order (coordinator, the same day): the organization's default account if it
// can run the model; otherwise the one with the most room among the engine's
// own sign-in and the accounts that can run it, ranked together (a reset that
// is soon first, then lower usage, never one at 100% for that model; unknown
// usage after every known one). A hire never falls through to a default
// account that cannot run the model.
//
// The engine ranks (`by_room`); these tests give its answer and read what the
// hire is told to name. `undefined` means "name nothing": the hire then lands
// on the default account or, with none, on the engine's own sign-in.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs hireaccount

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { hireAccount } from '../src/canvas/hireaccount'
import { prefetchStaffingOptions, resetStaffingOptionsForTests } from '../src/canvas/staffingoptions'

type Row = { value: string; kind?: 'subscription' | 'apikey'; ambient?: boolean }
type Tier = { tier: string; provider: string; default_ok: boolean; native_ok?: boolean; by_room?: string[]; accounts: Row[] }
const OWN = 'claude/primary'

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

test('the default account first, when it can run the model', async (t) => {
  await staffing(t, [
    { tier: 'opus', provider: 'claude', default_ok: true, native_ok: true, by_room: ['claude-5', OWN, 'claude-2'],
      accounts: [{ value: 'claude-5' }, { value: 'claude-2' }, { value: 'claude-key', kind: 'apikey' }] },
  ])
  // a plain hire lands on the default account, so nothing has to be named, although another has more room
  assert.equal(hireAccount('acme', 'opus', 'claude-2'), undefined)
  // a metered key that the user made the default is the default all the same
  assert.equal(hireAccount('acme', 'opus', 'claude-key'), undefined)
})

test('the default account cannot run the model: the hire names another and never falls through to it', async (t) => {
  await staffing(t, [
    // claude-9 is the default and is left out by the engine (signed out, or a window opus spends is at 100%)
    { tier: 'opus', provider: 'claude', default_ok: true, native_ok: true, by_room: ['claude-5', OWN], accounts: [{ value: 'claude-5' }] },
    // only the engine's own sign-in can run it
    { tier: 'fable', provider: 'claude', default_ok: true, native_ok: true, by_room: [OWN], accounts: [] },
    // nothing can
    { tier: 'haiku', provider: 'claude', default_ok: false, native_ok: false, by_room: [], accounts: [{ value: 'claude-key', kind: 'apikey' }] },
  ])
  // ineligible default + an eligible registered account: that account, by name
  assert.equal(hireAccount('acme', 'opus', 'claude-9'), 'claude-5')
  // ineligible default + the own sign-in only: the own sign-in BY NAME, or the hire would land on claude-9
  assert.equal(hireAccount('acme', 'fable', 'claude-9'), OWN)
  // only a metered key is left: it is never picked for the user
  assert.equal(hireAccount('acme', 'haiku', 'claude-9'), undefined)
})

test('no default account: the most room among the own sign-in and the accounts, ranked together', async (t) => {
  await staffing(t, [
    // an account has more room than the own sign-in
    { tier: 'opus', provider: 'claude', default_ok: true, native_ok: true, by_room: ['claude-5', OWN, 'claude-2'], accounts: [{ value: 'claude-2' }, { value: 'claude-5' }] },
    // the own sign-in has the most: a plain hire lands there, nothing to name
    { tier: 'sonnet', provider: 'claude', default_ok: true, native_ok: true, by_room: [OWN, 'claude-5'], accounts: [{ value: 'claude-5' }] },
    // the own sign-in was never read: unknown usage is never spare, so it is after the account that was
    { tier: 'fable', provider: 'claude', default_ok: true, native_ok: true, by_room: ['claude-2', OWN], accounts: [{ value: 'claude-2' }] },
    // a window haiku spends is at 100% on claude-2 and on the own sign-in: the engine lists neither
    { tier: 'haiku', provider: 'claude', default_ok: true, native_ok: false, by_room: ['claude-5'], accounts: [{ value: 'claude-5' }] },
    // a headless engine: nothing on its own sign-in, two account folders and a key
    { tier: 'sol', provider: 'openai', default_ok: false, native_ok: false, by_room: ['openai-2', 'openai-1'],
      accounts: [{ value: 'openai-1' }, { value: 'openai-2' }, { value: 'openai-key', kind: 'apikey' }] },
  ])
  assert.equal(hireAccount('acme', 'opus', null), 'claude-5')
  assert.equal(hireAccount('acme', 'sonnet', null), undefined)
  assert.equal(hireAccount('acme', 'fable', undefined), 'claude-2')
  assert.equal(hireAccount('acme', 'haiku', null), 'claude-5')
  assert.equal(hireAccount('acme', 'sol', null), 'openai-2')
  // "primary" as the default is the own sign-in under another name, not an account
  for (const own of ['primary', 'default', OWN, '']) assert.equal(hireAccount('acme', 'sonnet', own), undefined, own)
  assert.equal(hireAccount('acme', 'opus', 'primary'), 'claude-5')
})

test('an engine from before the ranking: the own sign-in when it can run the model, else the first account, never a key', async (t) => {
  await staffing(t, [
    { tier: 'opus', provider: 'claude', default_ok: false, accounts: [{ value: 'claude-key', kind: 'apikey' }, { value: 'claude-5' }, { value: 'claude-2' }] },
    { tier: 'sonnet', provider: 'claude', default_ok: true, accounts: [{ value: 'claude-5' }] },
    { tier: 'haiku', provider: 'claude', default_ok: false, accounts: [{ value: 'claude-key', kind: 'apikey' }] },
  ])
  assert.equal(hireAccount('acme', 'opus', null), 'claude-5')
  assert.equal(hireAccount('acme', 'sonnet', null), undefined, 'as a hire went before')
  assert.equal(hireAccount('acme', 'haiku', null), undefined)
  // the default account cannot run it: the own sign-in is named even there
  assert.equal(hireAccount('acme', 'sonnet', 'claude-9'), OWN)
  assert.equal(hireAccount('acme', 'opus', 'claude-9'), 'claude-5')
})

test('nothing is named when the answer is not there', async (t) => {
  await staffing(t, [{ tier: 'opus', provider: 'claude', default_ok: true, native_ok: true, by_room: [OWN], accounts: [] }])
  // a model the answer does not list, and an organization with no answer yet: the engine decides at the door
  assert.equal(hireAccount('acme', 'luna', 'claude-9'), undefined)
  assert.equal(hireAccount('other', 'opus', null), undefined)
})
