// Rainbow mode with a popped-out surface: sample the hue the popout actually
// paints (every write to its root style) and report jumps/reversals.
module.exports = async (page, { args }) => {
  const card = '[data-first-use-agent="rhea"]'
  await page.eval(() => {
    localStorage.setItem('orgtree-visual-theme', 'custom:#3a8fd9')
    localStorage.setItem('orgtree-rainbow-theme', JSON.stringify({ revealed: true, enabled: true, epoch: Date.now() }))
  })
  await page.eval(() => location.reload()); await page.sleep(1500)
  await page.waitFor(card)
  await page.rightClick(card)
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor('button[aria-label="Open in new window"]')
  await page.click('button[aria-label="Open in new window"]')
  await page.sleep(2500)
  const sample = (suspend) => page.eval((ms, suspendOpener) => new Promise((resolve) => {
    // A minimized or occluded opener stops getting animation frames; the
    // popout must keep shifting on its own. Simulate that by ending the
    // opener's frame chain.
    if (suspendOpener) window.requestAnimationFrame = () => 0
    let child = null
    for (let n = 1; n < 12 && !child; n++) { const w = window.open('', 'orgtree-popout-' + n); if (w && w.document.querySelector('.popout-mount')) child = w }
    if (!child) return resolve({ error: 'no popout window' })
    const root = child.document.documentElement
    const hue = () => { const m = /#([0-9a-f]{6})/i.exec(root.style.getPropertyValue('--rainbow-accent')); if (!m) return null
      const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
      const h = !d ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return h * 60 }
    const seq = []
    let headChanges = 0, bodyRoot = 0
    new child.MutationObserver((r) => { headChanges += r.length }).observe(child.document.head, { childList: true, subtree: true, characterData: true, attributes: true })
    const t0 = performance.now()
    new child.MutationObserver(() => { seq.push([performance.now() - t0, hue()]) }).observe(root, { attributes: true, attributeFilter: ['style'] })
    setTimeout(() => {
      let back = 0, maxJump = 0, maxBack = 0
      for (let i = 1; i < seq.length; i++) {
        let d = seq[i][1] - seq[i - 1][1]; if (d < -180) d += 360; if (d > 180) d -= 360
        if (d < -0.001) { back++; maxBack = Math.max(maxBack, -d) }
        maxJump = Math.max(maxJump, Math.abs(d))
      }
      resolve({ headChanges, writes: seq.length, perSecond: seq.length / (ms / 1000), reversals: back, maxReversalDeg: maxBack, maxStepDeg: maxJump, sample: seq.slice(0, 12).map(s => [Math.round(s[0]), +s[1]?.toFixed(2)]) })
    }, ms)
  }), 3000, suspend)
  const live = await sample(false)
  await page.screenshot('rainbow-popout')
  const suspended = await sample(true)
  return { live, suspended }
}
