// The effort bar on an agent's desk: rest, hover, drag, release.
// args: { agent: "<name>" }; saves <agent>-desk.png and returns what the card shows.
module.exports = async (page, { args }) => {
  const card = `[data-copy-agent-name="${args.agent}"]`
  await page.waitFor(card, { timeout: 30000 })
  await page.sleep(800)
  await page.rightClick(card)
  await page.waitFor('.ctxmenu[role="menu"]')
  await page.hover({ selector: 'button.ctxmenu-item', text: '^Open( ▸)?$', regex: true })
  await page.sleep(300)
  const items = await page.eval(() => [...document.querySelectorAll('.ctxmenu[role="menu"] button.ctxmenu-item')].map((b) => (b.innerText || '').trim()))
  const desk = items.find((t) => /desk/i.test(t))
  if (desk) await page.click({ selector: 'button.ctxmenu-item', text: `^${desk.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c)}$`, regex: true })
  const eff = '.cc-eff'
  await page.waitFor(eff, { timeout: 30000 })
  await page.click(eff)
  await page.waitFor('.eff-pop .effort-bar-track', { timeout: 10000 })
  const rect = () => page.eval(() => { const r = document.querySelector('.eff-pop .effort-bar-track').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width } })
  const label = () => page.eval(() => document.querySelector('.eff-pop .effort-bar-label')?.innerText)
  await page.sleep(600)
  const r0 = await rect()
  page.log('track', r0)
  await page.screenshot('effort-rest')
  const rest = await label()
  // hover between two dots: the label previews the level a click would pick
  await page.hover({ x: r0.x + r0.w * 0.72, y: r0.y })
  const hovered = await label()
  page.log('hovered', hovered, await page.eval(() => document.elementFromPoint(window.innerWidth/2, 10)?.className))
  await page.screenshot('effort-hover')
  // press near the left end and drag to the right: the pick follows live
  await page.mouse('mouseMoved', r0.x + r0.w * 0.1, r0.y)
  await page.mouse('mousePressed', r0.x + r0.w * 0.1, r0.y)
  await page.mouse('mouseMoved', r0.x + r0.w * 0.5, r0.y)
  await page.mouse('mouseMoved', r0.x + r0.w * 0.9, r0.y)
  const dragging = await label()
  await page.screenshot('effort-drag')
  await page.mouse('mouseReleased', r0.x + r0.w * 0.9, r0.y)
  await page.sleep(1500)
  const after = await page.eval(() => document.querySelector('.cc-eff')?.innerText)
  return { rest, hovered, dragging, after }
}
