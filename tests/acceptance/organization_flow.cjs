// Shared by the real Electron driver and its DOM regression controls. Creation
// uses the product form; setup must complete through that form's actual handler.
const assert = require('node:assert/strict')

const newButton = `([...document.querySelectorAll('.onboarding button, .welcome-card button')]
  .find(b => /^\\+?\\s*new organization$/i.test(b.textContent.trim()) && !b.disabled))`
const visibleOrganization = name => `document.querySelector('header.orgbar h2')?.textContent === ${JSON.stringify(name)} ||
  [...document.querySelectorAll('.org')].some(e => e.textContent.includes(${JSON.stringify(name)}))`

async function verifyOrganization({ evaluate, waitFor, name, slug, requireOnboarded }) {
  assert.equal(await waitFor(visibleOrganization(name)), true,
    'Created organization must appear in active header or restored home list')
  assert.equal(await evaluate(`fetch(${JSON.stringify('/api/orgs/' + slug)}).then(r => r.status)`), 200,
    'Created organization must exist in the real backend')
  if (requireOnboarded) {
    assert.equal((await evaluate('window.orgtreeDesktop.getPreferences()')).onboarded, true,
      'Organization creation must complete and persist first-run setup')
    assert.equal(await evaluate(`Boolean(document.querySelector('.onboarding'))`), false,
      'Completed setup must leave the onboarding screen')
  }
}

async function createOrganization({ evaluate, waitFor, name, slug }) {
  const prefs = await evaluate('window.orgtreeDesktop.getPreferences()')
  const orgs = await evaluate(`fetch('/api/orgs').then(r => r.json())`)
  assert.equal(orgs.some(org => org.slug === slug || org.name === name), false,
    'Creation needs a new organization, not a pre-existing positive result')
  const firstRun = prefs.onboarded === false && orgs.length === 0
  if (firstRun) assert.equal(await waitFor(`document.querySelector('.onboarding')`), true,
    'A fresh current installation must expose its real setup form')
  assert.equal(await waitFor(newButton), true, 'New organization action must be available')
  assert.equal(await evaluate(`(() => { const b = ${newButton}; if (!b) return false; b.click(); return true })()`), true)
  const input = `document.querySelector('input[placeholder="organization name"]')`
  assert.equal(await waitFor(input), true, 'Organization creation form must open')
  await evaluate(`(() => { const i = ${input};
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(name)});
    i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await evaluate(`${input}.form.requestSubmit(); true`)
  // NewOrg inside Onboarding completes setup before it opens the created org.
  // Do not set preferences through the test bridge or click Skip to bypass it.
  const requireOnboarded = firstRun || prefs.onboarded === true
  await verifyOrganization({ evaluate, waitFor, name, slug, requireOnboarded })
  return { firstRun, requireOnboarded, name, slug }
}

module.exports = { createOrganization, verifyOrganization }
