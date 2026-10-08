// Time from the click on a hire draft's cancel button to the camera moving back.
// Hire a subordinate under boss, let the draft settle, click cancel, and read the
// `.space` transform every frame. args: { runs?: 3 }
module.exports = async (page, { args }) => {
  const runs = (args && args.runs) || 3
  const results = []
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 30000 })
  await page.sleep(1500)
  for (let i = 0; i < runs; i++) {
    const before = await page.eval(() => document.querySelector('.space').style.transform)
    await page.rightClick('[data-copy-agent-name="boss"]')
    await page.waitFor('.ctxmenu[role="menu"]')
    await page.hover({ selector: 'button.ctxmenu-item', text: '^Hire a subordinate( ▸)?$', regex: true })
    await page.sleep(400)
    const items = await page.eval(() => [...document.querySelectorAll('.ctxmenu button.ctxmenu-item')].map((b) => b.innerText.trim()))
    await page.click({ selector: '.ctxmenu button.ctxmenu-item', text: '^haiku$', regex: true })
    await page.waitFor('.sq.draft', { timeout: 10000 })
    await page.sleep(2500)
    const drafted = await page.eval(() => document.querySelector('.space').style.transform)
    await page.eval(() => {
      const num = (s) => (s.match(/-?[\d.]+/g) || []).map(Number)
      const log = window.__cancelLog = { t0: null, frames: [] }
      document.addEventListener('click', (e) => { if (log.t0 === null && e.target.closest('button') && /cancel/.test(e.target.closest('button').innerText)) log.t0 = performance.now() }, true)
      const tick = () => { if (log.gone == null && log.t0 !== null && !document.querySelector('.sq.draft')) log.gone = performance.now(); log.frames.push([performance.now(), num(document.querySelector('.space').style.transform)]); if (log.frames.length < 600) requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
    })
    await page.click({ selector: '.sq.draft button', text: 'cancel' })
    await page.sleep(3000)
    const r = await page.eval(() => {
      const { t0, frames } = window.__cancelLog
      const f0 = frames.filter((f) => f[0] <= t0).pop() || frames[0]
      const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] - b[2]) * 500)
      const last = frames[frames.length - 1][1]
      const moved = frames.find((f) => f[0] > t0 && dist(f[1], f0[1]) > 1)
      const arrived = frames.find((f) => f[0] > t0 && dist(f[1], last) < 1)
      return { firstMoveMs: moved ? Math.round(moved[0] - t0) : null, arrivedMs: arrived ? Math.round(arrived[0] - t0) : null,
        draftGoneMs: window.__cancelLog.gone ? Math.round(window.__cancelLog.gone - t0) : null, final: last, hasDraft: !!document.querySelector('.sq.draft') }
    })
    results.push({ run: i + 1, before, drafted, items, ...r })
    await page.sleep(500)
  }
  return results
}
