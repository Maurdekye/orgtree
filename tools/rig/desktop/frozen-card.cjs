// Look at a frozen agent the way the user does: its canvas card, then its
// desk (card menu › Open › desk). args: { agent: "<name>" }
module.exports = async (page, { args }) => {
  const card = `[data-copy-agent-name="${args.agent}"]`
  await page.waitFor(card, { timeout: 30000 })
  await page.sleep(1200)
  const cardText = await page.eval((sel) => (document.querySelector(sel)?.innerText || '').trim(), card)
  await page.screenshot(`${args.agent}-card`)
  await page.rightClick(card)
  await page.waitFor('.ctxmenu[role="menu"]')
  await page.hover({ selector: 'button.ctxmenu-item', text: '^Open( ▸)?$', regex: true })
  await page.sleep(300)
  await page.screenshot(`${args.agent}-open-menu`)
  const items = await page.eval(() => [...document.querySelectorAll('.ctxmenu[role="menu"] button.ctxmenu-item')].map((b) => (b.innerText || '').trim()))
  const desk = items.find((t) => /desk/i.test(t)) || items.find((t) => /^Open/.test(t) === false)
  if (desk) await page.click({ selector: 'button.ctxmenu-item', text: `^${desk.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c)}$`, regex: true })
  await page.sleep(1500)
  await page.screenshot(`${args.agent}-desk`)
  // every visible text node that talks about the freeze (badges hold an icon beside their text)
  const freezeText = await page.eval(() => {
    const out = new Set()
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = (n.nodeValue || '').trim()
      const r = n.parentElement && n.parentElement.getBoundingClientRect()
      if (t && r && r.width > 0 && /credential|rejected|network|unstick|parked|frozen|resume|died/i.test(t)) out.add(t.slice(0, 200))
    }
    return [...out].slice(0, 20)
  })
  return { cardText, openItems: items, clicked: desk ?? null, freezeText }
}
