// template-quickchat.mjs's desktop stage: Quick chat in organization windows
// of orgs made from a template (option B, user 2026-10-10 19:40Z: the org's
// template defaults win until the user picks by hand IN THAT ORG).
//   1. org A (from devteam (claude)), fresh browser: the box starts on the
//      template's superior and model;
//   2. a model picked by hand in A shows at once;
//   3. org B (also from the template) still starts on the template's model;
//   4. the seed org (no defaults) follows the last pick anywhere;
//   5. back in A, Save as template offers "Quick chat defaults" ticked and
//      saves (the proof reads the file).
// args: { a, b, seed, name }
module.exports = async (page, { args }) => {
  const bridge = `
  (() => {
    const org = decodeURIComponent((location.pathname.match(/^\\/o\\/([^/]+)/) || [])[1] || '')
    const id = { windowId: 'rig-org-' + org, kind: 'org', org }
    const prefs = { contrastTheme: 'charcoal' }
    window.orgtreeDesktop = {
      getAppVersion: async () => '4.2.0-rig',
      getPreferences: async () => prefs,
      setPreferences: async (patch) => Object.assign(prefs, patch),
      onEvent: () => () => {},
      windowIdentity: id,
      getWindowIdentity: async () => id,
      requestOrg: async () => null,
    }
  })()`
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: bridge })
  const shown = () => page.eval(() => ({
    superior: document.querySelector('[data-testid="quickchat"] .quickchat-superior .quickchat-label')?.textContent ?? null,
    model: [...(document.querySelector('[data-testid="quickchat"] .quickchat-model .tier')?.classList ?? [])]
      .find(c => c.startsWith('t-'))?.slice(2) ?? null,
    effort: document.querySelector('[data-testid="quickchat"] .effort-bar-track')?.dataset.effortPinned ?? null,
  }))
  const open = async (org, agent) => {
    await page.goto(`/o/${org}`)
    await page.waitFor('[data-testid="quickchat"]', { timeout: 30000 })
    await page.waitFor(`[data-copy-agent-name="${agent}"]`, { timeout: 30000 })
    await page.sleep(1500)
  }
  const out = {}
  await page.resize('1600x900')
  await open(args.a, 'coordinator')
  out.aFresh = await shown()
  await page.screenshot('1-org-a-template-defaults')
  await page.click('[data-testid="quickchat"] .quickchat-model')
  await page.sleep(500)
  await page.eval(() => document.querySelector('.quickchat-pop-model .hsof button.t-haiku')?.click())
  await page.sleep(800)
  out.aPicked = await shown()
  await page.screenshot('2-org-a-picked-haiku')
  await open(args.b, 'coordinator')
  out.bFresh = await shown()
  await page.screenshot('3-org-b-template-defaults')
  await open(args.seed, 'boss')
  out.seed = await shown()
  await page.screenshot('4-seed-org-last-pick')
  await open(args.a, 'coordinator')
  out.aAgain = await shown()
  // the organization window's gear (its label differs from the canvas shell's)
  out.gear = await page.eval(() => {
    const bs = [...document.querySelectorAll('button')]
    const gear = bs.find(b => /settings/i.test(`${b.title} ${b.getAttribute('aria-label') ?? ''}`)
      && !/app settings/i.test(`${b.title} ${b.getAttribute('aria-label') ?? ''}`))
    gear?.click()
    return gear ? (gear.title || gear.getAttribute('aria-label')) : bs.map(b => b.title || b.getAttribute('aria-label')).filter(Boolean)
  })
  await page.waitFor({ selector: 'button', text: '^save as template…$', regex: true, scroll: true }, { timeout: 20000 })
  await page.sleep(600)
  await page.click({ selector: 'button', text: '^save as template…$', regex: true, scroll: true })
  await page.waitFor('#save-template-name')
  await page.eval((name) => {
    const el = document.querySelector('#save-template-name')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, name)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, args.name)
  await page.sleep(400)
  out.groups = await page.eval(() => [...document.querySelectorAll('.save-template-groups label')]
    .map(l => ({ text: l.textContent.replace(/\s+/g, ' ').trim(), checked: !!l.querySelector('input')?.checked })))
  await page.screenshot('5-save-modal')
  await page.click({ selector: '.save-template button', text: '^Save template$', regex: true })
  await page.waitFor({ selector: '.save-template button', text: '^Download ', regex: true }, { timeout: 20000 })
  await page.sleep(400)
  await page.screenshot('6-saved')
  return out
}
