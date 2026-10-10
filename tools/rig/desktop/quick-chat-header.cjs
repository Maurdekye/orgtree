// quick-chat-header.mjs's desktop stage: an ORGANIZATION WINDOW of the v3
// shell (the rig has no desktop bridge, so a minimal one is planted before the
// page loads, identity kind "org", shaped like tests/shellbridge.tsx). In one contrast theme, at each width:
// a screenshot of the header with Quick chat, and where its parts sit. Then
// the superior menu against the Agents List, on Canvas and in Attention.
// args: { org, theme: 'charcoal' | 'light', widths: ['1920x1080', ...] }
module.exports = async (page, { args }) => {
  const bridge = `
  (() => {
    try { localStorage.setItem('orgtree-contrast-theme', ${JSON.stringify(args.theme)}) } catch {}
    const id = { windowId: 'rig-org', kind: 'org', org: ${JSON.stringify(args.org)} }
    // the shape the renderer's own shell suites use (tests/shellbridge.tsx):
    // listeners return an unsubscribe, reads return a value, and anything
    // else is simply absent, which every optional caller already handles
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
  await page.sleep(1500)
  const measure = () => page.eval(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right) } }
    const header = document.querySelector('.shell-header')
    const quick = document.querySelector('.shell-header-quick .quickchat')
    const start = [...document.querySelectorAll('.shell-header-start > *')].filter(e => e.getBoundingClientRect().width > 0)
    const end = [...document.querySelectorAll('.shell-header-end > *')].filter(e => e.getBoundingClientRect().width > 0)
    const h = r(header), q = r(quick)
    const startRight = Math.max(...start.map(e => r(e).r))
    const endLeft = Math.min(...end.map(e => r(e).l))
    return { header: h, quick: q, startRight, endLeft,
      centreOffset: Math.round((q.l + q.r) / 2 - (h.l + h.r) / 2),
      gapLeft: q.l - startRight, gapRight: endLeft - q.r,
      contrast: document.documentElement.dataset.contrastTheme ?? null,
      bg: getComputedStyle(header).backgroundColor }
  })
  const widths = {}
  for (const w of args.widths) {
    await page.resize(w)
    await page.sleep(800)
    widths[w] = await measure()
    await page.screenshot(`${args.theme}-canvas-${w}`)
  }
  const menuItems = async () => {
    await page.click('.quickchat-superior')
    await page.waitFor('.ctxmenu[role="menu"]')
    await page.sleep(300)
    const items = await page.eval(() => [...document.querySelectorAll('.ctxmenu[role="menu"] button.ctxmenu-item')]
      .map(b => (b.innerText || '').trim().replace(/ ✓$/, '')))
    return items
  }
  const closeMenu = async () => { await page.press('Escape'); await page.sleep(300) }
  // Canvas: the menu, then the Agents List (the tray)
  await page.resize(args.widths[0])
  const canvasMenu = await menuItems()
  await page.screenshot(`${args.theme}-canvas-superior-menu`)
  await closeMenu()
  await page.click('.tray-toggle')
  await page.waitFor('.tray .tray-row', { timeout: 10000 })
  await page.sleep(500)
  const rowsOf = () => page.eval(() => [...document.querySelectorAll('.tray .tray-row')]
    .filter(e => e.getBoundingClientRect().width > 0 && !/ghost/.test(e.className))
    .map(e => e.querySelector('[data-copy-agent-name]')?.getAttribute('data-copy-agent-name')
      ?? (e.innerText || '').trim().split(/\s+/)[1]))
  const canvasList = await rowsOf()
  await page.screenshot(`${args.theme}-canvas-agents-list`)
  await page.click('.tray-toggle')
  // Attention: the same header entry, then its agents drawer
  await page.click('.shell-switch')
  await page.sleep(1500)
  const attention = await measure()
  await page.screenshot(`${args.theme}-attention-${args.widths[0]}`)
  const attentionMenu = await menuItems()
  await page.screenshot(`${args.theme}-attention-superior-menu`)
  await closeMenu()
  const drawer = await page.eval(() => !!document.querySelector('[aria-label="Open the agents list"]'))
  if (drawer) { await page.click('[aria-label="Open the agents list"]'); await page.sleep(800) }
  const attentionList = await rowsOf()
  await page.screenshot(`${args.theme}-attention-agents-list`)
  return { widths, attention, canvasMenu, canvasList, attentionMenu, attentionList, drawer, errors: page.consoleErrors }
}
