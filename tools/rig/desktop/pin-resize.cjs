// A pinned window flush against each edge of the canvas, its handle dragged 100 px outward: the size and the
// opposite side must not change. Plus a normal resize away from the edges (the window grows) and an inward drag.
// args: { org, agent }. Returns per-case measurements; saves a screenshot per case.
module.exports = async (page, { args }) => {
  const slug = args.org, id = args.agent
  const key = `orgtree-pins-${slug}`
  const out = {}
  const W = 520, H = 360
  const seed = (rect) => page.eval((k, i, r) => {
    localStorage.setItem(k, JSON.stringify([{ id: i, rect: r, z: 0, snap: null }]))
  }, key, id, rect)
  const box = () => page.eval((i) => {
    const el = document.querySelector(`.pinwin[data-id="${i}"]`)
    if (!el) return null
    const p = el.closest('.pin-layer').parentElement.getBoundingClientRect(), r = el.getBoundingClientRect()
    return { x: r.left - p.left, y: r.top - p.top, w: r.width, h: r.height, vw: p.width, vh: p.height, left: r.left, top: r.top }
  }, id)
  const load = async (rectFn) => {
    await page.goto(`/o/${slug}`)
    await page.waitFor('body', { timeout: 30000 })
    await page.sleep(1500)
    // find the viewport size from a throwaway read: seed a rect, load, measure
    await seed({ x: 100, y: 100, w: W, h: H })
    await page.goto(`/o/${slug}`)
    await page.waitFor(`.pinwin[data-id="${id}"]`, { timeout: 60000 })
    await page.sleep(800)
    const b = await box()
    await seed(rectFn(b))
    await page.goto(`/o/${slug}`)
    await page.waitFor(`.pinwin[data-id="${id}"]`, { timeout: 60000 })
    await page.sleep(1000)
    return box()
  }
  const drag = async (edge, dx, dy, name) => {
    const h = await page.eval((i, e) => {
      const el = document.querySelector(`.pinwin-resize-frame[data-id="${i}"] .pinwin-rs.${e}`)
      const r = el.getBoundingClientRect(); const c = e.length === 2  // a corner handle pokes out of the window: aim at the part inside it
      const x = !c ? r.left + r.width / 2 : e.includes('e') ? r.left + 3 : r.right - 3
      const y = !c ? r.top + r.height / 2 : e.includes('s') ? r.top + 3 : r.bottom - 3; const t = document.elementFromPoint(x, y); return { x, y, hit: t ? t.className : null }
    }, id, edge)
    page.log('handle', edge, JSON.stringify(h))
    await page.mouse('mouseMoved', h.x, h.y)
    await page.sleep(80)
    await page.mouse('mousePressed', h.x, h.y)
    for (let s = 1; s <= 5; s++) { await page.mouse('mouseMoved', h.x + dx * s / 5, h.y + dy * s / 5); await page.sleep(40) }
    const mid = await box()
    await page.screenshot(name)
    await page.mouse('mouseReleased', h.x + dx, h.y + dy)
    await page.sleep(600)
    return { mid, end: await box() }
  }
  const same = (a, b) => ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) < 1.5)
  const cases = [
    ['s', (b) => ({ x: (b.vw - W) / 2, y: b.vh - H, w: W, h: H }), 0, 100],
    ['n', (b) => ({ x: (b.vw - W) / 2, y: 0, w: W, h: H }), 0, -100],
    ['e', (b) => ({ x: b.vw - W, y: (b.vh - H) / 2, w: W, h: H }), 100, 0],
    ['w', (b) => ({ x: 0, y: (b.vh - H) / 2, w: W, h: H }), -100, 0],
    ['se', (b) => ({ x: b.vw - W, y: b.vh - H, w: W, h: H }), 100, 100],
    ['nw', (b) => ({ x: 0, y: 0, w: W, h: H }), -100, -100],
  ]
  for (const [edge, rectFn, dx, dy] of cases) {
    const before = await load(rectFn)
    const r = await drag(edge, dx, dy, `edge-${edge}`)
    out[edge] = { before, mid: r.mid, end: r.end, unchanged: same(before, r.mid) && same(before, r.end) }
  }
  // inward from a flush side shrinks normally, the opposite side stays put
  {
    const before = await load((b) => ({ x: (b.vw - W) / 2, y: b.vh - H, w: W, h: H }))
    const r = await drag('s', 0, -80, 'inward-s')
    out.inwardS = { before, end: r.end, shrank: Math.abs((before.h - r.end.h) - 80) < 3 && Math.abs(before.y - r.end.y) < 1.5 }
  }
  // away from the edges the window grows from the dragged side
  {
    const before = await load(() => ({ x: 200, y: 120, w: W, h: H }))
    const r = await drag('se', 60, 60, 'normal-se')
    out.normal = { before, end: r.end, grew: Math.abs(r.end.w - before.w - 60) < 3 && Math.abs(r.end.h - before.h - 60) < 3 && Math.abs(r.end.x - before.x) < 1.5 }
  }
  return out
}
