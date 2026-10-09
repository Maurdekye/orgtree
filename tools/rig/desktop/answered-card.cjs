// An agent's desk with its answered question: the mini card in the transcript.
// args: { agent: "<name>" }; saves <agent>-desk.png and returns what the card shows.
module.exports = async (page, { args }) => {
  const card = `[data-copy-agent-name="${args.agent}"]`
  await page.waitFor(card, { timeout: 30000 })
  await page.sleep(800)
  await page.rightClick(card)
  await page.waitFor('.ctxmenu[role="menu"]')
  await page.hover({ selector: 'button.ctxmenu-item', text: '^Open( ▸)?$', regex: true })
  await page.sleep(300)
  const items = await page.eval(() => [...document.querySelectorAll('.ctxmenu[role="menu"] button.ctxmenu-item')].map((b) => (b.innerText || '').trim()))
  const desk = items.find((t) => /desk/i.test(t))
  if (desk) await page.click({ selector: 'button.ctxmenu-item', text: `^${desk.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c)}$`, regex: true })
  await page.waitFor('.answered-card', { timeout: 30000 })
  await page.sleep(800)
  await page.eval(() => document.querySelector('.answered-card')?.scrollIntoView({ block: 'center' }))
  await page.sleep(400)
  await page.screenshot(`${args.agent}-desk`)
  return page.eval(() => [...document.querySelectorAll('.answered-card')].map((c) => ({
    summary: c.querySelector('summary')?.innerText,
    open: c.hasAttribute('open'),
    questions: [...c.querySelectorAll('.answered-q')].map((q) => ({
      question: q.querySelector('.answered-qtext')?.innerText,
      options: [...q.querySelectorAll('.answered-opt')].map((o) => ({ label: o.querySelector('.answered-opt-label')?.innerText, chosen: o.dataset.chosen })),
      typed: q.querySelector('.answered-typed')?.innerText ?? null,
    })),
  })))
}
