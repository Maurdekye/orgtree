// Page script for attnmention-visual.mjs (tools/rig/desktop driver): the
// Attention list with @user mention rows beside mail rows, at a narrow list
// column and at the widest one (340px), dark and light. Full frames at 1x plus
// 2x close-ups of the list; metrics are returned for the runner to check, so
// the same script also records a base.
const fs = require('node:fs'), path = require('node:path')
const W = 980, H = 620
const WIDTHS = { narrow: 220, wide: 340 }
module.exports = async (page, { out }) => {
  const paint = () => page.eval(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await new Promise(r => setTimeout(r, 120)) })
  const park = async () => { await page.mouse('mouseMoved', W - 4, H - 4); await paint() }
  const listWidth = async px => {
    await page.eval(px => {
      let s = document.getElementById('list-width')
      if (!s) { s = document.createElement('style'); s.id = 'list-width'; document.head.appendChild(s) }
      s.textContent = `.attn-mlist{width:${px}px;min-width:${px}px;max-width:${px}px}body{margin:0;background:var(--bg);color:var(--ink)}`
    }, px)
    await paint()
  }
  const metrics = () => page.eval(() => {
    const rect = e => { const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } }
    const textLines = e => {
      const range = document.createRange(); range.selectNodeContents(e)
      const tops = [...range.getClientRects()].filter(r => r.width > 0.5).map(r => r.top).sort((a, b) => a - b)
      return tops.reduce((n, t, i) => n + (i === 0 || t - tops[i - 1] > 3 ? 1 : 0), 0)
    }
    const rows = [...document.querySelectorAll('.attn-mlist [data-attn-kind]')].map(cell => {
      const row = cell.firstElementChild
      const part = sel => { const e = row.querySelector(sel); return e ? { ...rect(e), text: e.textContent, textLines: textLines(e), cls: e.className, clipped: e.scrollWidth > e.clientWidth + 0.5 } : null }
      return {
        kind: cell.getAttribute('data-attn-kind'), cls: row.className, box: rect(row),
        lines: [...row.children].map(c => ({ cls: c.className, ...rect(c), textLines: textLines(c), kids: [...c.children].map(k => k.className) })),
        from: part('.mfrom, .mr-party'), time: part('.mtime'),
        chips: [...row.querySelectorAll('.mentionkind, .urgentkind, .event-row-kind, .askkind, .badge')].map(e => ({ ...rect(e), cls: e.className, text: e.textContent, textLines: textLines(e) })),
        preview: part('.l2 .mail-preview-text') ?? part('.attn-mention-blurb'), token: part('.attn-mention-token'),
      }
    })
    return { list: rect(document.querySelector('.attn-mlist')), rows }
  })
  const closeup = async (name) => {
    const box = await page.eval(() => { const l = document.querySelector('.attn-mlist').getBoundingClientRect(); return { x: l.x, y: l.y, w: l.width, h: l.height } })
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false, screenWidth: W, screenHeight: H }); await paint()
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.w + 16, height: Math.min(box.h + 16, 420), scale: 1 } })
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'))
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false, screenWidth: W, screenHeight: H }); await paint()
  }
  await page.resize(`${W}x${H}`)
  // the cells are `display: contents` (no box to locate): wait for the rows in them
  await page.waitFor('[data-attn-kind="mention"] > *')
  await page.waitFor('[data-attn-kind="mail"] > *')
  const results = {}
  for (const theme of ['dark', 'light']) {
    await page.eval(light => document.documentElement.classList.toggle('contrast-light', light), theme === 'light')
    for (const [size, px] of Object.entries(WIDTHS)) {
      await listWidth(px); await park()
      const name = `${theme}-attention-${size}`
      results[name] = await metrics()
      await page.screenshot(name); await closeup(name + '-2x')
    }
  }
  return results
}
