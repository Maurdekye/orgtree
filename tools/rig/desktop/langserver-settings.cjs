// App settings › Providers › Language Server, as the user sees it: the
// server cards a proof added (one line each, the offered models as chips),
// then the add form opened from "Add server" with the preset dropdown and the
// harness the preset allows. With `address`: the form's Find models against
// that (Ollama-like) server, which opens the model browser, the "Create a 64K
// version of this model" offer in it, and one click on it.
// args: { agent: "<an agent on the canvas>", shot: "<prefix>", address?: "<server url>", fresh?: true }
// `fresh`: no org, agent or server yet (a real server's first visit): wait only for the section.
module.exports = async (page, { args }) => {
  if (args.agent) await page.waitFor(`[data-copy-agent-name="${args.agent}"]`, { timeout: 30000 })
  await page.sleep(1500)
  await page.eval(() => window.dispatchEvent(new window.CustomEvent('orgtree:open-app-settings', { detail: { tab: 'providers' } })))
  await page.waitFor(args.fresh ? '.ls-section' : '.ls-section .ls-server', { timeout: 20000 })
  const scrollTo = (sel) => page.eval((s) => { document.querySelector(s)?.scrollIntoView({ block: 'start' }); return true }, sel)
  // the panel's other sections finish loading after the first paint: scroll once they have
  await page.sleep(1500)
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
        // the offered models: the card's lit chips
        models: [...s.querySelectorAll('.ls-toggles .orr-tog.on')].map((c) => text(c.querySelector('.orr-sel-name')) || c.getAttribute('aria-label')),
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
  if (!args.address) return { before, after }
  // Find models on the given server (the form starts on Ollama)
  await page.click({ selector: '.ls-add input[aria-label="server address"]' })
  await page.press('a', { modifiers: 2 })
  await page.type(args.address)
  await page.click({ selector: '.ls-add button', text: '^Find models$', regex: true })
  // several models: the browser opens on its own
  await page.waitFor('.ls-browser .ls-variant button', { timeout: 20000 })
  const rows = () => page.eval(() => [...document.querySelectorAll('.ls-browser .orr-row')].map((r) => ({
    id: (r.querySelector('.orr-name b')?.innerText || '').trim(),
    picked: r.querySelector('button.ls-offer')?.getAttribute('aria-pressed') === 'true',
    facts: (r.querySelector('.orr-name .dim')?.innerText || '').trim(),
    button: (r.querySelector('.ls-variant button')?.innerText || '').trim() || null,
    hint: (r.querySelector('.ls-variant .dim')?.innerText || '').replace(/\s+/g, ' ').trim() || null,
  })))
  await page.sleep(800)
  await page.screenshot(`${args.shot}-variant-offer`)
  const found = await rows()
  // the click: the version is made, listed (a model not there before), and picked
  await page.eval((known) => { window.__lsKnown = known; return true }, found.map((r) => r.id))
  await page.click({ selector: '.ls-browser .ls-variant button', text: '^Create a 64K version of this model$', regex: true })
  await page.waitFor(() => [...document.querySelectorAll('.ls-browser .orr-row .orr-name b')]
    .some((e) => !window.__lsKnown.includes(e.innerText.trim())), { timeout: 30000 })
  await page.sleep(800)
  await page.screenshot(`${args.shot}-variant-made`)
  const made = await rows()
  // done: back in the form, the picks shown as chips
  await page.click({ selector: '.ls-browser .orr-pager button', text: '^done$', regex: true })
  await page.waitFor('.ls-browser', { timeout: 10000, gone: true }).catch(() => null)
  // the lane colours as each theme computes them, and the light theme seen
  const colours = () => page.eval(() => {
    const css = getComputedStyle(document.documentElement)
    const head = document.querySelector('.ls-section .acct-provider-head')
    return { accent: css.getPropertyValue('--prov-langserver').trim(), tier: css.getPropertyValue('--tier-langserver').trim(),
      ink: css.getPropertyValue('--prov-langserver-ink').trim(), headBorder: head ? getComputedStyle(head).borderBottomColor : null }
  })
  const dark = await colours()
  await page.eval(() => { document.documentElement.classList.add('contrast-light'); return true })
  await page.sleep(600)
  const light = await colours()
  await scrollTo('.ls-section')
  await page.sleep(500)
  await page.screenshot(`${args.shot}-light-settings`)
  await page.press('Escape')
  await page.waitFor('.ls-section', { timeout: 10000, gone: true }).catch(() => null)
  await page.sleep(1200)
  await page.screenshot(`${args.shot}-light-canvas`)
  const chip = await page.eval(() => {
    const t = [...document.querySelectorAll('.tier')].find((e) => [...e.classList].some((c) => c.startsWith('t-ls-')))
    return t ? { color: getComputedStyle(t).color, background: getComputedStyle(t).backgroundColor, text: t.innerText.trim() } : null
  })
  await page.eval(() => { document.documentElement.classList.remove('contrast-light'); return true })
  return { before, after, found, made, dark, light, chip }
}
