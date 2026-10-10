// quick-chat-positions.mjs's first desktop stage: App settings › Display ›
// Quick chat position (Top by default, Bottom, None), chosen in the settings
// panel itself, applied live, kept across a reload. For each position, at each
// width: where the box is, the header's drag region, the footer's height, and
// which way the model picker opens. args: { org, theme, widths: [1600, ...] }
module.exports = async (page, { args }) => {
  const bridge = `
  (() => {
    try { localStorage.setItem('orgtree-contrast-theme', ${JSON.stringify(args.theme)}) } catch {}
    // a clean slate once per proof (not on the reload that proves persistence)
    try { if (!sessionStorage.getItem('qc-positions-init')) { localStorage.removeItem('orgtree-quickchat-position'); sessionStorage.setItem('qc-positions-init', '1') } } catch {}
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
  await page.resize('1600x900')
  await page.goto(`/o/${args.org}`)
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 30000 })
  await page.sleep(1500)

  // where the box is, and what the header leaves for dragging the window
  const where = () => page.eval(() => {
    const reg = (el) => el ? (getComputedStyle(el).webkitAppRegion || getComputedStyle(el).getPropertyValue('-webkit-app-region')) : null
    const need = (el) => {
      const cs = getComputedStyle(el), kids = [...el.children]
      return kids.reduce((n, k) => n + k.getBoundingClientRect().width, 0) + (parseFloat(cs.columnGap) || 0) * Math.max(0, kids.length - 1)
        + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
    }
    const box = document.querySelector('[data-testid="quickchat"]')
    const head = document.querySelector('.shell-header'), foot = document.querySelector('.shell-statusbar')
    const start = head.querySelector('.shell-header-start'), end = head.querySelector('.shell-header-end')
    const gap = head.querySelector('.shell-header-gap')
    // the header's empty, draggable stretch: the sides' free space when the
    // box is centred in it, else the gap between title and actions
    const drag = start
      ? { regions: [reg(start), reg(end)], emptyW: Math.round(start.getBoundingClientRect().width - need(start) + end.getBoundingClientRect().width - need(end)) }
      : { regions: [reg(head.querySelector('.shell-header-main')), reg(gap)], emptyW: Math.round(gap ? gap.getBoundingClientRect().width : 0) }
    // ...and ALL of the header a pointer can drag the window by: its width less
    // every outermost control that opts out (buttons, the box, the switch)
    const outs = [...head.querySelectorAll('*')].filter((el) => reg(el) === 'no-drag' && reg(el.parentElement) !== 'no-drag')
    drag.draggableW = Math.round(head.getBoundingClientRect().width - outs.reduce((n, el) => n + el.getBoundingClientRect().width, 0))
    const q = box?.getBoundingClientRect()
    return {
      win: window.innerWidth,
      at: !box ? 'none' : box.closest('header') ? 'top' : box.closest('footer') ? 'bottom' : 'elsewhere',
      boxW: q ? Math.round(q.width) : null,
      inputRegion: box ? reg(box.querySelector('input')) : null,
      headerH: Math.round(head.getBoundingClientRect().height),
      footerH: Math.round(foot.getBoundingClientRect().height),
      drag,
    }
  })
  const out = { initial: await where() }

  // the setting, in App settings › Display
  const choose = async (v) => {
    await page.eval(() => window.dispatchEvent(new window.CustomEvent('orgtree:open-app-settings', { detail: { tab: 'display' } })))
    await page.waitFor('select[aria-label="Quick chat position"]', { timeout: 15000 })
    await page.sleep(400)
    const row = await page.eval((v) => {
      const sel = document.querySelector('select[aria-label="Quick chat position"]')
      const before = sel.value
      const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      set.call(sel, v)
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return { before, options: [...sel.options].map((o) => o.value + '=' + o.textContent) }
    }, v)
    await page.sleep(400)
    row.after = await page.eval(() => document.querySelector('select[aria-label="Quick chat position"]').value)
    row.hint = await page.eval(() => document.querySelector('select[aria-label="Quick chat position"]').closest('.set-row')?.innerText ?? '')
    await page.eval(() => document.querySelector('select[aria-label="Quick chat position"]').scrollIntoView({ block: 'center' }))
    await page.sleep(200)
    await page.screenshot(`${args.theme}-settings-display-${v}`)
    await page.press('Escape')
    await page.sleep(500)
    return row
  }

  out.positions = {}
  for (const pos of ['top', 'bottom', 'none']) {
    const row = await choose(pos)
    const widths = []
    for (const w of args.widths) {
      await page.resize(`${w}x900`)
      await page.sleep(400)
      widths.push(await where())
      await page.screenshot(`${args.theme}-${pos}-${w}`)
    }
    await page.resize('1600x900')
    await page.sleep(400)
    let picker = null
    if (pos !== 'none') {
      await page.eval(() => document.querySelector('[data-testid="quickchat"] .quickchat-model').click())
      await page.waitFor('.quickchat-pop.quickchat-pop-model .hsof button', { timeout: 10000 })
      await page.sleep(300)
      picker = await page.eval(() => {
        const pop = document.querySelector('.quickchat-pop.quickchat-pop-model').getBoundingClientRect()
        const bar = document.querySelector('[data-testid="quickchat"]').closest('header, footer').getBoundingClientRect()
        return { popTop: Math.round(pop.top), popBottom: Math.round(pop.bottom), barTop: Math.round(bar.top), barBottom: Math.round(bar.bottom), vh: window.innerHeight }
      })
      await page.screenshot(`${args.theme}-${pos}-model-picker`)
      await page.press('Escape')
      await page.sleep(400)
    }
    out.positions[pos] = { row, widths, picker }
  }

  // kept: Bottom survives a reload (the setting is app-wide, in localStorage)
  await choose('bottom')
  await page.goto(`/o/${args.org}`)
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 30000 })
  await page.sleep(1500)
  out.afterReload = await where()
  // and back to the default for whatever runs next
  await choose('top')
  return { ...out, errors: page.consoleErrors }
}
