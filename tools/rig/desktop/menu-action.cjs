// Drive one context-menu action the way a user does: right-click a card,
// walk the menu path (hovering branches open their submenus), confirm, and
// read the toast. args: { card: "<agent>" | "eye", path: ["Halt…", "subtree"],
// confirm: "<confirm button regex>", toast: "<toast regex>", shot: "<name prefix>" }
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c)

module.exports = async (page, { args }) => {
  const cardSel = args.card === 'eye' ? '.sq.user' : `[data-copy-agent-name="${args.card}"]`
  const shot = args.shot || 'menu'
  await page.waitFor(cardSel, { timeout: 30000 })
  await page.sleep(800)
  await page.rightClick(cardSel)
  await page.waitFor('.ctxmenu[role="menu"]')
  const steps = []
  for (let i = 0; i < args.path.length; i++) {
    const item = { selector: 'button.ctxmenu-item', text: `^${escapeRe(args.path[i])}( ▸)?$`, regex: true }
    if (i < args.path.length - 1) {
      steps.push(await page.hover(item))
      await page.sleep(300)
      await page.screenshot(`${shot}-${i + 1}-open`)
    } else {
      steps.push(await page.click(item))
    }
  }
  await page.sleep(400)
  await page.screenshot(`${shot}-confirm`)
  const dialog = await page.eval(() => {
    const d = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal')].find((e) => e.getBoundingClientRect().width > 0)
    return d ? (d.innerText || '').trim().slice(0, 400) : null
  })
  const button = await page.click({ selector: 'button', text: args.confirm, regex: true })
  const toast = await page.waitFor({ text: args.toast, regex: true }, { timeout: 15000 })
  await page.screenshot(`${shot}-toast`)
  return { steps: steps.map((s) => s.text), dialog, button: button.text, toast: toast.text }
}
