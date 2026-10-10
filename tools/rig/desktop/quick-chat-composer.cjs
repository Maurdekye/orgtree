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
  await page.waitFor('.shell-statusbar [data-testid="quickchat"]', { timeout: 30000 })
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 30000 })
  await page.resize(args.size)
  await page.sleep(1500)
  const layout = () => page.eval(() => {
    const header = document.querySelector('.shell-statusbar').getBoundingClientRect()
    const box = document.querySelector('.shell-statusbar .quickchat')
    const b = box.getBoundingClientRect()
    const parts = [...box.children].filter(e => e.getBoundingClientRect().width > 0)
      .map(e => { const r = e.getBoundingClientRect(); return { cls: e.className.split(' ').slice(0, 2).join(' '), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) } })
    return { headerH: Math.round(header.height), boxH: Math.round(b.height), boxTop: Math.round(b.top), boxBottom: Math.round(b.bottom),
      parts, insideBox: parts.every(p => p.top >= b.top - 1 && p.bottom <= b.bottom + 1 && p.left >= b.left - 1 && p.right <= b.right + 1) }
  })
  const model = () => page.eval(() => ({
    icon: [...(document.querySelector('.shell-statusbar .quickchat-model .tier')?.classList ?? [])].find(c => c.startsWith('t-')) ?? null,
    name: document.querySelector('.shell-statusbar .quickchat-model .quickchat-name')?.textContent ?? null,
  }))
  const empty = { layout: await layout(), model: await model() }
  await page.screenshot(`${args.theme}-composer-empty`)
  await page.click('.shell-statusbar .quickchat-input')
  await page.type(args.prompt)
  await page.sleep(500)
  const typed = { layout: await layout(), model: await model() }
  await page.screenshot(`${args.theme}-composer-typed`)
  // alpha.3 feedback: width, order, the id icon's shape and its letter's centre
  const look = await page.eval(() => {
    const box = document.querySelector('.shell-statusbar .quickchat')
    const order = [...box.querySelectorAll('.quickchat-btn')].map(b => (b.className.match(/quickchat-(model|superior|attach|send)/) || [])[1])
    const icon = document.querySelector('.shell-statusbar .quickchat-model .tier')
    const ir = icon.getBoundingClientRect()
    const range = document.createRange(); range.selectNodeContents(icon)
    const g = range.getBoundingClientRect()
    const slot = document.querySelector('.shell-statusbar-quick')
    return { boxW: Math.round(box.getBoundingClientRect().width), slotBasis: getComputedStyle(slot).flexBasis,
      winW: window.innerWidth, order, radius: getComputedStyle(icon).borderRadius,
      dx: +((g.left + g.width / 2) - (ir.left + ir.width / 2)).toFixed(1), dy: +((g.top + g.height / 2) - (ir.top + ir.height / 2)).toFixed(1) }
  })
  // the Agents List open, then the superior picker beside it — opened by a
  // click with no pointer press, because a press outside the Agents List closes it
  await page.click('.tray-toggle')
  await page.waitFor('.tray .tray-row', { timeout: 10000 })
  await page.eval(() => document.querySelector('.shell-statusbar .quickchat-superior').click())
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
      popBottom: Math.round(document.querySelector('.quickchat-pop').getBoundingClientRect().bottom),
      footerTop: Math.round(document.querySelector('.shell-statusbar').getBoundingClientRect().top) }
  })
  // "top level" is an option row like the agents' rows (user 2026-10-10)
  const rowLook = async (sel) => page.eval((sel) => {
    const row = document.querySelector(sel)
    const name = row.querySelector('.tray-name')
    const cs = getComputedStyle(name), rs = getComputedStyle(row)
    const chip = row.querySelector('.tier')
    return { weight: cs.fontWeight, color: cs.color, size: cs.fontSize, family: cs.fontFamily, h: Math.round(row.getBoundingClientRect().height),
      bg: rs.backgroundColor, chipW: chip ? Math.round(chip.getBoundingClientRect().width) : null, eye: !!row.querySelector('.tier svg.eye'), sel: row.classList.contains('sel') }
  }, sel)
  const topRow = '.quickchat-pop-superior .quickchat-top'
  const agentRow = '.quickchat-pop-superior .tray .tray-row[data-copy-agent-name="alice"]'
  // the selection on boss first, so "top level" and alice are both at rest
  await page.press('ArrowDown'); await page.sleep(150)
  const agent = { selRow: await rowLook('.quickchat-pop-superior .tray .tray-row.sel'), rest: await rowLook(agentRow) }
  const top = { rest: await rowLook(topRow) }
  await page.hover(topRow); await page.sleep(150); top.hover = await rowLook(topRow)
  await page.screenshot(`${args.theme}-superior-picker-top-level-hover`)
  await page.hover(agentRow); await page.sleep(150); agent.hover = await rowLook(agentRow)
  await page.press('ArrowUp'); await page.sleep(150); top.selRow = await rowLook(topRow)
  const topLevel = { top, agent }
  await page.screenshot(`${args.theme}-superior-picker-beside-agents-list`)
  // filter + keys: the first match is picked with ArrowDown, Enter
  await page.type('car')
  await page.sleep(300)
  await page.press('ArrowDown')
  await page.press('Enter')
  await page.sleep(400)
  const picked = await page.eval(() => document.querySelector('.shell-statusbar .quickchat-superior .quickchat-label')?.textContent)
  await page.click('.tray-toggle')
  // the model picker: the hire chips
  // opened from script so the first frames can be read: the fade starts at 0
  const fadeIn = await page.eval(() => new Promise(res => {
    document.querySelector('.shell-statusbar .quickchat-model').click()
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const h = document.querySelector('.quickchat-pop-model .hsof')
      res(h ? +getComputedStyle(h).opacity : null)
    }))
  }))
  await page.waitFor('.quickchat-pop-model .hsof button', { timeout: 10000 })
  await page.sleep(300)
  const strip = await page.eval(() => {
    const pop = document.querySelector('.quickchat-pop-model')
    const btn = document.querySelector('.shell-statusbar .quickchat-model').getBoundingClientRect()
    const pr = pop.getBoundingClientRect()
    const cs = getComputedStyle(pop)
    const rows = [...pop.querySelectorAll('.hs-fam')].map(r => { const b = r.getBoundingClientRect(); return { n: r.children.length, mid: +(b.left + b.width / 2).toFixed(1), top: Math.round(b.top) } })
    const chip = pop.querySelector('.hsof button')
    return { popTop: Math.round(pr.top), popBottom: Math.round(pr.bottom), btnTop: Math.round(btn.top), bg: cs.backgroundColor, border: cs.borderTopStyle, shadow: cs.boxShadow,
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
  // the pointer wandering off closes the chips: real mouse moves from the button
  await page.hover('.shell-statusbar .quickchat-model')
  await page.click('.shell-statusbar .quickchat-model')
  await page.waitFor('.quickchat-pop.quickchat-pop-model .hsof button', { timeout: 10000 })
  await page.sleep(250)
  const geo = await page.eval(() => {
    const r = document.querySelector('.quickchat-pop.quickchat-pop-model').getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right), y: Math.round(r.top + r.height / 2) }
  })
  const openNow = () => page.eval(() => !!document.querySelector('.quickchat-pop.quickchat-pop-model'))
  // the chips open upward from the footer: stray above them
  await page.hover({ x: geo.x, y: geo.top - 60 })
  await page.sleep(200)
  const at60 = await openNow()
  await page.hover({ x: geo.right + 60, y: geo.y })
  await page.sleep(200)
  const at60side = await openNow()
  await page.screenshot(`${args.theme}-model-picker-pointer-60px-above`)
  await page.hover({ x: geo.x, y: geo.top - 100 })
  const left100 = await page.eval(() => new Promise(res => requestAnimationFrame(() => res({
    picker: !!document.querySelector('.quickchat-pop.quickchat-pop-model'),
    leaving: !!document.querySelector('.quickchat-leaving .hsof'),
    opacity: (() => { const h = document.querySelector('.quickchat-leaving .hsof'); return h ? +getComputedStyle(h).opacity : null })(),
  }))))
  await page.sleep(400)
  const wander = { geo, at60, at60side, left100, goneAfter: await page.eval(() => !document.querySelector('.quickchat-leaving')) }
  const afterModel = await model()
  // two files, the way choosing them in the picker hands the input
  await page.eval((files) => {
    const input = document.querySelector('.shell-statusbar [data-testid="quickchat-files"]')
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(new File([f.text], f.name, { type: 'text/plain' }))
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, args.files)
  await page.sleep(400)
  const count = await page.eval(() => document.querySelector('.shell-statusbar .quickchat-count')?.textContent ?? null)
  const withFiles = await layout()
  await page.screenshot(`${args.theme}-composer-two-files`)
  await page.click('.shell-statusbar .quickchat-attach')
  await page.waitFor('.quickchat-pop-files li', { timeout: 10000 })
  const fileList = await page.eval(() => [...document.querySelectorAll('.quickchat-pop-files .quickchat-file')].map(e => e.textContent))
  await page.screenshot(`${args.theme}-attachments-popover`)
  await page.press('Escape')
  await page.click('.shell-statusbar .quickchat-input')
  const name = typed.model.name
  await page.press('Enter')
  await page.sleep(4000)
  const after = await page.eval(() => ({
    value: document.querySelector('.shell-statusbar .quickchat-input')?.value,
    count: document.querySelector('.shell-statusbar .quickchat-count')?.textContent ?? null,
  }))
  await page.screenshot(`${args.theme}-after-send`)
  // narrowing the window: Quick chat keeps its full width until neither side
  // has free space left, sliding off-centre on the way (user 2026-10-10)
  const sweep = []
  const widths = [...(args.widths ?? [1600, 1300, 1100, 900])]
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i]
    await page.resize(`${w}x900`)
    await page.sleep(400)
    sweep.push(await page.eval(() => {
      const need = (el) => {
        const cs = getComputedStyle(el), kids = [...el.children]
        return kids.reduce((n, k) => n + k.getBoundingClientRect().width, 0) + (parseFloat(cs.columnGap) || 0) * Math.max(0, kids.length - 1)
          + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
      }
      const a = document.querySelector('.shell-statusbar-start'), b = document.querySelector('.shell-statusbar-end')
      const q = document.querySelector('.shell-statusbar .quickchat').getBoundingClientRect()
      // the header: no Quick chat, and its empty stretch is a window drag region
      const head = document.querySelector('.shell-header'), main = head.querySelector('.shell-header-main'), gapEl = head.querySelector('.shell-header-gap')
      const header = { quick: !!head.querySelector('.quickchat'), h: Math.round(head.getBoundingClientRect().height),
        drag: getComputedStyle(main).webkitAppRegion || getComputedStyle(main).getPropertyValue('-webkit-app-region'),
        gapDrag: gapEl ? (getComputedStyle(gapEl).webkitAppRegion || getComputedStyle(gapEl).getPropertyValue('-webkit-app-region')) : null,
        emptyW: gapEl ? Math.round(gapEl.getBoundingClientRect().width) : 0 }
      const foot = document.querySelector('.shell-statusbar').getBoundingClientRect()
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect()
      const gap = parseFloat(getComputedStyle(document.querySelector('.shell-statusbar')).columnGap) || 0
      return { win: window.innerWidth, quick: Math.round(q.width), startFree: Math.round(ar.width - need(a)), endFree: Math.round(br.width - need(b)),
        startNeed: need(a), endNeed: need(b), gap, header, footerH: Math.round(foot.height), boxH: Math.round(q.height),
        boxInFooter: q.top >= foot.top - 0.5 && q.bottom <= foot.bottom + 0.5,
        offCentre: Math.round((q.left + q.width / 2) - window.innerWidth / 2), overlap: q.left < ar.right - 1 || q.right > br.left + 1 }
    }))
    await page.screenshot(`${args.theme}-window-${w}`)
    // after the first width: one more inside the band where only the side
    // with fewer controls still has free space — the box slides there
    if (i === 0) {
      const m = sweep[0], d = Math.abs(m.endNeed - m.startNeed)
      const full = Math.ceil(960 + m.startNeed + m.endNeed + 2 * m.gap)
      if (d >= 4) widths.splice(1, 0, full + Math.floor(d / 2))
    }
  }
  // the Attention view keeps the same footer and Quick chat
  await page.resize('1600x900')
  await page.eval(() => document.querySelector('.shell-header button[role="switch"][aria-label="Attention view"]')?.click())
  await page.sleep(800)
  const attention = await page.eval(() => ({
    on: document.querySelector('.shell-header button[role="switch"][aria-label="Attention view"]')?.getAttribute('aria-checked'),
    quick: !!document.querySelector('.shell-statusbar .quickchat'),
    headerQuick: !!document.querySelector('.shell-header .quickchat'),
  }))
  await page.screenshot(`${args.theme}-attention-view-1600`)

  return { empty, typed, look, fadeIn, strip, fadeOut, gone, wander, topLevel, sweep, attention, lists, picked, chips, afterModel, count, withFiles, fileList, name, after, errors: page.consoleErrors }
}
