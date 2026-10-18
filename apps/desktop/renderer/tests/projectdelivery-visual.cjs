// Page script for projectdelivery-visual.mjs (tools/rig/desktop driver): four
// mailboxes (a project's inbox, an agent's Sent, the user's Sent and an
// ordinary agent inbox) at a narrow list column and at the widest one the
// layout allows (340px), dark and light. Full frames at 1x plus 2x close-ups
// of the list; metrics are returned for the runner to check, so the same
// script also records a base.
const fs = require('node:fs'), path = require('node:path')
const W = 980, H = 640
const WIDTHS = { narrow: 220, wide: 340 }
const SURFACES = ['project', 'agent-sent', 'user-sent', 'inbox']
module.exports = async (page, { out }) => {
  const paint = () => page.eval(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await new Promise(r => setTimeout(r, 120)) })
  // the pointer rests outside the list, so no hover state leaks into a frame
  const park = async () => { await page.mouse('mouseMoved', W - 4, H - 4); await paint() }
  const set = async m => { await page.eval(m => window.__rows.set(m), m); await paint() }
  const listWidth = async px => {
    await page.eval(px => {
      let s = document.getElementById('list-width')
      if (!s) { s = document.createElement('style'); s.id = 'list-width'; document.head.appendChild(s) }
      s.textContent = `.mailer-list{width:${px}px;min-width:${px}px;max-width:${px}px}body{margin:0;background:var(--bg);color:var(--ink)}`
    }, px)
    await paint()
  }
  const metrics = () => page.eval(() => {
    const rect = e => { const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } }
    // how many lines an element's own text occupies (a wrapped name is > 1)
    const textLines = e => {
      const range = document.createRange(); range.selectNodeContents(e)
      const tops = [...range.getClientRects()].filter(r => r.width > 0.5).map(r => r.top).sort((a, b) => a - b)
      return tops.reduce((n, t, i) => n + (i === 0 || t - tops[i - 1] > 3 ? 1 : 0), 0)
    }
    const part = (row, sel) => {
      const e = row.querySelector(sel); if (!e) return null
      const s = getComputedStyle(e)
      return { ...rect(e), text: e.textContent, textLines: textLines(e), clipped: e.scrollWidth > e.clientWidth + 0.5,
        ellipsis: s.textOverflow === 'ellipsis', line: [...row.children].findIndex(c => c.contains(e)), cls: e.className }
    }
    const rows = [...document.querySelectorAll('.mailrow')].map(row => {
      const s = getComputedStyle(row), r = row.getBoundingClientRect()
      const left = r.x + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft), right = r.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight)
      const chips = [...row.querySelectorAll('.event-row-kind, .askkind, .noticekind, .urgentkind, .queuekind, .mail-tag')].map(e => ({ ...rect(e), cls: e.className, text: e.textContent, textLines: textLines(e) }))
      return {
        cls: row.className, box: rect(row), content: { left: +left.toFixed(2), right: +right.toFixed(2) },
        lines: [...row.children].map(c => ({ cls: c.className, ...rect(c), textLines: textLines(c) })),
        from: part(row, '.mfrom'), sender: part(row, '.mfrom .cc-name') ?? part(row, '.mfrom > span'),
        time: part(row, '.mtime'), kind: part(row, '.event-row-kind'), urgent: part(row, '.urgentkind'),
        queue: part(row, '.queuekind'), recipient: part(row, '.queue-delivery .cc-name'), preview: part(row, '.l2'), chips,
      }
    })
    const head = document.querySelector('.mailer-head')
    return {
      list: rect(document.querySelector('.mailer-list')), rows,
      head: head ? { ...rect(head), recipient: (() => { const e = head.querySelector('.queue-delivery .cc-name'); return e ? { ...rect(e), textLines: textLines(e), text: e.textContent } : null })() } : null,
    }
  })
  const closeup = async (name) => {
    const box = await page.eval(() => { const m = document.querySelector('.mailer').getBoundingClientRect(), l = document.querySelector('.mailer-list').getBoundingClientRect(); return { x: m.x, y: m.y, w: l.width, h: m.height } })
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false, screenWidth: W, screenHeight: H }); await paint()
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.w + 16, height: Math.min(box.h + 16, H - box.y), scale: 1 } })
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'))
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false, screenWidth: W, screenHeight: H }); await paint()
  }
  await page.resize(`${W}x${H}`)
  await page.waitFor('.mailrow')
  const results = {}
  for (const theme of ['dark', 'light']) {
    await page.eval(light => document.documentElement.classList.toggle('contrast-light', light), theme === 'light')
    for (const [size, px] of Object.entries(WIDTHS)) {
      await listWidth(px)
      for (const surface of SURFACES) {
        await set({ surface }); await park()
        const name = `${theme}-${surface}-${size}`
        results[name] = await metrics()
        await page.screenshot(name); await closeup(name + '-2x')
      }
      // a selected project mail: the reading pane's header shares the marker
      await set({ surface: 'project' })
      await page.eval(() => [...document.querySelectorAll('.mailrow')].find(r => r.querySelector('.mfrom')?.textContent.includes('hubchat-jumplist-sol')).querySelector('.l2').click())
      await park()
      const name = `${theme}-project-${size}-selected`
      results[name] = await metrics()
      await page.screenshot(name)
      await page.eval(() => document.querySelector('.mailrow.on .l2').click()); await paint()
    }
  }
  return results
}
