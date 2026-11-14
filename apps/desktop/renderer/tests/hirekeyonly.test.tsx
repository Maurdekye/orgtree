// hirekeyonly.test.tsx: only a metered API key can run the model.
//
// COORDINATOR'S RULING 2026-11-14 (m30df0e222e4d), the key-only case of the
// hiring fix: the only usable candidate is a metered API key that is not the
// organization's default; the engine's own sign-in is signed out or at its
// limit, and the default account cannot run the model.
//   - The tile stays offered: the key can run it.
//   - Nothing is picked for the user: the form's Account row reads "Choose an
//     account", and the hire is not made until the user picks the key.
//   - A quick hire does not go out directly; Quick chat, which has no form,
//     does not offer the model.
//   - The hire never goes out naming nothing, so it cannot fall through to a
//     default account that cannot run the model.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs hirekeyonly

import { flush, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { hireAccount, hireAwaitsAccount, hireNeedsChoice } from '../src/canvas/hireaccount'
import { DraftScopeModal } from '../src/canvas/modals'
import { hireTierOffer, type DraftState, type HireState } from '../src/canvas/shared'
import { prefetchStaffingOptions, resetStaffingOptionsForTests, type StaffingOptions } from '../src/canvas/staffingoptions'
import { quickChatChoices } from '../src/quickchat-availability'
import type { TreePayload } from '../src/types'

type Row = { value: string; kind?: 'subscription' | 'apikey'; ambient?: boolean }
type Tier = { tier: string; provider: string; default_ok: boolean; native_ok?: boolean; by_room?: string[]; accounts: Row[] }
const KEY: Row = { value: 'claude-key', kind: 'apikey' }
const full = (tiers: Tier[]) => ({
  tiers: tiers.map((tier) => ({ seat: 10, efforts: ['low', 'high'], ...tier,
    accounts: tier.accounts.map((a) => ({ kind: 'subscription', ambient: false, ...a, id: a.value, provider: tier.provider })) })),
  spent: [], at: 1, stale: false, errors: [], loading: false, generation: 1,
})

const realFetch = globalThis.fetch
/** the organization's warm staffing answer, as the engine gives it */
function staffing(t: { after: (fn: () => void) => void }, tiers: Tier[]) {
  globalThis.fetch = async () => new Response(JSON.stringify(full(tiers)), { headers: { 'Content-Type': 'application/json' } })
  t.after(() => { globalThis.fetch = realFetch; resetStaffingOptionsForTests() })
  return prefetchStaffingOptions('acme')
}

const ROWS: Tier[] = [
  // only the key: the own sign-in is signed out
  { tier: 'opus', provider: 'claude', default_ok: false, native_ok: false, by_room: [], accounts: [KEY] },
  // only the key: the own sign-in is signed in and at its limit for the model
  { tier: 'fable', provider: 'claude', default_ok: true, native_ok: false, by_room: [], accounts: [KEY] },
  // the key and an account folder
  { tier: 'sonnet', provider: 'claude', default_ok: false, native_ok: false, by_room: ['claude-5'], accounts: [KEY, { value: 'claude-5' }] },
  // the key and the own sign-in
  { tier: 'haiku', provider: 'claude', default_ok: true, native_ok: true, by_room: ['claude/primary'], accounts: [KEY] },
  // an OpenRouter model: its keys are its accounts, and a hire that names none is placed on one
  { tier: 'or-model', provider: 'openrouter', default_ok: true, native_ok: true, by_room: [], accounts: [{ value: 'openrouter-1', kind: 'apikey' }] },
  // an engine from before the ranking, only the key
  { tier: 'sol', provider: 'openai', default_ok: false, accounts: [{ value: 'openai-key', kind: 'apikey' }] },
]

test('only a metered key can run the model: nothing is picked, and the hire waits for the choice', async (t) => {
  await staffing(t, ROWS)
  for (const orgDefault of [null, 'claude-9', 'primary']) {
    assert.equal(hireAccount('acme', 'opus', orgDefault), undefined, 'the key is never picked for the user')
    assert.equal(hireNeedsChoice('acme', 'opus', orgDefault), true, `opus, default ${orgDefault}`)
    assert.equal(hireNeedsChoice('acme', 'fable', orgDefault), true, `fable, default ${orgDefault}`)
  }
  assert.equal(hireNeedsChoice('acme', 'sol', null), true, 'an engine from before the ranking')
  // the hire waits while no account is named, and goes once the user named the key
  assert.equal(hireAwaitsAccount('acme', 'opus', 'claude-9', undefined), true)
  assert.equal(hireAwaitsAccount('acme', 'opus', 'claude-9', ''), true)
  assert.equal(hireAwaitsAccount('acme', 'opus', 'claude-9', 'claude-key'), false)
  // the tile stays offered: the key can run it
  const signedIn: HireState = { enabled: true, installed: true, reason: null, userEnabled: true, offeredTiers: ['opus'] }
  assert.equal(hireTierOffer('claude', signedIn, 'opus'), 'offer')
})

test('what is not that case', async (t) => {
  await staffing(t, ROWS)
  // the key is the organization's default: the user chose it, a plain hire lands on it
  assert.equal(hireNeedsChoice('acme', 'opus', 'claude-key'), false)
  // something else can run it
  assert.equal(hireNeedsChoice('acme', 'sonnet', 'claude-9'), false)
  assert.equal(hireNeedsChoice('acme', 'haiku', 'claude-9'), false)
  // OpenRouter's keys are placed by the engine
  assert.equal(hireNeedsChoice('acme', 'or-model', null), false)
  // no answer, or a model it does not list: the engine decides at the door
  assert.equal(hireNeedsChoice('acme', 'luna', null), false)
  assert.equal(hireNeedsChoice('other', 'opus', null), false)
})

test('Quick chat has no form: it never puts a hire on a metered key by itself', () => {
  const tree = (default_account: string | null) => ({ slug: 'acme', roots: [], default_top_grant: 50, default_account }) as unknown as TreePayload
  const answer = full(ROWS) as unknown as StaffingOptions
  const choice = (tier: string, orgDefault: string | null) => quickChatChoices(answer, tree(orgDefault), new Map(), null).find((c) => c.row.tier === tier)
  for (const orgDefault of [null, 'claude-9']) {
    // only the key: the model is not offered there
    assert.equal(choice('opus', orgDefault), undefined, `opus, default ${orgDefault}`)
    assert.equal(choice('fable', orgDefault), undefined, `fable, default ${orgDefault}`)
    // the key is first by name and an account folder can run it: the folder, not the key
    assert.equal(choice('sonnet', orgDefault)?.account, 'claude-5')
  }
  // the key that the user made the default is the default
  assert.equal(choice('opus', 'claude-key')?.account, 'claude-key')
  // OpenRouter is as it was: a key by name when the organization has a default of another provider
  assert.equal(choice('or-model', 'claude-9')?.account, 'openrouter-1')
  assert.equal(choice('or-model', null)?.account, undefined)
})

test('the hire form says "Choose an account" and holds nothing until the user picks the key', async (t) => {
  await staffing(t, ROWS)
  const tree = { slug: 'acme', dirs: [], tiers: { opus: 5, haiku: 1 }, max_top_grant: 100, default_effort: '', effort_default: 'high',
    cascade_hire: true, default_account: 'claude-9' } as unknown as TreePayload
  const accounts = [
    { id: 'claude-key', provider: 'claude', label: 'Metered key', mode: 'apikey', standing: { state: 'ready' } },
    { id: 'claude-9', provider: 'claude', label: 'Signed out', standing: { state: 'ready' } },
  ]
  const draft: DraftState = { parent: null, tier: 'opus' }
  const view = await mountView(<DraftScopeModal draft={draft} map={new Map()} tree={tree} scope={null} accounts={accounts} onSave={() => {}} close={() => {}} />, (el) => el)
  t.after(async () => { await view.unmount() })
  await flush()
  const select = () => document.body.querySelector<HTMLSelectElement>('select[aria-label="Account"]')!
  assert.ok(select(), 'the Account row is there')
  assert.equal(select().value, '', 'no account is selected')
  assert.equal(select().disabled, false, 'the user can choose')
  const options = [...select().querySelectorAll('option')].map((o) => ({ value: o.value, text: o.textContent, disabled: o.disabled }))
  assert.deepEqual(options[0], { value: '', text: 'Choose an account', disabled: true })
  assert.deepEqual(options.slice(1).map((o) => o.value), ['claude-key'], 'only what can run the model is offered')
  assert.equal([...document.body.querySelectorAll('button')].some((b) => /Use machine default/.test(b.textContent ?? '')), false)
  // a model the own sign-in can run is as it was: its sign-in is shown, nothing has to be chosen
  await view.render(<DraftScopeModal draft={{ parent: null, tier: 'haiku' }} map={new Map()} tree={{ ...tree, default_account: null } as TreePayload} scope={null}
    accounts={accounts} onSave={() => {}} close={() => {}} />)
  await flush()
  assert.equal([...select().querySelectorAll('option')].some((o) => o.textContent === 'Choose an account'), false)
  assert.notEqual(select().value, '')
})
