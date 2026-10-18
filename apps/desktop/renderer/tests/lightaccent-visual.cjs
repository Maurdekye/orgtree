// Page script for lightaccent-visual.mjs (tools/rig/desktop driver): the
// light-mode gallery (lightaccent-visual.tsx) in the light, solarized-light and
// charcoal contrast families with the Orgtree Grey theme, plus the root tokens
// of a few other theme and contrast pairs. For each frame it audits every
// element whose text is drawn in the theme accent (or its hover) against the
// background it really sits on, and every accent fill against its own text,
// at rest and with the pointer on an urgent and an unread row. Full frames at
// 1x plus 2x close-ups of the list; no assertions here, so the same script
// records a base.
const fs = require('node:fs'), path = require('node:path')
const W = 980, H = 620
const FRAMES = [['light', 'orgtree'], ['solarized-light', 'orgtree'], ['charcoal', 'orgtree']]
const TOKENS_ONLY = [['obsidian-black', 'orgtree'], ['light', 'claude'], ['solarized-light', 'claude'], ['light', 'muse']]
module.exports = async (page, { out }) => {
  const paint = () => page.eval(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await new Promise(r => setTimeout(r, 120)) })
  const park = async () => { await page.mouse('mouseMoved', W - 4, H - 4); await paint() }
  const set = async (m) => { await page.eval(m => window.__gallery.set(m), m); await paint() }
  const audit = (scope) => page.eval((scope) => {
    const root = getComputedStyle(document.documentElement), token = n => root.getPropertyValue(n).trim()
    const parse = c => {
      let m = /^rgba?\(([^)]+)\)$/.exec(c)
      if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1] }
      m = /^color\(srgb ([^)]+)\)$/.exec(c)
      if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1] }
      return null
    }
    const resolve = c => { const e = document.createElement('i'); e.style.color = c; document.body.appendChild(e); const v = getComputedStyle(e).color; e.remove(); return parse(v) }
    const lin = c => (c /= 255, c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
    const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1)
    // the colour actually behind an element: its own and its ancestors' fills, composited
    const backdrop = el => {
      const layers = []
      for (let e = el; e; e = e.parentElement) {
        const bg = parse(getComputedStyle(e).backgroundColor)
        if (bg && bg[3] > 0) { layers.push(bg); if (bg[3] >= 1) break }
      }
      let base = [255, 255, 255, 1]
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base)
      return base
    }
    const opacity = el => { let o = 1; for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o }
    const same = (a, b) => a && b && [0, 1, 2].every(i => Math.abs(a[i] - b[i]) <= 1)
    const hex = c => '#' + c.slice(0, 3).map(x => Math.round(x).toString(16).padStart(2, '0')).join('')
    const label = e => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).join('.') : '')
    const shown = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' }
    const ownText = e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
    const accent = resolve(token('--accent')), hover = resolve(token('--accent-hover'))
    const texts = [], fills = []
    for (const e of document.querySelectorAll(scope + ' *')) {
      if (!shown(e)) continue
      const s = getComputedStyle(e), color = parse(s.color), bg = parse(s.backgroundColor)
      if (ownText(e) && (same(color, accent) || same(color, hover))) {
        const back = backdrop(e), fg = over([color[0], color[1], color[2], color[3] * opacity(e)], back)
        texts.push({ el: label(e), text: e.textContent.trim().slice(0, 40), color: hex(color), on: hex(back), ratio: +ratio(fg, back).toFixed(2), font: s.fontSize, weight: s.fontWeight })
      }
      if (bg && bg[3] >= 1 && same(bg, accent) && e.textContent.trim()) {
        const ink = parse(getComputedStyle(e).color)
        fills.push({ el: label(e), text: e.textContent.trim().slice(0, 20), ink: hex(ink), on: hex(bg), ratio: +ratio(over(ink, bg), bg).toFixed(2) })
      }
    }
    const html = document.documentElement
    return { root: { accent: token('--accent'), hover: token('--accent-hover'), soft: token('--accent-soft'), ink: token('--accent-ink'),
      org: token('--org-accent'), theme: html.dataset.visualTheme ?? null, cls: html.className }, texts, fills }
  }, scope)
  const hoverAudit = async (sel) => {
    const box = await page.eval(sel => { const e = document.querySelector(sel); if (!e) return null; e.setAttribute('data-gallery-hover', ''); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }, sel)
    if (!box) return null
    await page.mouse('mouseMoved', Math.round(box.x), Math.round(box.y)); await paint()
    const result = await audit('[data-gallery-hover]')
    await page.eval(() => document.querySelector('[data-gallery-hover]')?.removeAttribute('data-gallery-hover'))
    await park()
    return result
  }
  const closeup = async (name, sel) => {
    const box = await page.eval(sel => { const l = document.querySelector(sel); if (!l) return null; const r = l.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }, sel)
    if (!box) return
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false, screenWidth: W, screenHeight: H }); await paint()
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(box.w + 16, 460), height: Math.min(box.h + 16, 440), scale: 1 } })
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'))
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false, screenWidth: W, screenHeight: H }); await paint()
  }
  await page.resize(`${W}x${H}`)
  await page.eval(() => {
    const s = document.createElement('style')
    s.textContent = '.attn-mlist{width:340px;min-width:340px;max-width:340px}body{margin:0;background:var(--bg);color:var(--ink)}'
    document.head.appendChild(s)
  })
  await page.waitFor('.mailrow')
  const results = { frames: {}, tokens: {} }
  for (const view of ['inbox', 'attention']) {
    await set({ view })
    if (view === 'inbox') await page.waitFor('.mailrow.urgent')
    else { await page.waitFor('[data-attn-kind="mention"] > *'); await page.waitFor('[data-attn-kind="mail"] > *') }
    for (const [contrast, theme] of FRAMES) {
      await set({ contrast, theme }); await park()
      const name = `${contrast}-${theme}-${view}`
      const list = view === 'inbox' ? '.mailer-list' : '.attn-mlist'
      const frame = await audit('#probe')
      frame.hover = {
        urgent: await hoverAudit(view === 'inbox' ? '.mailrow.urgent:not(.on)' : '[data-attn-kind="mail"] .mailrow.urgent'),
        unread: await hoverAudit(view === 'inbox' ? '.mailrow.unread:not(.urgent):not(.on)' : '[data-attn-kind="mention"] .mailrow'),
      }
      results.frames[name] = frame
      await page.screenshot(name); await closeup(name + '-2x', list)
    }
  }
  for (const [contrast, theme] of TOKENS_ONLY) {
    await set({ contrast, theme })
    results.tokens[`${contrast}-${theme}`] = (await audit('#probe')).root
  }
  return results
}
