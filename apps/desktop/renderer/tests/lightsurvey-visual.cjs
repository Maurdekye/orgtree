// Page script for lightsurvey-visual.mjs (tools/rig/desktop driver): the real
// App on lightsurvey-fixture.tsx's fake organization, in each contrast family
// and theme, on the canvas, the user's inbox, the Attention view, the shell
// menu and the homepage. For each frame it audits every visible text against
// the background it really sits on (its own and its ancestors' fills,
// composited, and its opacity), every icon, every field's edge, and on the
// light surfaces every dark fill, then saves the frame. No assertions here:
// the driver judges, so the same script records a base.
const fs = require('node:fs'), path = require('node:path')
const W = 1280, H = 800
const CONTRASTS = ['light', 'solarized-light', 'charcoal']
const THEMES = ['orgtree', 'claude']
module.exports = async (page, { out, args }) => {
  const contrasts = args.contrasts ?? CONTRASTS, themes = args.themes ?? THEMES
  const paint = () => page.eval(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await new Promise(r => setTimeout(r, 150)) })
  const park = async () => { await page.mouse('mouseMoved', W - 3, H - 3); await paint() }
  const set = async (m) => { await page.eval(m => window.__survey.set(m), m); await paint() }
  const audit = () => page.eval(() => {
    const root = getComputedStyle(document.documentElement), token = n => root.getPropertyValue(n).trim()
    const parse = c => {
      let m = /^rgba?\(([^)]+)\)$/.exec(c)
      if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1] }
      m = /^color\(srgb ([^)]+)\)$/.exec(c)
      if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1] }
      return null
    }
    // oklch()/color-mix() computed values: let the engine convert through a canvas pixel
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    const toRgb = c => {
      const p = parse(c); if (p) return p
      if (!c || c === 'transparent') return [0, 0, 0, 0]
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return d[3] ? [d[0] * 255 / d[3], d[1] * 255 / d[3], d[2] * 255 / d[3], d[3] / 255] : [0, 0, 0, 0]
    }
    const lin = c => (c /= 255, c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
    const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1)
    const pageBg = (() => { const b = toRgb(getComputedStyle(document.body).backgroundColor); return b[3] > 0 ? over(b, toRgb(root.getPropertyValue('--bg').trim() || '#fff')) : toRgb(root.getPropertyValue('--bg').trim() || '#fff') })()
    const backdrop = el => {
      const layers = []
      for (let e = el; e; e = e.parentElement) {
        const bg = toRgb(getComputedStyle(e).backgroundColor)
        if (bg[3] > 0) { layers.push(bg); if (bg[3] >= 1) break }
      }
      let base = pageBg
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base)
      return base
    }
    const opacity = el => { let o = 1; for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o }
    const hex = c => '#' + c.slice(0, 3).map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')
    const label = e => {
      const cls = typeof e.className === 'string' ? e.className : e.className?.baseVal ?? ''
      const own = e.tagName.toLowerCase() + (cls.trim() ? '.' + cls.trim().split(/\s+/).slice(0, 4).join('.') : '')
      const up = e.parentElement && e.parentElement !== document.body ? e.parentElement : null
      const ucls = up && typeof up.className === 'string' ? up.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
      return up ? `${up.tagName.toLowerCase()}${ucls ? '.' + ucls : ''} > ${own}` : own
    }
    const inView = r => r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight
    const shown = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && inView(r) && s.visibility !== 'hidden' && s.display !== 'none' }
    const ownText = e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
    const low = new Map(), icons = new Map(), edges = new Map(), dark = new Map()
    const add = (m, key, row) => { const r = m.get(key); if (r) r.count++; else m.set(key, { ...row, count: 1 }) }
    let texts = 0
    for (const e of document.querySelectorAll('body *')) {
      if (!shown(e)) continue
      const s = getComputedStyle(e)
      if (s.opacity === '0') continue
      if (ownText(e)) {
        texts++
        const color = toRgb(s.color), back = backdrop(e), fg = over([color[0], color[1], color[2], color[3] * opacity(e)], back)
        const r = ratio(fg, back), size = parseFloat(s.fontSize), bold = parseInt(s.fontWeight, 10) >= 700
        const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5
        if (r < need) add(low, `${label(e)}|${hex(fg)}|${hex(back)}`, { el: label(e), text: e.textContent.trim().replace(/\s+/g, ' ').slice(0, 48), color: hex(fg), on: hex(back), ratio: +r.toFixed(2), need, font: s.fontSize })
      }
      if (e.tagName.toLowerCase() === 'svg' && e.getBoundingClientRect().width >= 8) {
        const fill = s.fill && s.fill !== 'none' ? toRgb(s.fill.startsWith('url') ? s.color : s.fill) : toRgb(s.color)
        const back = backdrop(e.parentElement ?? e), fg = over([fill[0], fill[1], fill[2], fill[3] * opacity(e)], back), r = ratio(fg, back)
        if (r < 3) add(icons, `${label(e)}|${hex(fg)}|${hex(back)}`, { el: label(e), color: hex(fg), on: hex(back), ratio: +r.toFixed(2) })
      }
      if (/^(input|select|textarea)$/i.test(e.tagName) && !/^(checkbox|radio|range|hidden|color)$/i.test(e.type || '')) {
        const edge = toRgb(s.borderTopColor), bw = parseFloat(s.borderTopWidth)
        const outside = backdrop(e.parentElement ?? e), fill = backdrop(e)
        const r = bw > 0 && edge[3] > 0 ? Math.max(ratio(over(edge, outside), outside), 1) : 1
        const f = ratio(fill, outside)
        if (Math.max(r, f) < 3) add(edges, `${label(e)}|${hex(over(edge, outside))}|${hex(outside)}`, { el: label(e), edge: bw > 0 ? hex(over(edge, outside)) : 'none', fill: hex(fill), on: hex(outside), edgeRatio: +r.toFixed(2), fillRatio: +f.toFixed(2) })
      }
      const bg = toRgb(s.backgroundColor)
      if (bg[3] >= 0.9 && lum(bg) < 0.06) {
        const r = e.getBoundingClientRect()
        if (r.width * r.height >= 120) add(dark, `${label(e)}|${hex(bg)}`, { el: label(e), fill: hex(bg), size: `${Math.round(r.width)}x${Math.round(r.height)}`, text: e.textContent.trim().replace(/\s+/g, ' ').slice(0, 32) })
      }
    }
    const html = document.documentElement
    const sorted = m => [...m.values()].sort((a, b) => (a.ratio ?? a.edgeRatio ?? 0) - (b.ratio ?? b.edgeRatio ?? 0))
    return { root: { theme: html.dataset.visualTheme ?? null, cls: html.className, accent: token('--accent'), bg: token('--bg'), ink: token('--ink'), dim: token('--dim') },
      texts, low: sorted(low), icons: sorted(icons), edges: sorted(edges), dark: [...dark.values()] }
  })
  const results = { frames: {}, errors: [] }
  const frames = async (view) => {
    for (const contrast of contrasts) for (const theme of themes) {
      const name = `${view}-${contrast}-${theme}`
      try {
        await set({ contrast, theme }); await park()
        results.frames[name] = await audit()
        await page.screenshot(name)
      } catch (e) { results.errors.push(`${name}: ${e.message}`) }
    }
  }
  const step = async (view, open, close) => {
    try { await open(); await frames(view) } catch (e) { results.errors.push(`${view}: ${e.message}`); try { await page.screenshot(`${view}-failed`) } catch { /* none */ } }
    if (close) { try { await close() } catch (e) { results.errors.push(`${view} close: ${e.message}`) } }
  }
  await page.resize(`${W}x${H}`)
  await page.waitFor('.shell-header', { timeout: 30000 })
  await page.waitFor('.sq', { timeout: 30000 })
  await paint()
  await page.screenshot('loaded')
  await step('canvas', async () => {})
  await step('inbox', async () => {
    await page.click('button.ask-bell[aria-label="Inbox"]')
    await page.waitFor('.mailrow', { timeout: 15000 })
  }, async () => {
    await page.click('[aria-label="close this window"]')
    await page.waitFor('.mailrow', { gone: true, timeout: 5000 }); await paint()
  })
  await step('menu', async () => {
    await page.click('.shell-menu-button')
    await page.waitFor('.shell-menu-panel', { timeout: 10000 })
  }, async () => { await page.press('Escape'); await paint() })
  await step('attention', async () => {
    await page.click('.shell-header [role="switch"]')
    await page.waitFor(() => !!document.querySelector('[class*="attn"]'), { timeout: 15000 })
    await paint()
  }, async () => { await page.click('.shell-header [role="switch"]'); await paint() })
  await step('home', async () => {
    await page.goto('/?view=home')
    await page.waitFor('.shell-header', { timeout: 30000 })
    await paint()
  })
  results.consoleErrors = page.consoleErrors.slice(0, 20)
  return results
}
