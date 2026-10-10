// A pinned PANEL (the work docket) resized against the canvas edges: pin it, shrink it off the edge, then drag a
// handle far past the edge. The dragged side must stop at the edge and the opposite side must not move.
module.exports = async (page, { args }) => {
  const out = {}
  await page.waitFor('[data-first-use-agent="alice"]', { timeout: 60000 })
  await page.sleep(1500)
  const labels = await page.eval(() => [...document.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.title || '').trim()).filter(Boolean))
  page.log('buttons', JSON.stringify(labels))
  const opened = await page.eval(() => {
    const b = [...document.querySelectorAll('button')].find(x => /docket/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.title || '')))
    if (b) { b.click(); return true }
    return false
  })
  if (!opened) throw new Error('no docket button; labels: ' + JSON.stringify(labels))
  await page.waitFor('.docket-modal', { timeout: 20000 })
  await page.sleep(800)
  await page.click('.modalpin-btn')
  await page.waitFor('.modalpin-win', { timeout: 10000 })
  await page.sleep(800)
  const box = () => page.eval(() => {
    const el = document.querySelector('.modalpin-win')
    const c = document.querySelector('[data-pin-org]').getBoundingClientRect(), r = el.getBoundingClientRect()
    return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height, cw: c.width, ch: c.height }
  })
  const drag = async (edge, dx, dy, name) => {
    const h = await page.eval((e) => {
      const r = document.querySelector('.modalpin-rs.' + e).getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, edge)
    await page.mouse('mouseMoved', h.x, h.y); await page.sleep(80)
    await page.mouse('mousePressed', h.x, h.y)
    for (let s = 1; s <= 8; s++) { await page.mouse('mouseMoved', h.x + dx * s / 8, h.y + dy * s / 8); await page.sleep(40) }
    const mid = await box()
    if (name) await page.screenshot(name)
    await page.mouse('mouseReleased', h.x + dx, h.y + dy); await page.sleep(500)
    return { mid, end: await box() }
  }
  const start = await box()
  out.start = start
  // free room on every side: shrink from the east and south, then move the panel into the middle by its title bar
  await drag('e', -500, 0); await drag('s', 0, -300)
  let b = await box()
  const bar = await page.eval(() => { const r = document.querySelector('.modalpin-bar').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 } })
  await page.mouse('mouseMoved', bar.x, bar.y); await page.mouse('mousePressed', bar.x, bar.y)
  await page.mouse('mouseMoved', bar.x + 120, bar.y + 120); await page.mouse('mouseMoved', bar.x + 250, bar.y + 200)
  await page.mouse('mouseReleased', bar.x + 250, bar.y + 200); await page.sleep(500)
  b = await box()
  out.placed = b
  const cases = [['s', 0, 1200], ['e', 1600, 0], ['n', 0, -1200], ['w', -1600, 0]]
  for (const [edge, dx, dy] of cases) {
    const before = await box()
    const r = await drag(edge, dx, dy, 'modal-' + edge)
    const f = r.end, m = r.mid
    const fixedOpposite = (g) => edge === 's' ? Math.abs(g.y - before.y) < 1.5
      : edge === 'n' ? Math.abs(g.y + g.h - before.y - before.h) < 1.5
      : edge === 'e' ? Math.abs(g.x - before.x) < 1.5 : Math.abs(g.x + g.w - before.x - before.w) < 1.5
    const atEdge = (g) => edge === 's' ? Math.abs(g.y + g.h - g.ch) < 1.5 : edge === 'n' ? Math.abs(g.y) < 1.5
      : edge === 'e' ? Math.abs(g.x + g.w - g.cw) < 1.5 : Math.abs(g.x) < 1.5
    out[edge] = { before, mid: m, end: f, oppositeFixed: fixedOpposite(m) && fixedOpposite(f), stopsAtEdge: atEdge(m) && atEdge(f) }
    // put it back off the edge for the next case: shrink inward by dragging the same handle back
    await drag(edge, -dx, -dy)
    const s = await drag(edge, edge === 's' ? 0 : edge === 'n' ? 0 : 0, 0)
    void s
  }
  return out
}
