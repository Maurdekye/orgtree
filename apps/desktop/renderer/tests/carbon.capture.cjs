// carbon.capture.cjs — USER 2026-10-28 m09d1c2c45be4 ("i want its model color to be a light charcoal grey"). Renders a Carbon
// agent next to Flash, Pro, Luna and Astra as the real components draw them (norm node, mini node, tier badge, agents-summary
// chip, hire row; carbon.visual.tsx) in all four themes, reads the COLOURS THE BROWSER PAINTED, and checks them:
//   - Carbon's chip text and hire-button text are exactly --tier-carbon (#6d7e8c) in every theme
//   - that colour is CIE76 dE >= 15 from Flash, Pro, Luna and Astra as painted (same element, same theme)
//   - the Carbon card's 3px top edge (tier 55% over --line) is no closer to another tier's edge than the existing tiers
//     already are to each other (it never becomes the closest pair; flash-luna is 10.5 in charcoal, carbon-luna 14.5),
//     and differs from the card's own 1px side border (a Google card's blue provider tint) by dE >= 14 (measured 14.9-18.7)
//   - the Carbon norm node, mini node, badge, chip and hire button each exist exactly once
//   - the tier badge letter: in charcoal and obsidian every tier's letter is its tier colour (Carbon: #6d7e8c); in the two light themes
//     EVERY tier's badge is the shared dark one (#313131 fill, #cccccc letter: the contrast presets' rule in styles.css,
//     `:root:is(.contrast-light, .contrast-solarized-light) :is(.tier, .chip.agents)`, which outranks `.tier.t-carbon`), so Carbon's letter
//     there is #ccc like Flash's, Pro's, Luna's and Astra's and its colour shows in the chip, the hire button, the card edge and the mini rail
// Writes one crop per theme. Reads the painted values; does not judge the grey by eye.
//
//   electron.exe carbon.capture.cjs <outDir> <repoRoot> <node_modules dir> <label>
//
// Session 0, hidden off-screen window, muted, clipboard stubbed and denied, only file: data: blob: requests, no OS input.
// Writes only under <outDir>/<label>/.
const { app, BrowserWindow, session, clipboard } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const [outArg, repoArg, depsArg, label = 'run'] = process.argv.slice(2)
const out = path.resolve(outArg, label), repo = path.resolve(repoArg), deps = path.resolve(depsArg)
const sid = pid => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
assert.equal(sid(process.pid), 0, 'Session 0 required before creating a window')
fs.mkdirSync(out, { recursive: true })
for (const stale of ['failure.json', 'results.json']) fs.rmSync(path.join(out, stale), { force: true })
app.setPath('userData', path.join(out, 'profile-' + process.pid)); app.setPath('sessionData', path.join(out, 'session-' + process.pid))
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('mute-audio')
let clipboardCalls = 0
for (const k of Object.keys(clipboard)) if (typeof clipboard[k] === 'function') clipboard[k] = () => { clipboardCalls++; return k === 'availableFormats' ? [] : k === 'has' ? false : '' }
const within = async (p, ms, what) => { let t; try { return await Promise.race([p, new Promise((_r, j) => { t = setTimeout(() => j(Error('Deadline: ' + what)), ms) })]) } finally { clearTimeout(t) } }

const CARBON = 'rgb(109, 126, 140)' // #6d7e8c
const TIERS = ['flash', 'pro', 'carbon', 'luna', 'astra']
const THEMES = [['charcoal', []], ['obsidian', ['contrast-obsidian-black']], ['light', ['contrast-light']], ['solarized', ['contrast-solarized-light']]]
const LIGHT_THEMES = new Set(['light', 'solarized'])
const SHARED_BADGE_INK = 'rgb(204, 204, 204)', SHARED_BADGE_FILL = 'rgb(49, 49, 49)' // the contrast presets' light-theme tier badge, same for every tier
const FLOOR = 15
const EDGE_VS_SIDE_FLOOR = 14

async function bundle() {
  const esbuild = require(path.join(deps, 'esbuild'))
  try {
    await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/carbon.visual.tsx')],
      outfile: path.join(out, 'probe.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'warning',
      nodePaths: [deps], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
  } finally { await esbuild.stop() }
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></body></html>')
}

// what the browser painted, per tier; dE in CIE76 (D65) computed in the page from the painted rgb
const MEASURE = `(() => {
  const parse = s => { const m = String(s).match(/rgba?\\(([^)]+)\\)/); if (m) return m[1].split(/[ ,\\/]+/).filter(Boolean).slice(0, 3).map(Number)
    const c = String(s).match(/color\\(srgb ([^)]+)\\)/); if (c) return c[1].split(/[ \\/]+/).slice(0, 3).map(v => Math.round(Number(v) * 255)); return null }
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const lab = ([r, g, b]) => { const R = lin(r), G = lin(g), B = lin(b)
    const f = t => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116
    const x = f((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047), y = f(0.2126729 * R + 0.7151522 * G + 0.072175 * B), z = f((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883)
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)] }
  const dE = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) }
  const cs = (el, prop) => el ? getComputedStyle(el)[prop] : null
  const one = sel => document.querySelectorAll(sel)
  const out = { tiers: {}, counts: {} }
  for (const t of ${JSON.stringify(TIERS)}) {
    const badge = document.querySelector('[data-badge="' + t + '"]'), chip = document.querySelector('[data-chipcount="' + t + '"]')
    const norm = document.querySelector('[data-row="norm"] .sq.tier-' + t), mini = document.querySelector('[data-row="mini"] .sq.tier-' + t)
    const hire = document.querySelector('.hire-row .hsof button.t-' + t)
    out.counts[t] = { badge: one('[data-badge="' + t + '"]').length, chip: one('[data-chipcount="' + t + '"]').length,
      norm: one('[data-row="norm"] .sq.tier-' + t).length, mini: one('[data-row="mini"] .sq.tier-' + t + '.mini').length, hire: one('.hire-row .hsof button.t-' + t).length }
    out.tiers[t] = { badgeColor: cs(badge, 'color'), badgeFill: cs(badge, 'backgroundColor'), badgeBorder: cs(badge, 'borderTopColor'), chipColor: cs(chip, 'color'),
      hireColor: cs(hire, 'color'), normEdge: cs(norm, 'borderTopColor'), normSide: cs(norm, 'borderLeftColor'), miniBg: cs(mini, 'backgroundColor'),
      normRect: norm && norm.getBoundingClientRect().width, miniRect: mini && mini.getBoundingClientRect().width, hireRect: hire && hire.getBoundingClientRect().width,
      letters: { badge: badge && badge.textContent, hire: hire && hire.textContent } }
  }
  const c = out.tiers.carbon
  out.vs = {}
  for (const t of ${JSON.stringify(TIERS)}.filter(t => t !== 'carbon')) {
    const o = out.tiers[t]
    out.vs[t] = { chip: dE(parse(c.chipColor), parse(o.chipColor)), hire: o.hireColor ? dE(parse(c.hireColor), parse(o.hireColor)) : null,
      edge: dE(parse(c.normEdge), parse(o.normEdge)), badge: dE(parse(c.badgeColor), parse(o.badgeColor)) }
  }
  out.carbonEdgeVsSide = dE(parse(c.normEdge), parse(c.normSide))
  const others = ${JSON.stringify(TIERS)}.filter(t => t !== 'carbon')
  let minOther = Infinity
  for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) minOther = Math.min(minOther, dE(parse(out.tiers[others[i]].normEdge), parse(out.tiers[others[j]].normEdge)))
  out.minOtherEdgePair = minOther
  out.carbonMinEdge = Math.min(...others.map(t => out.vs[t].edge))
  out.carbonBadgeVsFill = (() => { const b = document.querySelector('[data-badge="carbon"]'); return { fill: cs(b, 'backgroundColor') } })()
  return out
})()`

app.whenReady().then(async () => {
  const errors = []
  try {
    await bundle()
    const ses = session.fromPartition('carbon-' + process.pid)
    ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_w, _p, done) => done(false))
    ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|about:)/.test(d.url) }))
    const win = new BrowserWindow({ width: 1024, height: 768, show: false, frame: false,
      webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, nodeIntegration: false, sandbox: true, contextIsolation: true } })
    const wc = win.webContents
    wc.setAudioMuted(true); wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) wc[k] = () => { throw Error('Clipboard denied') }
    wc.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message) })
    const js = s => wc.executeJavaScript(s)
    const wait = s => js(`new Promise((resolve, reject) => { const end = Date.now() + 8000; (function check() { if (${s}) return resolve(); if (Date.now() > end) return reject(Error('Wait: ' + ${JSON.stringify(s)})); setTimeout(check, 50) })() })`)
    const paint = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))))')
    await within(win.loadFile(path.join(out, 'index.html')), 15000, 'load')
    await wait("document.querySelectorAll('[data-row=\"norm\"] .sq').length >= 5 && document.querySelectorAll('.hire-row .hsof button').length >= 4"); await paint()

    const themes = []
    fs.mkdirSync(path.join(out, 'png'), { recursive: true })
    for (const [name, classes] of THEMES) {
      await js(`document.documentElement.className = ${JSON.stringify(classes.join(' '))}`); await paint()
      const m = await js(MEASURE)
      await js("document.getElementById('stage').style.zoom = '1.3'"); await paint()
      const c = await js("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: 0, y: Math.max(0, Math.floor(r.top)), w: Math.min(innerWidth, Math.ceil(r.right + 8)), h: Math.min(innerHeight, Math.ceil(r.bottom + 8)) } })()")
      fs.writeFileSync(path.join(out, 'png', `${name}.png`), (await wc.capturePage()).crop({ x: c.x, y: c.y, width: c.w, height: c.h }).toPNG())
      await js("document.getElementById('stage').style.zoom = '1'"); await paint()
      const p = []
      for (const t of TIERS) {
        const n = m.counts[t]
        // the hire row is not asked to offer Pro (the fixture shows Flash, Luna, Astra and Carbon), so Pro has no hire button
        for (const k of ['badge', 'chip', 'norm', 'mini', 'hire']) if (n[k] !== (k === 'hire' && t === 'pro' ? 0 : 1)) p.push(`${t}: ${n[k]} ${k} elements, ${k === 'hire' && t === 'pro' ? 0 : 1} expected`)
        if (!(m.tiers[t].normRect > 0 && m.tiers[t].miniRect > 0 && (t === 'pro' || m.tiers[t].hireRect > 0))) p.push(`${t}: a surface has no size`)
      }
      if (m.tiers.carbon.letters.badge !== 'C' || m.tiers.carbon.letters.hire !== 'C') p.push('the C letter is missing')
      for (const t of TIERS) {
        const b = m.tiers[t]
        if (LIGHT_THEMES.has(name)) {
          if (b.badgeColor !== SHARED_BADGE_INK || b.badgeFill !== SHARED_BADGE_FILL) p.push(`${t}: the light-theme badge paints letter ${b.badgeColor} on ${b.badgeFill}, expected the shared ${SHARED_BADGE_INK} on ${SHARED_BADGE_FILL}`)
        } else if (b.badgeColor !== b.chipColor) p.push(`${t}: the badge letter paints ${b.badgeColor}, not its tier colour ${b.chipColor}`)
      }
      if (!LIGHT_THEMES.has(name) && m.tiers.carbon.badgeColor !== CARBON) p.push(`carbon badgeColor painted ${m.tiers.carbon.badgeColor}, expected ${CARBON}`)
      for (const k of ['chipColor', 'hireColor']) if (m.tiers.carbon[k] !== CARBON) p.push(`carbon ${k} painted ${m.tiers.carbon[k]}, expected ${CARBON}`)
      for (const [t, d] of Object.entries(m.vs)) for (const k of ['chip', 'hire']) if (d[k] !== null && d[k] < FLOOR) p.push(`carbon ${k} is dE ${d[k].toFixed(1)} from ${t} (floor ${FLOOR})`)
      if (m.carbonMinEdge < m.minOtherEdgePair) p.push(`the Carbon card edge is dE ${m.carbonMinEdge.toFixed(1)} from its nearest tier edge, closer than the existing tiers' ${m.minOtherEdgePair.toFixed(1)}`)
      if (m.carbonEdgeVsSide < EDGE_VS_SIDE_FLOOR) p.push(`the Carbon card edge is dE ${m.carbonEdgeVsSide.toFixed(1)} from the card's own side border (floor ${EDGE_VS_SIDE_FLOOR})`)
      themes.push({ theme: name, classes, problems: p, measured: m })
    }
    const bad = themes.filter(t => t.problems.length)
    const result = { label, status: bad.length ? 'FAIL' : 'PASS', themes, sessionId: sid(process.pid), rendererSessionId: sid(wc.getOSProcessId()),
      muted: wc.isAudioMuted(), clipboardCalls, errors }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    fs.writeFileSync(path.join(out, 'all.png'), (await wc.capturePage()).toPNG())
    for (const t of themes) {
      const v = t.measured.vs, f = n => n.toFixed(1)
      console.log(`${t.theme.padEnd(9)} carbon chip ${t.measured.tiers.carbon.chipColor} edge ${t.measured.tiers.carbon.normEdge} | dE chip flash ${f(v.flash.chip)} pro ${f(v.pro.chip)} luna ${f(v.luna.chip)} astra ${f(v.astra.chip)} | dE edge flash ${f(v.flash.edge)} luna ${f(v.luna.edge)} astra ${f(v.astra.edge)} (closest existing pair ${f(t.measured.minOtherEdgePair)}) | edge vs side ${f(t.measured.carbonEdgeVsSide)}${t.problems.length ? ' | PROBLEMS: ' + t.problems.join('; ') : ''}`)
    }
    console.log(`${result.status}: ${themes.length} themes, ${bad.length} failing`)
    assert.equal(clipboardCalls, 0)
    app.exit(bad.length ? 1 : 0)
  } catch (e) {
    console.error(e)
    let dom = null
    try {
      const w = BrowserWindow.getAllWindows()[0]
      dom = await w.webContents.executeJavaScript("JSON.stringify({ sq: document.querySelectorAll('.sq').length, norm: document.querySelectorAll('[data-row=\"norm\"] .sq').length, mini: document.querySelectorAll('[data-row=\"mini\"] .sq').length, hsofButtons: [...document.querySelectorAll('.hire-row .hsof button')].map(b => b.className), badges: document.querySelectorAll('[data-badge]').length, text: document.body.innerText.slice(0, 300) })")
      fs.writeFileSync(path.join(out, 'failure.png'), (await w.webContents.capturePage()).toPNG())
    } catch {}
    try { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e), errors, dom }, null, 2)) } catch {}
    app.exit(2)
  }
}).catch(e => { console.error(e); app.exit(2) })
