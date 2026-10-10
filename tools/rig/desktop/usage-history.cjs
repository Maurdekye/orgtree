// Open the usage history panel (browser header button) and screenshot it.
// args: { shots: [{ name, range?, account?, hover? }] } — each shot optionally
// picks a period button, an account filter value, and hovers a chart.
module.exports = async (page, { args }) => {
  // the v3 shell's Orgtree menu needs the native bridge; a rig browser gets
  // the browser header, whose door is the button beside Usage
  await page.waitFor('.usage-history-btn', { timeout: 30000 })
  await page.sleep(800)
  const menu = null
  await page.click('.usage-history-btn')
  await page.waitFor('.usage-history-modal', { timeout: 15000 })
  await page.sleep(1500)
  const out = { menu, shots: [] }
  for (const shot of args.shots ?? [{ name: 'panel' }]) {
    if (shot.range) {
      await page.click({ selector: '.uh-range', text: shot.range })
      await page.sleep(1200)
    }
    if (shot.account !== undefined) {
      await page.eval((v) => {
        const sel = [...document.querySelectorAll('.uh-filter select')][1]
        const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        set.call(sel, v)
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      }, shot.account)
      await page.sleep(600)
    }
    if (shot.hover) {
      // a point a share of the way across the first chart
      const box = await page.eval((share) => {
        const svg = document.querySelector('.uh-plot svg')
        const r = svg.getBoundingClientRect()
        return { x: r.left + 44 + (r.width - 56) * share, y: r.top + r.height / 2 }
      }, shot.hover)
      await page.eval(({ x, y }) => {
        const svg = document.querySelector('.uh-plot svg')
        svg.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
      }, box)
      await page.sleep(400)
    }
    await page.screenshot(shot.name)
    out.shots.push(await page.eval(() => ({
      text: (document.querySelector('.usage-history-modal')?.innerText || '').replace(/\s+/g, ' ').slice(0, 8000),
      cards: document.querySelectorAll('.uh-card').length,
      accounts: document.querySelectorAll('.uh-account').length,
      lines: document.querySelectorAll('.uh-line').length,
      projections: document.querySelectorAll('.uh-proj').length,
      resets: document.querySelectorAll('.uh-reset').length,
      nextResets: document.querySelectorAll('.uh-next-reset').length,
      // the hatched unavailable band is gone (user 2026-10-10)
      hatch: document.querySelectorAll('.uh-down, .uh-plot pattern').length,
      heads: [...document.querySelectorAll('.uh-account-head')].map((h) => h.innerText.replace(/\s+/g, ' ')),
      tip: document.querySelector('.uh-tip')?.innerText ?? null,
    })))
  }
  out.consoleErrors = page.consoleErrors
  return out
}
