// musehire.test.tsx — a Muse seat's model and levels are the login it runs
// on (independent review 2026-10-13, round 2): what the hire and settings
// surfaces offer comes from each login's own catalog in `/api/providers` ›
// `muse.logins`, never from the user's own login standing in for another,
// and a hire that names no account names an eligible subscription login when
// the one it would land on cannot run the model.
//
// Each claim has its control: the same lookup on the login that DOES offer
// the model (or the unpinned model), so a helper that answers "no" to
// everything cannot pass.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs musehire

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { hireOf, museEffortLevels, museLoginKey, museOffersOn, museTierOffer, museUnofferedWhy, setMuseProvider } from '../src/canvas/shared'
import { museHireAccount, museLandingAccount } from '../src/canvas/musehire'
import { prefetchStaffingOptions, resetStaffingOptionsForTests } from '../src/canvas/staffingoptions'
import type { MuseLoginDoc, ProviderInfo } from '../src/types'

const ALL = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const UPTO_XHIGH = ALL.slice(0, 5)
const row = (model: string, efforts = ALL) => ({ model, efforts, default_effort: 'high' })

/** the user's own login: Wonder and Spark (1.3 latest, 1.2 through xhigh), no Full */
const OWN: MuseLoginDoc = { account: null, kind: 'subscription', state: 'ready', tiers: {
  wonder: { latest: row('muse-wonder-1.0'), versions: {} },
  spark: { latest: row('muse-spark-1.3'), versions: { '1.3': row('muse-spark-1.3'), '1.2': row('muse-spark-1.2', UPTO_XHIGH) } },
} }
/** a profile offering Full, and Wonder through high only */
const PF: MuseLoginDoc = { account: 'muse-2', kind: 'subscription', state: 'ready', tiers: {
  'wonder-full': { latest: row('muse-wonder-full-1.0'), versions: {} },
  wonder: { latest: row('muse-wonder-1.0', ['low', 'medium', 'high']), versions: {} },
} }
/** a key offering Full (metered: never picked for the user) */
const KF: MuseLoginDoc = { account: 'muse-key', kind: 'apikey', state: 'ready', tiers: {
  'wonder-full': { latest: row('muse-wonder-full-1.0'), versions: {} },
} }
const SIGNED_OUT: MuseLoginDoc = { account: 'muse-3', kind: 'subscription', state: 'signed_out', tiers: {} }
const UNKNOWN: MuseLoginDoc = { account: 'muse-4', kind: 'subscription', state: 'unknown', reason: 'rig: unreadable', tiers: {} }

const provider = (logins: MuseLoginDoc[], tiers: string[]): ProviderInfo => ({
  id: 'muse', label: 'Muse', cli: 'muse', hire_enabled: true, reason: null,
  status: { installed: true, connected: true },
  tiers: tiers.map((tier) => ({ tier, provider: 'muse', seat: 4, model: tier, letter: 'W' })),
  muse: { logins },
})

/** the org's warm staffing answer: Full on the key first, then the profile */
function staffing(t: { after: (fn: () => void) => void }, accounts: { value: string; kind: string }[]) {
  const old = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    tiers: [{ tier: 'wonder-full', seat: 10, provider: 'muse', efforts: ALL, default_ok: false,
              accounts: accounts.map((a) => ({ ...a, id: a.value, provider: 'muse', ambient: false })) }],
    at: 1, stale: false, errors: [], loading: false, generation: 1,
  }), { headers: { 'Content-Type': 'application/json' } })
  t.after(() => { globalThis.fetch = old; resetStaffingOptionsForTests() })
  return prefetchStaffingOptions('acme')
}

test('the login a seat lands on: the provider\'s own login under every alias, else the account', () => {
  for (const own of ['', 'primary', 'default', 'muse/primary', null, undefined]) assert.equal(museLoginKey(own), null, String(own))
  assert.equal(museLoginKey('muse-2'), 'muse-2')
})

test('a model is offered where that login\'s own catalog lists it, never by another login', () => {
  setMuseProvider(provider([OWN, PF, KF, SIGNED_OUT, UNKNOWN], ['wonder', 'wonder-full', 'spark']))
  assert.equal(museOffersOn('wonder-full', null, null), false, 'the own login lacks Full')
  assert.equal(museOffersOn('wonder-full', null, 'muse-2'), true, 'control: the profile lists it')
  assert.equal(museOffersOn('wonder-full', null, 'muse-key'), true)
  assert.equal(museOffersOn('spark', null, 'muse-2'), false, 'the profile lacks Spark')
  assert.equal(museOffersOn('wonder', null, 'muse-3'), false, 'a signed-out login offers nothing')
  assert.equal(museOffersOn('wonder', null, 'muse-4'), undefined, 'an unreadable login is unknown, not "no"')
  assert.equal(museOffersOn('wonder', null, 'muse-9'), undefined, 'a login the payload does not describe is unknown')
  assert.equal(museUnofferedWhy('wonder-full', null, 'muse/primary'), 'the signed-in Muse login does not offer wonder-full')
  assert.equal(museUnofferedWhy('wonder', null, 'muse-3'), 'the Muse account muse-3 is signed out')
  assert.equal(museUnofferedWhy('wonder', null, 'muse-4'), null, 'unknown: the engine decides at the door')
  assert.equal(museUnofferedWhy('wonder-full', null, 'muse-2'), null, 'control')
})

test('levels are the exact model\'s row on that login: the pin\'s, and the profile\'s own', () => {
  setMuseProvider(provider([OWN, PF], ['wonder', 'wonder-full', 'spark']))
  assert.deepEqual(museEffortLevels('spark', '1.2', null), UPTO_XHIGH, 'Spark 1.2 stops at xhigh')
  assert.deepEqual(museEffortLevels('spark', null, null), ALL, 'control: unpinned Spark (1.3) takes max')
  assert.deepEqual(museEffortLevels('wonder', null, 'muse-2'), ['low', 'medium', 'high'], 'the profile\'s Wonder row')
  assert.deepEqual(museEffortLevels('wonder', null, ''), ALL, 'control: the own login\'s Wonder row')
  assert.equal(museEffortLevels('wonder-full', null, null), undefined, 'not offered there: no levels claimed')
})

test('the hire strips offer a model a registered login offers though the own login lacks it', () => {
  const p = provider([OWN, PF], ['wonder', 'wonder-full', 'spark'])
  assert.equal(museTierOffer(hireOf(p), 'wonder-full'), 'offer')
  assert.equal(museTierOffer(hireOf(provider([OWN], ['wonder', 'spark'])), 'wonder-full'), 'hide', 'control: no login offers it')
})

test('a no-account hire names the first eligible subscription login that offers the model', async t => {
  setMuseProvider(provider([OWN, PF, KF], ['wonder', 'wonder-full', 'spark']))
  await staffing(t, [{ value: 'muse-key', kind: 'apikey' }, { value: 'muse-2', kind: 'subscription' }])
  assert.equal(museHireAccount('acme', 'wonder-full', null), 'muse-2', 'the profile, never the key listed first')
  assert.equal(museHireAccount('acme', 'wonder', null), undefined, 'control: the own login offers Wonder, name none')
  assert.equal(museHireAccount('acme', 'sonnet', null), undefined, 'not a Muse tier')
  assert.equal(museLandingAccount('muse-2'), 'muse-2', 'an org default Muse login is where a no-account hire lands')
  assert.equal(museLandingAccount('claude-2'), null, 'another provider\'s default does not apply')
  assert.equal(museHireAccount('acme', 'wonder-full', 'muse-2'), undefined, 'the org default offers Full: name none')
})

test('only a metered key offers the model: nothing is picked for the user', async t => {
  setMuseProvider(provider([OWN, KF], ['wonder', 'wonder-full', 'spark']))
  await staffing(t, [{ value: 'muse-key', kind: 'apikey' }])
  assert.equal(museHireAccount('acme', 'wonder-full', null), undefined)
})

test('the own login\'s catalog unknown: nothing is named, the engine decides', async t => {
  setMuseProvider(provider([{ ...OWN, state: 'unknown', tiers: {} }, PF], ['wonder-full']))
  await staffing(t, [{ value: 'muse-2', kind: 'subscription' }])
  assert.equal(museHireAccount('acme', 'wonder-full', null), undefined)
})
