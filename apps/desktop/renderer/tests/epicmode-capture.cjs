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
  // A popped-out desk window (window.open from the page). Hidden but NOT
  // offscreen: an offscreen child of this offscreen page never produced a frame
  // (capturePage() empty, no paint event, even shown), while a hidden ordinary
  // window with paintWhenInitiallyHidden captures at its full size.
  let popout = null
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, width: 520, height: 300,
    useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } } }))
  win.webContents.on('did-create-window', child => { popout = child })
  const js = code => win.webContents.executeJavaScript(code)
  const SETTLE = 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40))))'
  const settle = () => js(SETTLE)
  const shot = async name => {
    await settle()
    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(shots, name + '.png'), image.toPNG())
    return image
  }
  const shotIn = async (wc, name) => {
    await wc.executeJavaScript(SETTLE)
    const image = await wc.capturePage()
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
    // the window the keys go to: the page, or a popped-out desk window
    let target = win.webContents
    const focusAt = (desk, caret) => target.executeJavaScript(`(() => { const t = document.querySelector('textarea[data-first-use-chat="${desk}"]')
      t.focus(); const at = ${caret === 'end' ? 't.value.length' : Number(caret)}; t.setSelectionRange(at, at); return document.activeElement === t })()`)
    // Each key waits until the page has taken it, then leaves more than the
    // director's gap between two effects of one kind (22 ms for typing): sent
    // on a timer alone, two key events reached the page within the gap in the
    // first run, and the second, rightly, drew nothing.
    const fieldValue = () => target.executeJavaScript(`document.activeElement ? document.activeElement.value : null`)
    const native = async k => {
      const before = await fieldValue()
      target.sendInputEvent({ type: 'keyDown', keyCode: k })
      // a character, or Enter's newline: the editor inserts on the char event
      if (k.length === 1 || k === 'Enter') target.sendInputEvent({ type: 'char', keyCode: k })
      target.sendInputEvent({ type: 'keyUp', keyCode: k })
      for (let i = 0; i < 40 && (await fieldValue()) === before; i++) await sleep(10)
      await sleep(60)
    }
    // the same keydown, then the edit the browser would have made
    const synthetic = async k => {
      await target.executeJavaScript(`(() => { const t = document.activeElement, key = ${JSON.stringify(k)}
        t.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
        if (key === 'Backspace') { const p = t.selectionStart; if (p > 0) t.setRangeText('', p - 1, p, 'end') }
        else t.setRangeText(key === 'Enter' ? '\\n' : key, t.selectionStart, t.selectionEnd, 'end')
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

    // Past a full line (user report 2026-10-16, 4.3.1-alpha.1: the sparks
    // stayed at the end of the first line instead of following the caret onto
    // the second). Each desk's composer is made narrow, holding the start of a
    // sentence with room for one more short word; typing the rest wraps the
    // next word onto the second line, the keystroke that moves it included.
    // Enter then starts a third line, which scrolls the two-row box and brings
    // in its scrollbar, narrowing the lines; typing goes on there, and
    // Backspace. The fixture's true caret breaks the text into lines itself,
    // and every record's count of lines is checked against the textarea's own.
    // The last case is a popped-out desk window (user ask 2026-10-16): opened
    // by the page the way popout.tsx opens one, registered with the director,
    // which gives it its own stage and key listeners, and typed into with
    // native keys addressed to that window. Every wrap frame carries a green
    // ring where the director drew the sparks and a magenta dot at the true
    // caret, so a frame shows where the sparks start, not where they drift.
    const WRAP_START = 'the sparks follow', WRAP_FITS = ' the', WRAP_TYPED = ' the caret'
    const wrapCases = [...typingCases, { name: 'popout', theme: 'charcoal', z: 3.75, desks: ['dave'], popped: true }]
    for (const c of wrapCases) {
      for (const desk of c.desks) {
        await typingPage(c.z, c.theme)
        target = win.webContents
        if (c.popped) {
          // inside a user gesture, as the real pop-out is
          if (!(await win.webContents.executeJavaScript(`window.__typing.popout(${JSON.stringify(desk)})`, true))) throw new Error('the popped-out desk window did not open')
          await waitFor(`window.__typing.popoutReady()`, 'the popped-out desk window')
          if (!popout) throw new Error('the main process saw no popped-out window')
          target = popout.webContents
        }
        const shotWrap = n => target === win.webContents ? shot(n) : shotIn(target, n)
        const width = await js(`window.__typing.narrow(${JSON.stringify(desk)}, ${JSON.stringify(WRAP_START)}, ${JSON.stringify(WRAP_FITS)})`)
        const focused = await focusAt(desk, 'end')
        target.focus()
        // the combo decays after 2.5 s, so the 10th key's milestone flare stays out of this caret cue
        await sleep(3000)
        await typeText(WRAP_TYPED.slice(0, -1))
        await sleep(3000)
        await typeText(WRAP_TYPED.slice(-1))
        const name = `typing-wrap-${c.name}-${desk}`
        await js(`window.__typing.mark(); true`)
        await shotWrap(name)
        await js(`window.__typing.unmark(); true`)
        await press('Enter')
        await typeText('go')
        await js(`window.__typing.mark(); true`)
        await shotWrap(`${name}-scrolled`)
        await js(`window.__typing.unmark(); true`)
        await press('Backspace')
        const state = await js(`(() => { const f = window.__typing.field(${JSON.stringify(desk)}), d = ${JSON.stringify(desk)}
          return { value: f.value, scale: Number(f.dataset.scale), carets: window.__typing.carets.splice(0),
            stage: window.__typing.stageBox(d), size: window.__typing.viewSize(d) } })()`)
        const expected = WRAP_START + WRAP_TYPED + '\ng'
        const want = WRAP_TYPED.length + 4
        const off = state.carets.map((r, i) => ({ kind: r.kind, typed: r.typed, caret: r.caret, line: r.line, lines: r.lines, areaLines: r.areaLines,
          scrollTop: r.scrollTop, dx: +(r.x - r.tx).toFixed(2), dy: +(r.y - r.ty).toFixed(2),
          drawn: r.drawn.length, drawnOff: r.drawn.length ? +Math.max(...r.drawn.map(d => Math.hypot(d.x - r.x, d.y - r.y))).toFixed(3) : null,
          sincePrevious: i ? Math.round(r.t - state.carets[i - 1].t) : null }))
        const worst = axis => off.length ? Math.max(...off.map(o => Math.abs(o[axis]))) : null
        const enter = off.findIndex(o => o.kind === 'enter')
        const receipt = {
          typing: `wrap-${c.name}`, theme: c.theme, z: c.z, desk, scale: state.scale, width, input, focused, poppedOut: !!c.popped,
          shots: [name, `${name}-scrolled`],
          value: state.value, valueAsTyped: state.value === expected,
          effects: off.length, effectsExpected: want, onlyThisDesk: state.carets.every(r => r.desk === desk),
          kinds: off.map(o => o.kind).join(','), lineOfEach: off.map(o => o.line).join(','),
          // the model of the wrapping agrees with the textarea, every time
          linesAsLaidOut: off.length > 0 && off.every(o => o.lines === o.areaLines),
          // typing went onto a second line before any Enter, and the box scrolled
          wrapped: enter > 0 && off.slice(0, enter).some(o => o.kind === 'type' && o.line >= 1),
          scrolled: off.some(o => o.scrollTop > 0),
          maxDx: worst('dx'), maxDy: worst('dy'), tolerance: TOLERANCE,
          drawnAtSpot: off.length > 0 && off.every(o => o.drawn > 0 && o.drawnOff <= 0.01),
          stageIsWindow: !!state.stage && state.stage.left === 0 && state.stage.top === 0
            && state.stage.width === state.size.w && state.stage.height === state.size.h,
          perEffect: off,
        }
        receipt.atCaret = receipt.valueAsTyped && receipt.effects === want && receipt.onlyThisDesk && receipt.linesAsLaidOut
          && receipt.wrapped && receipt.scrolled
          && receipt.maxDx <= TOLERANCE && receipt.maxDy <= TOLERANCE && receipt.drawnAtSpot && receipt.stageIsWindow
        if (!receipt.atCaret) failed.push(`wrap-${c.name}/${desk}: maxDx ${receipt.maxDx} maxDy ${receipt.maxDy} effects ${receipt.effects}/${want} value ${receipt.valueAsTyped} lines ${receipt.linesAsLaidOut} wrapped ${receipt.wrapped} scrolled ${receipt.scrolled}`)
        receipts.push(receipt)
        await js(`window.__epic.stop(); true`)
        if (c.popped) { await js(`window.__typing.popoutClose(); true`); popout = null }
        target = win.webContents
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

    // ── blur: the whole window, or only its edges ────────────────────────
    // (docket epic-mode-next-round-more-shake-and-blur-a-small, part 1). The
    // stage scene in Charcoal, with a stage of its own blurring the app behind
    // it (no director: nothing drawn over the blur), photographed before, at
    // the peak of a whole-window blur and of an edge blur, and after each.
    // Sharpness is the mean difference in brightness between horizontally
    // neighbouring pixels in a box: a blur lowers it. The whole-window blur
    // must soften the middle and the edge alike; the edge blur the edge only,
    // the middle staying sharp; and each must leave nothing behind.
    {
      await win.loadURL(`${url}/fixture.html?scene=stage&n=${++loads}`)
      await waitFor(`!!window.__blurStage && document.querySelectorAll('[data-first-use-agent]').length === 6`, 'the fixture org')
      await js(`window.__contrast('charcoal'); true`)
      await sleep(300)
      const sharpness = (image, r) => {
        const { width } = image.getSize()
        const bmp = image.toBitmap()
        const lum = (x, y) => { const i = (y * width + x) * 4; return 0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2] }
        let sum = 0, n = 0
        for (let y = r.top; y < r.bottom; y++) for (let x = r.left; x < r.right - 1; x++) { sum += Math.abs(lum(x + 1, y) - lum(x, y)); n++ }
        return n ? sum / n : 0
      }
      const MID = { left: 400, top: 290, right: 600, bottom: 430 }
      // the inbox bell in the top-right corner: deep in the edge blur's mask
      // and detailed enough to tell a blur by (the bare canvas along the left
      // edge holds only the faint dot grid, too flat to measure)
      const EDGE = await js(`(() => { const b = document.querySelector('.ask-bell').getBoundingClientRect()
        return { left: Math.round(b.left) - 6, top: Math.round(b.top) - 4, right: Math.round(b.right) + 6, bottom: Math.round(b.bottom) + 6 } })()`)
      const measure = image => ({ middle: +sharpness(image, MID).toFixed(3), edge: +sharpness(image, EDGE).toFixed(3) })
      const base = measure(await shot('blur-before'))
      // a blur peaks 30% of the way through (0.21 s of 0.7 s), and a shot
      // lands about 100 ms after it is asked for
      const peakOf = async (o, name) => {
        await js(`window.__blurStage.blur(${JSON.stringify(o)}); true`)
        await sleep(110)
        const peak = measure(await shot(name))
        await sleep(900)
        const layers = await js(`document.querySelectorAll('[data-epic="blur"]').length`)
        const after = measure(await shot(name + '-after'))
        return { peak, after, layers }
      }
      const whole = await peakOf({ px: 6, ms: 700 }, 'blur-window')
      const edges = await peakOf({ px: 10, ms: 700, edges: true }, 'blur-edges')
      await js(`window.__blurStage.stop(); true`)
      const ratio = (a, b) => b ? +(a / b).toFixed(2) : null
      const q = {
        wholeMiddle: ratio(whole.peak.middle, base.middle), wholeEdge: ratio(whole.peak.edge, base.edge),
        edgesMiddle: ratio(edges.peak.middle, base.middle), edgesEdge: ratio(edges.peak.edge, base.edge),
        wholeAfter: ratio(whole.after.middle, base.middle), edgesAfter: ratio(edges.after.edge, base.edge),
      }
      const receipt = { blur: 'charcoal', boxes: { middle: MID, edge: EDGE }, base, whole, edges, ratios: q }
      receipt.textured = base.middle >= 0.5 && base.edge >= 0.5
      receipt.wholeSoftens = q.wholeMiddle <= 0.8 && q.wholeEdge <= 0.8
      receipt.edgesOnly = q.edgesEdge <= 0.8 && q.edgesMiddle >= 0.9
      receipt.clears = Math.abs(q.wholeAfter - 1) <= 0.1 && Math.abs(q.edgesAfter - 1) <= 0.1 && whole.layers === 0 && edges.layers === 0
      receipt.pass = receipt.textured && receipt.wholeSoftens && receipt.edgesOnly && receipt.clears
      receipts.push(receipt)
      write(false)
      if (!receipt.pass) throw new Error('blur not as specified: ' + JSON.stringify(q) + ' base ' + JSON.stringify(base))
    }

    // ── lingering: what strikes leave behind ─────────────────────────────
    // (docket epic-mode-next-round-more-shake-and-blur-a-small, part 4). On a
    // stage of its own in the stage scene (Charcoal): frost on carol's card,
    // cracks at the top right, a meteor's scorch and embers at the bottom
    // left, an afterglow, and confetti and coins falling to the floor. Each
    // place is compared with the picture before, pixel by pixel (the share of
    // pixels whose brightness moved by 8 or more): changed 6 s on, the frost
    // and the floor still there 13 s on, and as before 31 s on, with nothing
    // left and no frame drawn. While only residue is left, the stage draws
    // about 15 frames a second (the capture paints at 30).
    {
      await win.loadURL(`${url}/fixture.html?scene=stage&n=${++loads}`)
      await waitFor(`!!window.__lingerStage && document.querySelectorAll('[data-first-use-agent]').length === 6`, 'the fixture org')
      await js(`window.__contrast('charcoal'); true`)
      await sleep(300)
      const carol = await js(`(() => { const r = document.querySelector('[data-first-use-agent="carol"]').getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } })()`)
      const PLACES = {
        frost: { left: carol.left - 6, top: carol.top - 6, right: carol.right + 6, bottom: carol.bottom + 6 },
        cracks: { left: 760, top: 80, right: 960, bottom: 260 },
        scorch: { left: 130, top: 560, right: 210, bottom: 640 },
        afterglow: { left: 260, top: 600, right: 400, bottom: 690 },
        floor: { left: 0, top: 690, right: 1000, bottom: 700 },
      }
      const lum = (bmp, i) => 0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2]
      /** the share of a place's pixels whose brightness moved by 8 or more */
      const moved = (a, b, r) => {
        const { width, height } = a.getSize()
        const pa = a.toBitmap(), pb = b.toBitmap()
        let n = 0, changed = 0
        for (let y = Math.max(0, Math.round(r.top)); y < Math.min(height, Math.round(r.bottom)); y++) {
          for (let x = Math.max(0, Math.round(r.left)); x < Math.min(width, Math.round(r.right)); x++) {
            const i = (y * width + x) * 4
            n++
            if (Math.abs(lum(pa, i) - lum(pb, i)) >= 8) changed++
          }
        }
        return n ? +(changed / n).toFixed(4) : 0
      }
      const compare = (image, base) => Object.fromEntries(Object.entries(PLACES).map(([k, r]) => [k, moved(image, base, r)]))
      const base = await shot('linger-before')
      await js(`window.__lingerStage.strike(); true`)
      const started = Date.now()
      // each shot lands about 100 ms after it is asked for
      const at = async ms => { const left = ms - 100 - (Date.now() - started); if (left > 0) await sleep(left) }
      await at(1500)
      await shot('linger-fresh')
      await at(6000)
      const s6 = compare(await shot('linger-6s'), base)
      const kinds6 = await js(`window.__lingerStage.lingering().map(r => r.kind)`)
      await at(6500)
      const f0 = await js(`window.__lingerStage.frames()`)
      await at(8500)
      const fps = (await js(`window.__lingerStage.frames()`) - f0) / 2
      await at(13000)
      const s13 = compare(await shot('linger-13s'), base)
      await at(31000)
      const gone = compare(await shot('linger-gone'), base)
      const left31 = await js(`window.__lingerStage.lingering().length`)
      const g0 = await js(`window.__lingerStage.frames()`)
      await sleep(1000)
      const framesAfter = await js(`window.__lingerStage.frames()`) - g0
      await js(`window.__lingerStage.stop(); true`)
      const receipt = { linger: 'charcoal', places: PLACES, s6, s13, gone, kinds6, fps, left31, framesAfter }
      receipt.showed = Object.values(s6).every(v => v >= 0.01)
      receipt.lingered = s13.frost >= 0.01 && s13.floor >= 0.01
      receipt.cleared = Object.values(gone).every(v => v <= 0.001) && left31 === 0 && framesAfter === 0
      receipt.slow = fps >= 8 && fps <= 17
      receipt.pass = receipt.showed && receipt.lingered && receipt.cleared && receipt.slow
      receipts.push(receipt)
      write(false)
      if (!receipt.pass) throw new Error('lingering not as specified: ' + JSON.stringify({ s6, s13, gone, kinds6, fps, left31, framesAfter }))
    }
    write(true)
  } finally { win.destroy() }
}).then(() => app.exit(0), error => {
  fs.writeFileSync(path.join(root, 'visual-error.txt'), String(error && error.stack || error))
  app.exit(1)
})
