// The user's inbox with answered questions: each nulled ask draws the answered-question card
// with the answer shown. Saves a screenshot and returns what each nulled card shows.
module.exports = async (page) => {
  await page.waitFor('button.ask-bell', { timeout: 30000 })
  await page.click('button.ask-bell')
  await page.waitFor('.mailer-list', { timeout: 30000 })
  await page.sleep(1500)
  // the answered asks sit in the list under the asking agents; open the list rows that are asks
  const rows = await page.eval(() => [...document.querySelectorAll('.mailer-list .mailrow')].map((r) => (r.innerText || '').trim().slice(0, 100)))
  await page.screenshot('inbox-list')
  const seen = []
  for (let i = 0; i < rows.length && i < 12; i++) {
    await page.eval((n) => document.querySelectorAll('.mailer-list .mailrow')[n]?.click(), i)
    await page.sleep(500)
    const cards = await page.eval(() => [...document.querySelectorAll('.mailer-read .answered-card, .mailer-read .askcard.nulled')].map((c) => ({
      cls: c.className, text: (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      chosen: [...c.querySelectorAll('.answered-opt[data-chosen="true"] .answered-opt-label')].map((o) => o.innerText),
      typed: [...c.querySelectorAll('.answered-typed')].map((o) => o.innerText) })))
    if (cards.length) { seen.push({ row: rows[i], cards }); await page.screenshot('inbox-row-' + i) }
  }
  return { rows, seen }
}
