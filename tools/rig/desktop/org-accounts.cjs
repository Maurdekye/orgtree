// Open Usage and Usage history from the org window and screenshot them
// (org-accounts proof). There is no "Show all accounts" toggle any more
// (user ruling 2026-10-10 14:56Z); `toggle` reports whether one is there.
module.exports = async (page) => {
  const state = (sel) => page.eval((s) => {
    const m = document.querySelector(s)
    return {
      text: (m?.innerText || '').replace(/\s+/g, ' '),
      toggle: !!m && /Show all accounts/.test(m.innerText),
    }
  }, sel)
  await page.waitFor('.usage-history-btn', { timeout: 30000 })
  await page.sleep(800)
  // the Usage door is the icon button just before the Usage history one
  await page.eval(() => document.querySelector('.usage-history-btn').previousElementSibling.click())
  await page.waitFor('.usage-modal', { timeout: 15000 })
  await page.sleep(2500)
  const out = {}
  await page.screenshot('usage-org')
  out.usage = await state('.usage-modal')
  // the first click outside only closes Usage; open Usage history once it is gone
  await page.press('Escape')
  await page.sleep(500)
  if (await page.eval(() => !!document.querySelector('.usage-modal'))) await page.click('.usage-history-btn')
  await page.eval(() => document.querySelector('.usage-history-btn').click())
  await page.waitFor('.usage-history-modal', { timeout: 15000 })
  await page.sleep(2000)
  await page.screenshot('history-org')
  out.history = await state('.usage-history-modal')
  out.consoleErrors = page.consoleErrors
  return out
}
