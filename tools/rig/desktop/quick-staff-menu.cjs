// Open the docket, right-click the backlogged item, open its Staff… submenu and
// list the model labels. Screenshots: staff-menu.
module.exports = async (page) => {
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 30000 })
  await page.sleep(1000)
  await page.click('button[title="work docket"]')
  await page.sleep(1500)
  await page.click({ selector: 'label', text: 'Show backlogged', regex: true })
  const row = { selector: '*', text: 'staffing-proof' }
  await page.waitFor(row, { timeout: 15000 })
  await page.sleep(1500)
  await page.rightClick(row)
  await page.waitFor('.ctxmenu[role="menu"]')
  await page.sleep(800)
  await page.hover({ selector: 'button.ctxmenu-item', text: '^Staff', regex: true })
  await page.sleep(500)
  const labels = async () => page.eval(() => [...document.querySelectorAll('.ctxmenu[role="menu"] button.ctxmenu-item')].map((b) => (b.innerText || '').trim()))
  const first = await labels()
  await page.screenshot('staff-menu')
  return { first }
}
