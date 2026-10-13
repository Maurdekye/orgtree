// App settings › Harnesses as the user sees it, then an OpenRouter key's
// edit dialog: its harness selector (installed harnesses only) and the
// "Which harnesses are supported?" link, which opens the Harnesses tab.
// Driven by tools/rig/proofs/openrouter-harness-visual.mjs.
module.exports = async (page) => {
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 30000 })
  await page.sleep(1500)
  await page.eval(() => window.dispatchEvent(new window.CustomEvent('orgtree:open-app-settings', { detail: { tab: 'harnesses' } })))
  await page.waitFor('.harness-entry', { timeout: 20000 })
  await page.sleep(800)
  const entries = await page.eval(() => [...document.querySelectorAll('.harness-entry')].map((e) => ({
    name: e.querySelector('b')?.textContent ?? '', installed: !!e.querySelector('.harness-installed'), text: e.innerText })))
  const selected = await page.eval(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim())
  // the strip fits the panel at this width (user 2026-09-29: no tab cut off)
  const strip = await page.eval(() => { const s = document.querySelector('.app-settings-tabs'); return s && { scroll: s.scrollWidth, client: s.clientWidth } })
  await page.screenshot('harnesses-tab')
  await page.click({ selector: '[role="tab"]', text: '^Providers$', regex: true })
  await page.sleep(1500)
  await page.eval(() => {
    const b = [...document.querySelectorAll('button.acct-btn')].find((x) => /choose its harness/.test(x.title))
    if (!b) throw new Error('no key edit button')
    b.scrollIntoView({ block: 'center' }); b.click()
  })
  await page.waitFor('#openrouter-key-harness', { timeout: 10000 })
  await page.sleep(600)
  const options = await page.eval(() => [...document.querySelectorAll('#openrouter-key-harness option')].map((o) => o.textContent.trim()))
  const link = await page.eval(() => !!document.querySelector('.harness-help-link'))
  await page.screenshot('key-dialog-harness')
  await page.eval(() => document.querySelector('.harness-help-link').click())
  await page.sleep(1200)
  const after = await page.eval(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim())
  await page.screenshot('link-opened-harnesses')
  return { entries, selected, strip, options, link, after }
}
