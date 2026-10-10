// An agent desk with its resolved request: the scope or credit card in the transcript.
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
  await page.waitFor('.resolved-card', { timeout: 30000 })
  await page.sleep(800)
  await page.eval(() => document.querySelector('.resolved-card')?.scrollIntoView({ block: 'center' }))
  await page.sleep(400)
  await page.screenshot(`${args.agent}-desk`)
  return page.eval(() => [...document.querySelectorAll('.resolved-card')].map((c) => ({
    kind: c.dataset.kind, summary: c.querySelector('summary')?.innerText,
    rows: [...c.querySelectorAll('.resolved-row')].map((r) => r.innerText.replace(/\s+/g, ' ')),
    raw: !!document.body.innerText.match(/SCOPE REQUEST decided|decisions/),
  })))
}
