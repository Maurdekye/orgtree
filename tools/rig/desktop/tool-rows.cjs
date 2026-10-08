// Open an agent's desk and read its collapsed tool rows (the `.tline` summary
// Needs `rig scenario tools/rig/desktop/tool-rows.scenario.json` and mail "PROOF-ROWS" to carol first.
// lines), then expand the first Bash row. args: { agent: "<name>", shot: "<prefix>" }
module.exports = async (page, { args }) => {
  const card = `[data-copy-agent-name="${args.agent}"]`
  await page.waitFor(card, { timeout: 30000 })
  await page.sleep(1200)
  await page.rightClick(card)
  await page.waitFor('.ctxmenu[role="menu"]')
  await page.hover({ selector: 'button.ctxmenu-item', text: '^Open( ▸)?$', regex: true })
  await page.sleep(300)
  const items = await page.eval(() => [...document.querySelectorAll('.ctxmenu[role="menu"] button.ctxmenu-item')].map((b) => (b.innerText || '').trim()))
  const desk = items.find((t) => /desk/i.test(t))
  await page.click({ selector: 'button.ctxmenu-item', text: `^${desk}$`, regex: true })
  await page.waitFor('.tline', { timeout: 20000 })
  await page.sleep(1000)
  const rows = () => page.eval(() => [...document.querySelectorAll('.tline')].map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim()))
  const collapsed = await rows()
  await page.screenshot(`${args.shot || 'tool-rows'}-collapsed`)
  await page.click({ selector: '.tline', text: '^Bash', regex: true })
  await page.sleep(1500)
  const expanded = await page.eval(() => (document.querySelector('.tools.tchip .tool-input, .tools.tchip pre, .tools.tchip')?.innerText || '').slice(0, 400))
  await page.screenshot(`${args.shot || 'tool-rows'}-expanded`)
  return { collapsed, expanded }
}
