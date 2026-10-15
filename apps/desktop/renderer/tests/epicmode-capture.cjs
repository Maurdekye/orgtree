// EPIC Mode visual capture (Electron main), driven by tools/rig/epic-mode-visual.mjs.
// Loads the generated synthetic fixture from file://, photographs the secret
// switch in every contrast theme — off, hovered, ticked, unticked again — and
// MEASURES it: the off row's pixels must equal the panel's background exactly,
// the hovered row must be one uniform, different (highlight) colour, and the
// ticked row must show something with the name in the accent colour. Then it
// cues EPIC effects at the fixture's cards and photographs them mid-flight.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = process.env.EPIC_VISUAL_ROOT
const url = process.env.EPIC_VISUAL_URL
if (!/^C:\\orgtree-build\\[^\\]+\\/i.test((root || '') + '\\')) throw new Error('expected a C:\\orgtree-build output root')
if (!/^file:\/\/\/C:\/orgtree-build\//i.test(url || '')) throw new Error('expected the generated fixture folder as a file:// URL')
const shots = path.join(root, 'shots')
fs.mkdirSync(shots, { recursive: true })
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()

const sleep = ms => new Promise(r => setTimeout(r, ms))
let loads = 0
const receipts = []
const write = passed => fs.writeFileSync(path.join(root, 'visual-result.json'), JSON.stringify({ passed, receipts }, null, 2))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.setFrameRate(30)
  win.webContents.startPainting()
  const js = code => win.webContents.executeJavaScript(code)
  const settle = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40))))')
  const shot = async name => {
    await settle()
    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(shots, name + '.png'), image.toPNG())
    return image
  }
  const waitFor = async (expr, what) => {
    for (let i = 0; i < 200; i++) { if (await js(expr)) return; await sleep(25) }
    throw new Error('fixture never showed ' + what)
  }
  const mouse = async (type, x, y) => {
    win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(60)
  }
  /** every pixel of the row's inner box, compared with one colour */
  const region = (image, r) => {
    const { width } = image.getSize()
    const bmp = image.toBitmap()
    const px = (x, y) => { const i = (y * width + x) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]] }
    const colours = new Map()
    for (let y = Math.ceil(r.top) + 2; y < Math.floor(r.bottom) - 2; y++) {
      for (let x = Math.ceil(r.left) + 2; x < Math.floor(r.right) - 2; x++) {
        const k = px(x, y).join(',')
        colours.set(k, (colours.get(k) || 0) + 1)
      }
    }
    return [...colours.entries()].sort((a, b) => b[1] - a[1])
  }
  const rgb = s => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number)
  const near = (a, b, tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

  try {
    for (const theme of ['charcoal', 'light', 'solarized-light', 'obsidian-black']) {
      await win.loadURL(`${url}/fixture.html?scene=switch&n=${++loads}`)
      await waitFor(`!!document.querySelector('.epic-switch input[aria-label="EPIC Mode"]')`, 'the EPIC switch')
      await js(`window.__contrast(${JSON.stringify(theme)}); true`)
      await sleep(80)
      const info = await js(`(() => {
        const row = document.querySelector('.epic-switch'), label = row.querySelector('.epic-switch-label')
        const r = row.getBoundingClientRect(), panel = row.closest('.settings') || document.body
        return { rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
          panelBg: getComputedStyle(panel).backgroundColor, hover: getComputedStyle(document.documentElement).getPropertyValue('--panel-2').trim(),
          accent: (() => { const probe = document.createElement('span'); probe.style.color = 'var(--accent)'; panel.append(probe)
            const c = getComputedStyle(probe).color; probe.remove(); return c })(), label: getComputedStyle(label).color }
      })()`)
      const cx = (info.rect.left + info.rect.right) / 2, cy = (info.rect.top + info.rect.bottom) / 2
      const bg = rgb(info.panelBg)
      await mouse('mouseMove', 8, 8)
      const off = region(await shot(`switch-off-${theme}`), info.rect)
      await mouse('mouseMove', cx, cy)
      await sleep(450)   // and fades in over .3s
      const hover = region(await shot(`switch-hover-${theme}`), info.rect)
      await mouse('mouseDown', cx, cy)
      await mouse('mouseUp', cx, cy)
      await mouse('mouseMove', 8, 8)
      await sleep(450)   // the hover highlight fades out over .3s
      const onState = await js(`(() => { const row = document.querySelector('.epic-switch'); return { on: row.classList.contains('on'),
        checked: row.querySelector('input').checked, label: getComputedStyle(row.querySelector('.epic-switch-label')).color } })()`)
      const on = region(await shot(`switch-on-${theme}`), info.rect)
      await mouse('mouseDown', cx, cy)
      await mouse('mouseUp', cx, cy)
      await mouse('mouseMove', 8, 8)
      await sleep(450)
      const again = region(await shot(`switch-off-again-${theme}`), info.rect)
      const offState = await js(`document.querySelector('.epic-switch').classList.contains('on')`)
      const unanswered = await js(`window.__unknown.slice()`)
      const receipt = {
        theme, unanswered, rect: info.rect, panelBg: info.panelBg, accent: info.accent, onLabel: onState.label,
        off: { colours: off.length, top: off[0] }, hover: { colours: hover.length, top: hover[0] },
        on: { colours: on.length, checked: onState.checked, revealed: onState.on },
        offAgain: { colours: again.length, top: again[0], revealed: offState },
      }
      const top = list => list[0] ? list[0][0].split(',').map(Number) : null
      receipt.offInvisible = off.length === 1 && near(top(off), bg)
      receipt.hoverSubtle = hover.length === 1 && !near(top(hover), bg, 0)
      receipt.onVisible = on.length > 1 && onState.checked && onState.on && near(rgb(onState.label), rgb(info.accent), 3)
      receipt.offAgainInvisible = again.length === 1 && near(top(again), bg) && !offState
      receipts.push(receipt)
      write(false)
      if (!receipt.offInvisible || !receipt.hoverSubtle || !receipt.onVisible || !receipt.offAgainInvisible) {
        throw new Error('switch look mismatch in ' + theme + ': ' + JSON.stringify(receipt))
      }
    }

    // ── the effects ─────────────────────────────────────────────────────
    const effects = [
      ['epic-on', `__epic.start('enable')`, 650],
      ['freeze-ice-spike', `__epic.start(); __epic.cue('freeze', { node: 'alice' })`, 330],
      ['interrupt-stop-sign', `__epic.start(); __epic.cue('interrupt', { node: 'bob' })`, 260],
      ['zap-lightning', `__epic.start(); __epic.cue('zap', { node: 'carol', other: 'boss' }); __epic.cue('zap', { node: 'alice', other: 'boss' })`, 110],
      ['hire-beam', `__epic.start(); __epic.cue('hire', { node: 'dave' })`, 380],
      ['halt-alarm', `__epic.start(); __epic.cue('halt', { node: 'boss' })`, 280],
      ['watchdog-woof', `__epic.start(); __epic.cue('bark', { node: 'erin', other: 'carol' })`, 420],
      ['question', `__epic.start(); __epic.cue('question', { node: 'bob' })`, 380],
      ['ticket-done', `__epic.start(); __epic.cue('ticketDone')`, 900],
      ['cacophony', `__epic.start();
        __epic.cue('zap', { node: 'carol', other: 'boss' }); __epic.cue('zap', { node: 'dave', other: 'alice' });
        __epic.cue('tool', { node: 'bob', text: 'Bash' }); __epic.cue('turnStart', { node: 'erin' });
        __epic.cue('freeze', { node: 'alice' }); __epic.cue('interrupt', { node: 'boss' }); __epic.cue('credits', { node: 'carol', n: 4 })`, 300],
      ['epic-off-crt', `__epic.start(); __epic.stop(true)`, 380],
      // the final version's additions (docs/rust-engine/epic-mode-final.md)
      ['final-freeze-crystal', `__epic.start(); __epic.cue('freeze', { node: 'alice' })`, 420],
      ['final-hire-portal', `__epic.start(); __epic.cue('hire', { node: 'dave' })`, 260],
      ['final-watchdog-radar', `__epic.start(); __epic.cue('bark', { node: 'erin', other: 'carol' })`, 240],
      ['final-refused', `__epic.start(); __epic.cue('refused', { spot: { x: 500, y: 420, rect: null, el: null, doc: document }, text: 'HTTP 409' })`, 300],
      ['final-usage-100', `__epic.start(); __epic.cue('usageMax', { text: 'CLAUDE' })`, 380],
      ['final-combo-overdrive', `__epic.start();
        for (let i = 0; i < 24; i++) __epic.cue('click', { spot: { x: 120 + (i % 8) * 100, y: 120 + Math.floor(i / 8) * 180, rect: null, el: null, doc: document } });
        __epic.cue('zap', { node: 'carol', other: 'boss' }); __epic.cue('freeze', { node: 'alice' })`, 360],
      ['final-cacophony-meter', `__epic.start();
        for (let i = 0; i < 6; i++) __epic.cue('click', { spot: { x: 160 + i * 120, y: 660, rect: null, el: null, doc: document } });
        __epic.cue('zap', { node: 'carol', other: 'boss' }); __epic.cue('hire', { node: 'dave' });
        __epic.cue('tool', { node: 'bob', text: 'Edit' }); __epic.cue('interrupt', { node: 'erin' });
        __epic.cue('freeze', { node: 'alice' }); __epic.cue('bark', { node: 'boss', other: 'carol' })`, 320],
    ]
    for (const [name, code, delay] of effects) {
      await win.loadURL(`${url}/fixture.html?scene=stage&n=${++loads}`)
      await waitFor(`!!window.__epic && window.__epic.ready && document.querySelectorAll('[data-first-use-agent]').length === 6`, 'the fixture org')
      await js(code + '; true')
      await sleep(delay)
      await shot(name)
      const live = await js(`(() => { const c = document.querySelector('canvas.epic-stage'); return { stage: !!c, words: window.__drawn.splice(0) } })()`)
      receipts.push({ effect: name, delay, stage: live.stage, words: live.words })
      await js(`window.__epic.stop(); true`)
      write(false)
    }
    write(true)
  } finally { win.destroy() }
}).then(() => app.exit(0), error => {
  fs.writeFileSync(path.join(root, 'visual-error.txt'), String(error && error.stack || error))
  app.exit(1)
})
