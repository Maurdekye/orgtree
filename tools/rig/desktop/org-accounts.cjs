// Open Usage and Usage history from the org window, each with "Show all
// accounts" off and then on, and screenshot them (org-accounts proof).
module.exports = async (page) => {
  const state = (sel) => page.eval((s) => {
    const m = document.querySelector(s)
    return {
      text: (m?.innerText || '').replace(/\s+/g, ' '),
      greyed: m ? m.querySelectorAll('.org-lane-off').length : -1,
      toggle: !!m?.querySelector('.org-lanes-toggle'),
    }
  }, sel)
  const toggle = (sel) => page.eval((s) => {
    const box = document.querySelector(`${s} .org-lanes-toggle input`)
    if (box) box.click()
    return !!box
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
  out.usageToggled = await toggle('.usage-modal')
  await page.sleep(800)
  await page.screenshot('usage-org-show-all')
  out.usageAll = await state('.usage-modal')
  // the first click outside only closes Usage; open Usage history once it is gone
  await page.press('Escape')
  await page.sleep(500)
  if (await page.eval(() => !!document.querySelector('.usage-modal'))) await page.click('.usage-history-btn')
  await page.eval(() => document.querySelector('.usage-history-btn').click())
  await page.waitFor('.usage-history-modal', { timeout: 15000 })
  await page.sleep(2000)
  await page.screenshot('history-org')
  out.history = await state('.usage-history-modal')
  out.historyToggled = await toggle('.usage-history-modal')
  await page.sleep(800)
  await page.screenshot('history-org-show-all')
  out.historyAll = await state('.usage-history-modal')
  out.consoleErrors = page.consoleErrors
  return out
}
