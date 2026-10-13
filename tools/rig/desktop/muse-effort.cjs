// muse-visual.mjs's effort stage: the effort control on one agent's desk,
// as its tier's own level names (user 2026-10-12 20:01Z). Opens the desk,
// opens the effort popover and reads the bar's levels and label.
// args: { agent: "<name>" }; saves <agent>-effort.png
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
  await page.waitFor('.cc-eff', { timeout: 30000 })
  await page.click('.cc-eff')
  await page.waitFor('.eff-pop .effort-bar-track', { timeout: 10000 })
  await page.sleep(600)
  const read = await page.eval(() => ({
    levels: [...document.querySelectorAll('.eff-pop .effort-bar-dot')].map((d) => d.getAttribute('data-level')),
    label: document.querySelector('.eff-pop .effort-bar-label')?.innerText ?? null,
    button: document.querySelector('.cc-eff')?.innerText ?? null,
  }))
  await page.screenshot(`${args.agent}-effort`)
  return read
}
