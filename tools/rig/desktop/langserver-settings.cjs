// App settings › Providers › Language Server, as the user sees it: the
// server cards a proof added, then the add form opened from "Add server" with
// the preset dropdown and the harness the preset allows.
// args: { agent: "<an agent on the canvas>", shot: "<prefix>" }
module.exports = async (page, { args }) => {
  await page.waitFor(`[data-copy-agent-name="${args.agent}"]`, { timeout: 30000 })
  await page.sleep(1500)
  await page.eval(() => window.dispatchEvent(new window.CustomEvent('orgtree:open-app-settings', { detail: { tab: 'providers' } })))
  await page.waitFor('.ls-section', { timeout: 20000 })
  const scrollTo = (sel) => page.eval((s) => { document.querySelector(s)?.scrollIntoView({ block: 'start' }); return true }, sel)
  await scrollTo('.ls-section')
  await page.sleep(800)
  await page.screenshot(`${args.shot}-servers`)
  const read = () => page.eval(() => {
    const sec = document.querySelector('.ls-section')
    const text = (el) => (el?.innerText || '').trim()
    return {
      head: text(sec?.querySelector('.set-group-head')),
      servers: [...(sec?.querySelectorAll('.ls-server') ?? [])].map((s) => ({
        head: text(s.querySelector('.ls-server-head')),
        models: [...s.querySelectorAll('.ls-model')].map(text),
      })),
      form: text(sec?.querySelector('.ls-add')),
      presets: [...(sec?.querySelectorAll('.ls-add select[aria-label="kind of server"] option') ?? [])].map(text),
      harnesses: [...(sec?.querySelectorAll('.ls-add select[aria-label="harness"] option') ?? [])]
        .map((o) => ({ label: text(o), disabled: o.disabled })),
    }
  })
  const before = await read()
  await page.click({ selector: '.ls-section button', text: '^Add server$', regex: true })
  await page.waitFor('.ls-add', { timeout: 10000 })
  await scrollTo('.ls-add')
  await page.sleep(800)
  await page.screenshot(`${args.shot}-add-form`)
  const after = await read()
  return { before, after }
}
