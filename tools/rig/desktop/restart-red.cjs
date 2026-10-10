// The restart entries' styling: "Backend restarted" and "Interrupted restart" are
// drawn red with a reddish border. The entries are built in the page from the
// app's own card classes (the real stylesheet decides how they look), once per
// theme; the --bad colour is measured against the page background.
module.exports = async (page) => {
  await page.waitFor('.orgbar .iconbtn', { timeout: 60000 })
  const probe = () => page.eval(() => {
    const host = document.createElement('div')
    host.id = 'rr-host'
    host.style.cssText = 'position:fixed;left:20px;top:60px;width:560px;z-index:99999;background:var(--bg)'
    const card = (variant, family, title, body) => `<div class="event-surface event-card event-${family}" data-event-variant="${variant}">
      <div class="event-head"><span class="event-family">${family}</span><strong>${title}</strong></div>
      <div class="event-body">${body}</div></div>`
    host.innerHTML =
      card('runtime.restart_notice', 'runtime_recovery', 'Backend restarted', 'Installed version 4.2.0') +
      card('context.drive_restart_interrupted', 'context_change', 'Interrupted restart', 'The engine stopped during the preceding turn.') +
      card('ordinary.message', 'ordinary', 'Message', 'a plain entry for comparison')
    document.body.appendChild(host)
    const lum = (rgb) => { const c = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
    const parse = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
    const bg = parse(getComputedStyle(document.body).backgroundColor)
    const bad = parse(getComputedStyle(document.documentElement).getPropertyValue('--bad').trim().startsWith('#')
      ? (() => { const h = getComputedStyle(document.documentElement).getPropertyValue('--bad').trim(); const n = parseInt(h.slice(1), 16); return `rgb(${n >> 16 & 255},${n >> 8 & 255},${n & 255})` })()
      : getComputedStyle(document.documentElement).getPropertyValue('--bad'))
    const el = (v) => host.querySelector(`[data-event-variant="${v}"]`)
    const info = (v) => { const cs = getComputedStyle(el(v)); return { top: cs.borderTopColor, left: cs.borderLeftColor, leftW: cs.borderLeftWidth, famColor: getComputedStyle(el(v).querySelector('.event-family')).color } }
    return {
      bg, bad, contrastBadOnBg: Math.round(ratio(bad, bg) * 100) / 100,
      restart: info('runtime.restart_notice'), interrupted: info('context.drive_restart_interrupted'), plain: info('ordinary.message'),
    }
  })
  const out = {}
  out.dark = await probe()
  await page.screenshot('1-dark')
  await page.eval(() => document.getElementById('rr-host')?.remove())
  await page.eval(() => { document.documentElement.classList.add('contrast-light') })
  await page.sleep(400)
  out.light = await probe()
  await page.screenshot('2-light')
  const same = (t) => t.interrupted.famColor === t.restart.famColor && t.interrupted.left === t.restart.left && t.interrupted.top === t.restart.top
  const redder = (t) => t.restart.top !== t.plain.top
  out.sameRedDark = same(out.dark); out.sameRedLight = same(out.light)
  out.borderDark = redder(out.dark); out.borderLight = redder(out.light)
  return out
}
