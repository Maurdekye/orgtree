import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
const { createOrganization, verifyOrganization } = createRequire(import.meta.url)('./organization_flow.cjs')

function fixture({ caption = '+ New organization', onboarding = true, prefs = { onboarded: false },
                   create = true, complete = true, action = true, existing = false } = {}) {
  const dom = new JSDOM(`<div class="welcome-card${onboarding ? ' onboarding' : ''}">
    ${action ? `<button>${caption}</button>` : ''}</div>`, { runScripts: 'outside-only' })
  const { window } = dom
  let orgs = existing ? [{ name: 'Acceptance Runtime', slug: 'acceptance-runtime' }] : [], submissions = 0
  window.orgtreeDesktop = { getPreferences: async () => ({ ...prefs }) }
  window.fetch = async url => ({ status: orgs.length ? 200 : 404, json: async () => orgs })
  window.document.querySelector('button')?.addEventListener('click', () => {
    const card = window.document.querySelector('.welcome-card')
    card.innerHTML = '<form><input required placeholder="organization name"><button type="submit">create</button></form>'
    card.querySelector('form').addEventListener('submit', event => {
      event.preventDefault(); submissions++
      const name = card.querySelector('input').value
      if (!create) return
      orgs = [{ name, slug: 'acceptance-runtime' }]
      if (onboarding && complete) prefs.onboarded = true
      // The actual create handler can open an org even if charter population
      // failed. A header-only test would incorrectly pass this failure mode.
      window.document.body.innerHTML = '<header class="orgbar"><h2></h2></header>'
      window.document.querySelector('h2').textContent = name
    })
  })
  const evaluate = async code => window.eval(code)
  const waitFor = async condition => Boolean(await evaluate(condition))
  return { evaluate, waitFor, name: 'Acceptance Runtime', slug: 'acceptance-runtime',
    get submissions() { return submissions }, close: () => window.close() }
}

test('current first-run form creates an org and requires persisted setup completion', async () => {
  const f = fixture()
  try {
    const result = await createOrganization(f)
    assert.equal(f.submissions, 1)
    assert.equal(result.firstRun, true)
    await verifyOrganization({ ...f, ...result }) // Restart verifies, never creates.
    assert.equal(f.submissions, 1)
  } finally { f.close() }
})

for (const [label, options] of [
  ['previous lowercase home action', { caption: '+ new organization', onboarding: false, prefs: {} }],
  ['preconfigured current home action', { onboarding: false, prefs: { onboarded: true } }],
]) test(label + ' remains supported', async () => {
  const f = fixture(options)
  try { assert.equal((await createOrganization(f)).firstRun, false); assert.equal(f.submissions, 1) }
  finally { f.close() }
})

test('negative control: an org header cannot conceal failed setup persistence', async () => {
  const f = fixture({ complete: false })
  try {
    await assert.rejects(createOrganization(f), /complete and persist first-run setup/)
    assert.equal(f.submissions, 1)
  } finally { f.close() }
})

test('negative control: a failed create is not replaced with a direct API write', async () => {
  const f = fixture({ create: false })
  try { await assert.rejects(createOrganization(f), /Created organization must appear/); assert.equal(f.submissions, 1) }
  finally { f.close() }
})

test('negative control: a missing New organization action fails before submission', async () => {
  const f = fixture({ action: false })
  try { await assert.rejects(createOrganization(f), /New organization action/); assert.equal(f.submissions, 0) }
  finally { f.close() }
})

test('negative control: a pre-existing result cannot make broken creation pass', async () => {
  const f = fixture({ onboarding: false, prefs: { onboarded: true }, existing: true })
  try { await assert.rejects(createOrganization(f), /pre-existing positive result/); assert.equal(f.submissions, 0) }
  finally { f.close() }
})
