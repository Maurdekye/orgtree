// Far zoom: hovering a small card reveals its name; the long name must show in full (no ellipsis).
module.exports = async (page, { args }) => {
  const r = {}
  await page.waitFor('[data-first-use-agent="alice"]', { timeout: 60000 })
  await page.sleep(1500)
  for (let i = 0; i < 12; i++) {
    if (await page.eval(() => !!document.querySelector('.sq.mini'))) break
    await page.eval(() => { const b = [...document.querySelectorAll('button')].find(x => /zoom out/i.test((x.getAttribute('aria-label') || '') + (x.title || ''))); b?.click() })
    await page.sleep(500)
  }
  r.farZoom = await page.eval(() => !!document.querySelector('.sq.mini'))
  await page.sleep(800)
  const card = `.sq.mini[data-copy-agent-name="${args.agent}"]`
  await page.waitFor(card, { timeout: 15000 })
  await page.hover(card)
  await page.sleep(700)
  const m = await page.eval((a) => {
    const n = document.querySelector(`.sq.mini[data-copy-agent-name="${a}"] .sq-far-name`)
    return n ? { text: n.textContent, client: n.clientWidth, scroll: n.scrollWidth } : null
  }, args.agent)
  page.log('name', JSON.stringify(m))
  r.nameShownInFull = !!m && m.text === args.agent && m.scroll <= m.client + 1
  await page.screenshot('hover-name')
  r.detail = m
  return r
}
