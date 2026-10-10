// quick-chat-composer.mjs's desktop stage: an ORGANIZATION WINDOW of the v3
// shell (a minimal desktop bridge planted before the page loads, as in
// quick-chat-header.cjs). Quick chat as one composer row: its height against
// the header's, the model control with and without a typed prompt, the
// superior picker beside the open Agents List, the model picker, two files
// attached, and Enter sending them with the message.
// args: { org, theme, size, prompt, files: [{ name, text }] }
module.exports = async (page, { args }) => {
  const bridge = `
  (() => {
    try { localStorage.setItem('orgtree-contrast-theme', ${JSON.stringify(args.theme)}) } catch {}
    const id = { windowId: 'rig-org', kind: 'org', org: ${JSON.stringify(args.org)} }
    const prefs = { contrastTheme: ${JSON.stringify(args.theme)} }
    window.orgtreeDesktop = {
      getAppVersion: async () => '4.2.0-rig',
      getPreferences: async () => prefs,
      setPreferences: async (patch) => Object.assign(prefs, patch),
      onEvent: () => () => {},
      windowIdentity: id,
      getWindowIdentity: async () => id,
      requestOrg: async () => null,
    }
  })()`
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: bridge })
  await page.goto(`/o/${args.org}`)
  await page.waitFor('.shell-header [data-testid="quickchat"]', { timeout: 30000 })
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 30000 })
  await page.resize(args.size)
  await page.sleep(1500)
  const layout = () => page.eval(() => {
    const header = document.querySelector('.shell-header').getBoundingClientRect()
    const box = document.querySelector('.shell-header .quickchat')
    const b = box.getBoundingClientRect()
    const parts = [...box.children].filter(e => e.getBoundingClientRect().width > 0)
      .map(e => { const r = e.getBoundingClientRect(); return { cls: e.className.split(' ').slice(0, 2).join(' '), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) } })
    return { headerH: Math.round(header.height), boxH: Math.round(b.height), boxTop: Math.round(b.top), boxBottom: Math.round(b.bottom),
      parts, insideBox: parts.every(p => p.top >= b.top - 1 && p.bottom <= b.bottom + 1 && p.left >= b.left - 1 && p.right <= b.right + 1) }
  })
  const model = () => page.eval(() => ({
    icon: [...(document.querySelector('.shell-header .quickchat-model .tier')?.classList ?? [])].find(c => c.startsWith('t-')) ?? null,
    name: document.querySelector('.shell-header .quickchat-model .quickchat-name')?.textContent ?? null,
  }))
  const empty = { layout: await layout(), model: await model() }
  await page.screenshot(`${args.theme}-composer-empty`)
  await page.click('.shell-header .quickchat-input')
  await page.type(args.prompt)
  await page.sleep(500)
  const typed = { layout: await layout(), model: await model() }
  await page.screenshot(`${args.theme}-composer-typed`)
  // alpha.3 feedback: width, order, the id icon's shape and its letter's centre
  const look = await page.eval(() => {
    const box = document.querySelector('.shell-header .quickchat')
    const order = [...box.querySelectorAll('.quickchat-btn')].map(b => (b.className.match(/quickchat-(model|superior|attach|send)/) || [])[1])
    const icon = document.querySelector('.shell-header .quickchat-model .tier')
    const ir = icon.getBoundingClientRect()
    const range = document.createRange(); range.selectNodeContents(icon)
    const g = range.getBoundingClientRect()
    const slot = document.querySelector('.shell-header-quick')
    return { boxW: Math.round(box.getBoundingClientRect().width), slotBasis: getComputedStyle(slot).flexBasis,
      winW: window.innerWidth, order, radius: getComputedStyle(icon).borderRadius,
      dx: +((g.left + g.width / 2) - (ir.left + ir.width / 2)).toFixed(1), dy: +((g.top + g.height / 2) - (ir.top + ir.height / 2)).toFixed(1) }
  })
  // the Agents List open, then the superior picker beside it — opened by a
  // click with no pointer press, because a press outside the Agents List closes it
  await page.click('.tray-toggle')
  await page.waitFor('.tray .tray-row', { timeout: 10000 })
  await page.eval(() => document.querySelector('.shell-header .quickchat-superior').click())
  await page.waitFor('.quickchat-pop-superior .tray-row', { timeout: 10000 })
  await page.sleep(400)
  const lists = await page.eval(() => {
    const names = (root) => [...root.querySelectorAll('.tray-row')].filter(e => !/ghost/.test(e.className))
      .map(e => e.getAttribute('data-copy-agent-name'))
    const trays = [...document.querySelectorAll('.tray')]
    const picker = document.querySelector('.quickchat-pop-superior .tray')
    const list = trays.find(t => t !== picker && t.getBoundingClientRect().width > 0)
    return { picker: names(picker), list: list ? names(list) : null,
      top: document.querySelector('.quickchat-pop-superior .quickchat-top')?.textContent?.trim(),
      icons: picker.querySelectorAll('.tray-row .tier').length,
      popTop: Math.round(document.querySelector('.quickchat-pop').getBoundingClientRect().top),
      headerBottom: Math.round(document.querySelector('.shell-header').getBoundingClientRect().bottom) }
  })
  await page.screenshot(`${args.theme}-superior-picker-beside-agents-list`)
  // filter + keys: the first match is picked with ArrowDown, Enter
  await page.type('car')
  await page.sleep(300)
  await page.press('ArrowDown')
  await page.press('Enter')
  await page.sleep(400)
  const picked = await page.eval(() => document.querySelector('.shell-header .quickchat-superior .quickchat-label')?.textContent)
  await page.click('.tray-toggle')
  // the model picker: the hire chips
  // opened from script so the first frames can be read: the fade starts at 0
  const fadeIn = await page.eval(() => new Promise(res => {
    document.querySelector('.shell-header .quickchat-model').click()
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const h = document.querySelector('.quickchat-pop-model .hsof')
      res(h ? +getComputedStyle(h).opacity : null)
    }))
  }))
  await page.waitFor('.quickchat-pop-model .hsof button', { timeout: 10000 })
  await page.sleep(300)
  const strip = await page.eval(() => {
    const pop = document.querySelector('.quickchat-pop-model')
    const btn = document.querySelector('.shell-header .quickchat-model').getBoundingClientRect()
    const pr = pop.getBoundingClientRect()
    const cs = getComputedStyle(pop)
    const rows = [...pop.querySelectorAll('.hs-fam')].map(r => { const b = r.getBoundingClientRect(); return { n: r.children.length, mid: +(b.left + b.width / 2).toFixed(1) } })
    const chip = pop.querySelector('.hsof button')
    return { bg: cs.backgroundColor, border: cs.borderTopStyle, shadow: cs.boxShadow,
      popMid: +(pr.left + pr.width / 2).toFixed(1), btnMid: +(btn.left + btn.width / 2).toFixed(1), rows,
      opacity: +getComputedStyle(pop.querySelector('.hsof')).opacity, chipRadius: getComputedStyle(chip).borderRadius }
  })
  const chips = await page.eval(() => [...document.querySelectorAll('.quickchat-pop-model .hsof button')]
    .map(b => ({ tier: [...b.classList].find(c => c.startsWith('t-')), sel: b.classList.contains('sel'), title: b.title })))
  await page.screenshot(`${args.theme}-model-picker`)
  await page.eval(() => document.querySelector('.quickchat-pop-model .hsof button.t-haiku')?.click())
  const fadeOut = await page.eval(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
    const h = document.querySelector('.quickchat-leaving .hsof')
    res({ leaving: !!h, opacity: h ? +getComputedStyle(h).opacity : null, picker: !!document.querySelector('.quickchat-pop') })
  }))))
  await page.sleep(400)
  const gone = await page.eval(() => !document.querySelector('.quickchat-leaving'))
  const afterModel = await model()
  // two files, the way choosing them in the picker hands the input
  await page.eval((files) => {
    const input = document.querySelector('.shell-header [data-testid="quickchat-files"]')
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(new File([f.text], f.name, { type: 'text/plain' }))
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, args.files)
  await page.sleep(400)
  const count = await page.eval(() => document.querySelector('.shell-header .quickchat-count')?.textContent ?? null)
  const withFiles = await layout()
  await page.screenshot(`${args.theme}-composer-two-files`)
  await page.click('.shell-header .quickchat-attach')
  await page.waitFor('.quickchat-pop-files li', { timeout: 10000 })
  const fileList = await page.eval(() => [...document.querySelectorAll('.quickchat-pop-files .quickchat-file')].map(e => e.textContent))
  await page.screenshot(`${args.theme}-attachments-popover`)
  await page.press('Escape')
  await page.click('.shell-header .quickchat-input')
  const name = typed.model.name
  await page.press('Enter')
  await page.sleep(4000)
  const after = await page.eval(() => ({
    value: document.querySelector('.shell-header .quickchat-input')?.value,
    count: document.querySelector('.shell-header .quickchat-count')?.textContent ?? null,
  }))
  await page.screenshot(`${args.theme}-after-send`)
  return { empty, typed, look, fadeIn, strip, fadeOut, gone, lists, picked, chips, afterModel, count, withFiles, fileList, name, after, errors: page.consoleErrors }
}
