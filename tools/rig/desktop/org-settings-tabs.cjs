// Open the Org settings window and screenshot the named tabs. args: { shot: "<prefix>", tabs: ["Hire defaults", "Connections"] }
module.exports = async (page, { args }) => {
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 30000 })
  await page.sleep(1500)
  await page.click('button[title="Settings"]')
  await page.sleep(1500)
  const tabs = await page.eval(() => [...document.querySelectorAll('[role="tab"]')].map((b) => (b.innerText || '').trim()))
  const out = { tabs }
  for (const t of args.tabs) {
    try {
      await page.click({ selector: '[role="tab"]', text: `^${t}$`, regex: true })
      await page.sleep(1500)
      await page.screenshot(`${args.shot}-${t.replace(/\W+/g, '-')}`)
    } catch (e) { out[t] = String(e.message).slice(0, 120) }
  }
  return out
}
