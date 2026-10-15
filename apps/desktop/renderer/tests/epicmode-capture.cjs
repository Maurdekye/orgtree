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

    // ── typing: the sparks land at the caret in every desk ───────────────
    // (docket epic-mode-typing-effects-desync-in-canvas-desks). Keystrokes
    // into composers on the canvas — inside the camera's scale and
    // .desk-inner's, bob's at a larger text size — and into a pinned one, at
    // two zoom levels, in a dark and a light theme; alice's camera also pans
    // between keystrokes. Every effect the director put at a caret is compared
    // with where the caret really is (the fixture's own scale and a
    // browser-laid-out probe, not the director's estimate) and with where its
    // sparks were drawn. Fewer than ten keystrokes a page, so no rank title
    // covers the picture.
    const LINE1 = 'the sparks follow the caret', LINE2 = 'down a line'
    const TOLERANCE = 1.5
    const typingPage = async (z, theme) => {
      await win.loadURL(`${url}/fixture.html?scene=typing&z=${z}&tx=20&ty=40&n=${++loads}`)
      await waitFor(`!!window.__epic && window.__epic.ready && !!window.__typing && document.querySelectorAll('textarea[data-first-use-chat]').length === 3`, 'the typing desks')
      await js(`window.__contrast(${JSON.stringify(theme)}); window.__epic.start(); true`)
    }
    const focusAt = (desk, caret) => js(`(() => { const t = document.querySelector('textarea[data-first-use-chat="${desk}"]')
      t.focus(); const at = ${caret === 'end' ? 't.value.length' : Number(caret)}; t.setSelectionRange(at, at); return document.activeElement === t })()`)
    // Each key waits until the page has taken it, then leaves more than the
    // director's gap between two effects of one kind (22 ms for typing): sent
    // on a timer alone, two key events reached the page within the gap in the
    // first run, and the second, rightly, drew nothing.
    const fieldValue = () => js(`document.activeElement ? document.activeElement.value : null`)
    const native = async k => {
      const before = await fieldValue()
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k })
      if (k.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: k })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k })
      for (let i = 0; i < 40 && (await fieldValue()) === before; i++) await sleep(10)
      await sleep(60)
    }
    // the same keydown, then the edit the browser would have made
    const synthetic = async k => {
      await js(`(() => { const t = document.activeElement, key = ${JSON.stringify(k)}
        t.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
        if (key === 'Backspace') { const p = t.selectionStart; if (p > 0) t.setRangeText('', p - 1, p, 'end') }
        else t.setRangeText(key, t.selectionStart, t.selectionEnd, 'end')
        t.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })); return true })()`)
      await sleep(70)
    }
    // Real keystrokes when the offscreen window takes them; the probe page
    // settles which, once, and the receipts say so.
    await typingPage(3.75, 'charcoal')
    await focusAt('alice', 0)
    win.webContents.focus()
    await native('a')
    const input = (await js(`document.querySelector('textarea[data-first-use-chat="alice"]').value`)) === 'a' ? 'native' : 'synthetic'
    const press = k => input === 'native' ? native(k) : synthetic(k)
    const typeText = async text => { for (const ch of text) await press(ch) }
    const typingCases = [
      { name: 'zoomed-out', theme: 'charcoal', z: 3.75, desks: ['alice', 'bob', 'carol'] },
      { name: 'zoomed-in', theme: 'light', z: 11.25, desks: ['alice', 'carol'] },
    ]
    const failed = []
    for (const c of typingCases) {
      for (const desk of c.desks) {
        await typingPage(c.z, c.theme)
        // the composer already holds two lines; the caret waits at the end of the first
        await js(`(() => { document.querySelector('textarea[data-first-use-chat="${desk}"]').value = ${JSON.stringify(LINE1 + '\n' + LINE2)}; return true })()`)
        const focused = await focusAt(desk, LINE1.length)
        win.webContents.focus()
        await typeText('okay')
        const name = `typing-${c.name}-${desk}`
        await shot(name)
        await focusAt(desk, 'end')
        await typeText('up')
        await press('Backspace')
        const pan = desk === 'alice'
        if (pan) {
          await js(`window.__typing.pan(90, 40); true`)
          await settle()
          await typeText('go')
          await shot(`${name}-panned`)
        }
        const state = await js(`(() => ({ value: document.querySelector('textarea[data-first-use-chat="${desk}"]').value,
          scale: Number(document.querySelector('textarea[data-first-use-chat="${desk}"]').dataset.scale),
          carets: window.__typing.carets.splice(0), stage: window.__typing.stageBox(), size: { w: innerWidth, h: innerHeight } }))()`)
        const expected = LINE1 + 'okay\n' + LINE2 + 'u' + (pan ? 'go' : '')
        const want = pan ? 9 : 7
        const off = state.carets.map((r, i) => ({ kind: r.kind, caret: r.caret, dx: +(r.x - r.tx).toFixed(2), dy: +(r.y - r.ty).toFixed(2),
          drawn: r.drawn.length, drawnOff: r.drawn.length ? +Math.max(...r.drawn.map(d => Math.hypot(d.x - r.x, d.y - r.y))).toFixed(3) : null,
          sincePrevious: i ? Math.round(r.t - state.carets[i - 1].t) : null }))
        const worst = axis => off.length ? Math.max(...off.map(o => Math.abs(o[axis]))) : null
        const receipt = {
          typing: c.name, theme: c.theme, z: c.z, desk, scale: state.scale, input, focused, panned: pan,
          shots: pan ? [name, `${name}-panned`] : [name],
          value: state.value, valueAsTyped: state.value === expected,
          effects: off.length, effectsExpected: want, onlyThisDesk: state.carets.every(r => r.desk === desk),
          kinds: off.map(o => o.kind).join(','),
          maxDx: worst('dx'), maxDy: worst('dy'), tolerance: TOLERANCE,
          drawnAtSpot: off.length > 0 && off.every(o => o.drawn > 0 && o.drawnOff <= 0.01),
          stageIsWindow: !!state.stage && state.stage.left === 0 && state.stage.top === 0
            && state.stage.width === state.size.w && state.stage.height === state.size.h,
          perEffect: off,
        }
        receipt.atCaret = receipt.valueAsTyped && receipt.effects === want && receipt.onlyThisDesk
          && receipt.maxDx <= TOLERANCE && receipt.maxDy <= TOLERANCE && receipt.drawnAtSpot && receipt.stageIsWindow
        if (!receipt.atCaret) failed.push(`${c.name}/${desk}: maxDx ${receipt.maxDx} maxDy ${receipt.maxDy} effects ${receipt.effects}/${want} value ${receipt.valueAsTyped}`)
        receipts.push(receipt)
        await js(`window.__epic.stop(); true`)
        write(false)
      }
    }
    if (failed.length) throw new Error('typing sparks off the caret: ' + failed.join('; '))

    // ── the wheel: what it moved decides its effect ──────────────────────
    // (docket epic-mode-scrolling-a-pinned-window-on-the-canva). The REAL
    // canvas with cto's desk pinned to screen space and the agents list open,
    // then cto's docket over it: native wheel input over each, and over a
    // free point of the canvas, out to the camera's zoom limit. The page
    // records every wheel apart from the director (whether the canvas took
    // it, the camera's zoom and every scroll offset that moved), and the
    // effects the director played for it. A scroll must play one scroll
    // effect pointing the way it went, a zoom one zoom effect, and a wheel
    // that moved nothing nothing.
    const consoleErrors = []
    const onConsole = (_e, level, message) => { if (level >= 3 && consoleErrors.length < 20) consoleErrors.push(String(message).slice(0, 300)) }
    win.webContents.on('console-message', onConsole)
    await win.loadURL(`${url}/fixture.html?scene=wheel&n=${++loads}`)
    await waitFor(`!!window.__epic && window.__epic.ready && !!window.__wheel && window.__wheel.ready()`, 'the real canvas with a pinned desk and the agents list')
    await js(`window.__contrast('charcoal'); window.__epic.start(); true`)
    await sleep(1500)   // the canvas's opening glide settles
    await js(`window.__wheel.take(); true`)
    const wheelFailed = []
    const sendWheel = (p, ticks) => {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: ticks * 120, wheelTicksX: 0, wheelTicksY: ticks, canScroll: true })
    }
    // which tick sign scrolls up (a negative DOM deltaY) is read off the first wheel
    let up = 1
    const wheelCase = async (name, where, dir, expect, { shoot = false, setup = null } = {}) => {
      if (setup) await js(setup)
      await sleep(250)   // past the director's gap between two effects of one kind
      const p = await js(`window.__wheel.point(${JSON.stringify(where)})`)
      if (!p) { wheelFailed.push(`${name}: no point over ${where}`); receipts.push({ wheel: name, where, pass: false, error: 'no point' }); return null }
      const ticks = dir === 'up' ? up : -up
      sendWheel(p, ticks)
      if (shoot) await shot(`wheel-${name}`)
      await sleep(650)   // the page's own record closes 400 ms after the wheel
      const got = await js(`window.__wheel.take()`)
      const w = got.wheels[0] || null
      let truth = null
      if (w) {
        if (w.zoomBefore !== null && w.zoomAfter !== null && w.zoomAfter !== w.zoomBefore) truth = { kind: w.zoomAfter > w.zoomBefore ? 'zoomIn' : 'zoomOut' }
        else if (w.scrolled.length) truth = { kind: 'scroll', n: Math.sign(w.scrolled[0].to - w.scrolled[0].from) }
      }
      const effects = got.effects.map(e => ({ kind: e.kind, ...(e.n === undefined ? {} : { n: e.n }), after: w ? Math.round(e.t - w.t) : null }))
      const category = truth ? (truth.kind === 'scroll' ? 'scroll' : 'zoom') : 'none'
      const asPlayed = effects.map(e => e.kind + (e.n === undefined ? '' : ':' + e.n)).join(',')
      const asTruth = truth ? truth.kind + (truth.n === undefined ? '' : ':' + truth.n) : ''
      const receipt = { wheel: name, where, dir, ticks, point: p, wheels: got.wheels.length, deltaY: w && w.deltaY, target: w && w.target,
        taken: w && w.taken, zoomBefore: w && w.zoomBefore, zoomAfter: w && w.zoomAfter, scrolled: w ? w.scrolled : [],
        moved: category, expected: expect, played: asPlayed, truth: asTruth, effects, shots: shoot ? [`wheel-${name}`] : [] }
      receipt.pass = got.wheels.length === 1 && category === expect && asPlayed === asTruth
      if (!receipt.pass) wheelFailed.push(`${name}: moved ${category} (expected ${expect}), played [${asPlayed}] for [${asTruth}]`)
      receipts.push(receipt)
      write(false)
      return receipt
    }
    const first = await wheelCase('canvas-zoom-in', 'canvas', 'up', 'zoom', { shoot: true })
    if (first && first.deltaY > 0) {
      // this platform's positive tick scrolls down: the first case went the
      // other way, so it is recorded as such and then taken again
      up = -1
      first.note = 'probe: a positive tick gave a positive DOM deltaY; up is the negative tick from here on'
      await wheelCase('canvas-zoom-in-again', 'canvas', 'up', 'zoom', { shoot: true })
    }
    await wheelCase('canvas-zoom-out', 'canvas', 'down', 'zoom')
    // the pinned chat follows its newest line: down at the bottom moves nothing
    await wheelCase('pinned-end', 'chat', 'down', 'none', { shoot: true, setup: `window.__wheel.setTop('chat', 1e6); true` })
    await wheelCase('pinned-up', 'chat', 'up', 'scroll', { shoot: true })
    await wheelCase('pinned-down', 'chat', 'down', 'scroll')
    await wheelCase('tray-down', 'tray', 'down', 'scroll', { shoot: true, setup: `window.__wheel.setTop('tray', 0); true` })
    await wheelCase('tray-top', 'tray', 'up', 'none', { setup: `window.__wheel.setTop('tray', 0); true` })
    const docket = await js(`window.__wheel.openDocket()`)
    if (!docket) wheelFailed.push('could not open cto\'s docket from the agents list')
    else {
      await wheelCase('docket-down', 'panel', 'down', 'scroll', { shoot: true, setup: `window.__wheel.setTop('panel', 0); true` })
      await wheelCase('docket-top', 'panel', 'up', 'none', { setup: `window.__wheel.setTop('panel', 0); true` })
      win.webContents.focus()
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await sleep(300)
      if (await js(`!!window.__wheel.scroller('panel')`)) { await mouse('mouseDown', 6, 690); await mouse('mouseUp', 6, 690); await sleep(300) }
      if (await js(`!!window.__wheel.scroller('panel')`)) wheelFailed.push('the docket did not close')
    }
    // out to the camera's zoom limit, a free point at a time
    let zoom = await js(`window.__wheel.zoom()`)
    for (let i = 0; i < 12 && zoom !== 12; i++) {
      const p = await js(`window.__wheel.point('canvas')`)
      if (!p) break
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: up * 1200, wheelTicksX: 0, wheelTicksY: up * 10, canScroll: true })
      await sleep(350)
      zoom = await js(`window.__wheel.zoom()`)
    }
    await sleep(300)
    await js(`window.__wheel.take(); true`)
    receipts.push({ wheel: 'to-the-limit', zoom })
    if (zoom !== 12) wheelFailed.push(`the camera did not reach its zoom limit (12): ${zoom}`)
    else {
      await wheelCase('zoom-limit', 'canvas', 'up', 'none', { shoot: true })
      await wheelCase('zoom-limit-back', 'canvas', 'down', 'zoom')
    }
    win.webContents.off('console-message', onConsole)
    receipts.push({ wheel: 'page', unanswered: await js(`window.__unknown.slice()`), consoleErrors })
    write(false)
    if (wheelFailed.length) throw new Error('wheel effects not what the wheel did: ' + wheelFailed.join('; '))

    // ── urgent mail: the alarm ───────────────────────────────────────────
    // (docket epic-mode-make-urgent-mail-s-effect-much-more-ey). The stage
    // scene, then urgent mail: photographed before it, at a pulse's peak and
    // trough, at a peak three and a half seconds on, and after it has ended
    // by itself. A corner pixel and the middle are measured in each: the tint
    // must be plainly visible, deeper at the edges than in the middle, pulse
    // down between peaks, still be on at 3.6 s, and be gone at the end.
    const urgentFailed = []
    const pixel = (image, x, y) => {
      const { width } = image.getSize()
      const bmp = image.toBitmap()
      const i = (y * width + x) * 4
      return [bmp[i + 2], bmp[i + 1], bmp[i]]
    }
    const CORNER = [10, 690], MIDDLE = [500, 380]
    const measure = image => ({ corner: pixel(image, ...CORNER), middle: pixel(image, ...MIDDLE) })
    for (const theme of ['charcoal', 'light']) {
      await win.loadURL(`${url}/fixture.html?scene=stage&n=${++loads}`)
      await waitFor(`!!window.__epic && window.__epic.ready && document.querySelectorAll('[data-first-use-agent]').length === 6`, 'the fixture org')
      await js(`window.__contrast(${JSON.stringify(theme)}); window.__epic.start(); true`)
      await sleep(300)
      const base = measure(await shot(`urgent-${theme}-before`))
      const started = Date.now()
      // at the inbox bell, as the org's own tree stages it
      await js(`(() => { const b = document.querySelector('.ask-bell').getBoundingClientRect()
        window.__epic.cue('urgent', { caption: 'boss', spot: { x: b.left + b.width / 2, y: b.top + b.height / 2, rect: null, el: null, doc: document } })
        return true })()`)
      // each shot lands about 100 ms after it is asked for (two frames and 40 ms)
      const at = async ms => { const left = ms - 100 - (Date.now() - started); if (left > 0) await sleep(left) }
      await at(400)
      const peak = measure(await shot(`urgent-${theme}-peak`))
      await at(800)
      const trough = measure(await shot(`urgent-${theme}-trough`))
      await at(3600)
      const later = measure(await shot(`urgent-${theme}-later`))
      await at(9000)
      const gone = measure(await shot(`urgent-${theme}-gone`))
      // redness, red over the other two: a red tint raises it on a dark and a
      // light background alike, and grey (the canvas dots) leaves it alone
      const redness = p => p[0] - (p[1] + p[2]) / 2
      const red = (m, where) => Math.round(redness(m[where]) - redness(base[where]))
      const receipt = { urgent: theme, base, peak, trough, later, gone,
        cornerRed: { peak: red(peak, 'corner'), trough: red(trough, 'corner'), later: red(later, 'corner'), gone: red(gone, 'corner') },
        middleRed: { peak: red(peak, 'middle') } }
      receipt.visible = receipt.cornerRed.peak >= 25
      receipt.deeperAtEdges = receipt.cornerRed.peak > receipt.middleRed.peak
      receipt.pulses = receipt.cornerRed.trough < receipt.cornerRed.peak * 0.75
      receipt.lasts = receipt.cornerRed.later >= 20
      receipt.ends = Math.abs(receipt.cornerRed.gone) <= 3
      receipt.pass = receipt.visible && receipt.deeperAtEdges && receipt.pulses && receipt.lasts && receipt.ends
      if (!receipt.pass) urgentFailed.push(`${theme}: ${JSON.stringify(receipt.cornerRed)} middle ${receipt.middleRed.peak}`)
      receipts.push(receipt)
      await js(`window.__epic.stop(); true`)
      write(false)
    }
    if (urgentFailed.length) throw new Error('urgent mail alarm not as specified: ' + urgentFailed.join('; '))
    write(true)
  } finally { win.destroy() }
}).then(() => app.exit(0), error => {
  fs.writeFileSync(path.join(root, 'visual-error.txt'), String(error && error.stack || error))
  app.exit(1)
})
