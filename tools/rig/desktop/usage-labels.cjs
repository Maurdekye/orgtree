// usage-labels.mjs's desktop stage: open Usage from the org window and read
// every account card's heading and plan line. Reports; the proof decides.
module.exports = async (page) => {
  await page.waitFor('.usage-history-btn', { timeout: 30000 })
  await page.sleep(800)
  // the Usage door is the icon button just before the Usage history one
  await page.eval(() => document.querySelector('.usage-history-btn').previousElementSibling.click())
  await page.waitFor('.usage-modal', { timeout: 15000 })
  await page.sleep(1500)
  // a registered account's reading arrives on the engine's own push; the
  // rig's loop may not have published it yet, so press its refresh button
  // (the user's own way to read it now)
  await page.eval(() => document.querySelectorAll('.usage-modal .usage-acct[data-account] .usage-refresh-button')
    .forEach((b) => b.click()))
  await page.sleep(3000)
  await page.screenshot('usage-labels')
  const cards = await page.eval(() => [...document.querySelectorAll('.usage-modal .usage-acct')].map((c) => ({
    label: c.querySelector('.acct-label')?.innerText.trim() ?? null,
    head: (c.querySelector('.usage-acct-who')?.innerText ?? '').replace(/\s+/g, ' ').trim(),
    text: c.innerText.replace(/\s+/g, ' ').trim(),
  })))
  return { cards, consoleErrors: page.consoleErrors }
}
