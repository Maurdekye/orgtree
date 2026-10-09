// Open "Usage history…" from the Orgtree menu and screenshot the panel.
// args: { shots: [{ name, range?, account?, hover? }] } — each shot optionally
// picks a period button, an account filter value, and hovers a chart.
module.exports = async (page, { args }) => {
  await page.waitFor('.shell-menu-button', { timeout: 30000 })
  await page.sleep(800)
  await page.click('.shell-menu-button')
  await page.waitFor({ selector: '[role="menuitem"]', text: 'Usage history…' })
  const menu = await page.eval(() => [...document.querySelectorAll('.shell-menu-panel [role="menuitem"]')]
    .map((e) => (e.innerText || '').trim().split('\n')[0]))
  await page.click({ selector: '[role="menuitem"]', text: 'Usage history…' })
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
      text: (document.querySelector('.usage-history-modal')?.innerText || '').replace(/\s+/g, ' ').slice(0, 1500),
      cards: document.querySelectorAll('.uh-card').length,
      accounts: document.querySelectorAll('.uh-account').length,
      lines: document.querySelectorAll('.uh-line').length,
      projections: document.querySelectorAll('.uh-proj').length,
      resets: document.querySelectorAll('.uh-reset').length,
      nextResets: document.querySelectorAll('.uh-next-reset').length,
      down: document.querySelectorAll('.uh-down').length,
      tip: document.querySelector('.uh-tip')?.innerText ?? null,
    })))
  }
  out.consoleErrors = page.consoleErrors
  return out
}
