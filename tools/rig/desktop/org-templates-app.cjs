// App settings → Runtime: "Organization templates" beside the charter
// documents, then press generate. args: { shot }
module.exports = async (page, { args }) => {
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 30000 })
  await page.sleep(1500)
  await page.eval(() => window.dispatchEvent(new window.CustomEvent('orgtree:open-app-settings', { detail: { tab: 'runtime' } })))
  await page.waitFor({ selector: 'button', text: '^generate$', regex: true, scroll: true }, { timeout: 20000 })
  await page.sleep(800)
  await page.screenshot(`${args.shot}-before`)
  await page.click({ selector: 'button', text: '^generate$', regex: true, scroll: true })
  await page.sleep(1500)
  await page.screenshot(`${args.shot}-generated`)
  return page.eval(() => {
    const groups = [...document.querySelectorAll('h4, .set-group-title, legend')].map((h) => h.innerText.trim())
    const body = document.body.innerText
    const at = body.indexOf('Organization templates')
    return { groups: groups.filter((g) => /Charter|template/i.test(g)), snippet: at >= 0 ? body.slice(at, at + 420) : null }
  })
}
