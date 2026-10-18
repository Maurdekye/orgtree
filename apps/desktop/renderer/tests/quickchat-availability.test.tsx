import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { QuickChat } from '../src/QuickChatBox'
import { quickChatChoices } from '../src/quickchat-availability'
import { resetStaffingOptionsForTests, type StaffingOptions } from '../src/canvas/staffingoptions'
import { legacyAppBackend } from './appfeed-fixture'
import type { TreePayload } from '../src/types'

const tree = { slug: 'availability', roots: [], default_top_grant: 50 } as unknown as TreePayload
const validRow = { tier: 'opus', seat: 4, efforts: ['high'], accounts: [], default_ok: true }

test('missing or malformed staffing tiers fail closed instead of throwing', () => {
  for (const body of [{}, { tiers: null }, { tiers: {} }, { tiers: 'pending' },
    { tiers: [null] }, { tiers: [{}] }, { tiers: [{ ...validRow, accounts: null }] }]) {
    assert.deepEqual(quickChatChoices(body as unknown as StaffingOptions, tree, new Map(), null), [], JSON.stringify(body))
  }
})

test('valid staffing choices remain available', () => {
  assert.deepEqual(quickChatChoices({ tiers: [validRow] } as StaffingOptions, tree, new Map(), null), [{ row: validRow }])
})

for (const error of [false, true]) test(`${error ? 'a staffing-options error' : 'an empty staffing-options body'} leaves Quick chat mounted with no eligible model`, async () => {
  localStorage.clear(); resetStaffingOptionsForTests()
  const previous = globalThis.fetch
  globalThis.fetch = legacyAppBackend((async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    return path.endsWith('/staffing-options')
      ? new Response(JSON.stringify(error ? { detail: 'starting up' } : {}), { status: error ? 503 : 200 })
      : new Response(JSON.stringify({ providers: [] }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
  const view = await mountView(<QuickChat slug="availability" tree={tree} op={async () => ({})}
    toast={() => {}} onHired={() => {}} />, element => element)
  try {
    await inAct(async () => { await flush(12) })
    assert.equal(view.el.querySelector('.quickchat-model')?.textContent, 'no model')
    assert.ok(view.el.querySelector('.quickchat-input'), 'composer remains mounted')
  } finally {
    await view.unmount(); globalThis.fetch = previous
    localStorage.clear(); resetStaffingOptionsForTests()
  }
})
