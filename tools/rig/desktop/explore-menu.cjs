// Right-click boss's card and describe the menu that opens.
module.exports = async (page) => {
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 30000 })
  await page.sleep(800)
  const card = await page.rightClick('[data-copy-agent-name="boss"]')
  await page.sleep(500)
  await page.screenshot('menu')
  const menu = await page.eval(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const roots = [...document.querySelectorAll('[role="menu"], .ctxmenu, .ctx-menu, .menu')].filter(vis)
    return roots.map((r) => ({ cls: String(r.className), role: r.getAttribute('role'),
      items: [...r.querySelectorAll('[role="menuitem"], button, li, div')].filter(vis).slice(0, 60)
        .map((e) => ({ tag: e.tagName, cls: String(e.className).slice(0, 60), role: e.getAttribute('role'), text: (e.innerText || '').trim().split('\n')[0].slice(0, 40) })) }))
  })
  return { card, menu }
}
