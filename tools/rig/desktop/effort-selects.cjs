// The three effort controls that used to be dropdowns, now the effort bar: org default
// (App settings > Default org settings), agent settings, and the hire sheet.
// args: { org, theme: 'charcoal' | 'light', agent }
module.exports = async (page, { args }) => {
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('orgtree-contrast-theme', ${JSON.stringify(args.theme)}) } catch {}` })
  await page.goto(`/o/${args.org}`)
  await page.waitFor(`[data-copy-agent-name="${args.agent}"]`, { timeout: 40000 })
  await page.sleep(1500)
  const out = { theme: args.theme }
  const bars = () => page.eval(() => [...document.querySelectorAll('.effort-bar')].reverse().map((b) => ({
    label: b.querySelector('.effort-bar-label')?.innerText, pinned: b.querySelector('.effort-bar-track')?.dataset.effortPinned, value: b.querySelector('.effort-bar-track')?.getAttribute('aria-valuetext') })))
  // 1. agent settings
  await page.rightClick(`[data-copy-agent-name="${args.agent}"]`)
  await page.waitFor('.ctxmenu[role="menu"]')
  await page.hover({ selector: 'button.ctxmenu-item', text: '^Open( ▸)?$', regex: true })
  await page.sleep(300)
  const items = await page.eval(() => [...document.querySelectorAll('.ctxmenu[role="menu"] button.ctxmenu-item')].map((b) => (b.innerText || '').trim()))
  out.menu = items
  const desk = items.find((t) => /desk/i.test(t))
  if (desk) await page.click({ selector: 'button.ctxmenu-item', text: '^' + desk.replace(/[^A-Za-z0-9 ]/g, '.') + '$', regex: true })
  await page.waitFor(`button[aria-label="settings for ${args.agent}"]`, { timeout: 30000 })
  await page.click(`button[aria-label="settings for ${args.agent}"]`)
  await page.waitFor('[role="tab"]', { timeout: 20000 })
  await page.click({ selector: '[role="tab"]', text: '^Model$', regex: true })
  await page.sleep(800)
  await page.eval(() => [...document.querySelectorAll('.effort-bar')].pop()?.scrollIntoView({ block: 'center' }))
  await page.sleep(300)
  await page.screenshot('agent-settings-rest')
  out.agentRest = await bars()
  // hover must not move the pip
  const pipX = () => page.eval(() => { const p = [...document.querySelectorAll('.effort-bar-pip')].pop(); return p ? Math.round(p.getBoundingClientRect().left) : null })
  const hb = await page.eval(() => { const t = [...document.querySelectorAll('.effort-bar-track')].pop(); const b = t.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width } })
  out.pipBefore = await pipX()
  await page.hover({ x: hb.x + hb.w * 0.95, y: hb.y })
  await page.sleep(400)
  out.pipHover = await pipX()
  await page.screenshot('agent-settings-hover')
  // click a level anywhere along the bar (between dots): selects the nearest
  const r = await page.eval(() => { const t = [...document.querySelectorAll('.effort-bar-track')].pop(); const b = t.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width } })
  await page.click({ x: r.x + r.w * 0.8, y: r.y })
  out.agentAfterClick = await bars()
  await page.screenshot('agent-settings-set')
  // clicking the selected level clears it back to inherit
  await page.click({ x: r.x + r.w * 0.8, y: r.y })
  out.agentAfterClear = await bars()
  await page.screenshot('agent-settings-cleared')
  await page.press('Escape')
  // 2. org default in App settings
  await page.sleep(500)
  await page.eval(() => window.dispatchEvent(new window.CustomEvent('orgtree:open-app-settings', { detail: { tab: 'providers' } })))
  await page.sleep(1500)
  try {
    await page.click({ selector: '[role="tab"]', text: '^Default org settings$', regex: true })
    await page.sleep(1500)
    await page.waitFor('.effort-bar', { timeout: 15000 })
    await page.eval(() => [...document.querySelectorAll('.effort-bar')].pop()?.scrollIntoView({ block: 'center' }))
    await page.screenshot('org-default')
    out.orgDefault = await bars()
  } catch (e) { out.orgDefault = String(e.message).slice(0, 150) }
  return out
}
