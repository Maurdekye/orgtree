// tools/rig/desktop/app-window-pin.cjs: the panel window pin for
// tools/rig/proofs/app-window-pin.mjs (USER 2026-10-26 "i meant pin it to the
// window like other pinned panels", "Remove canvas pinning"). The real renderer
// bundle runs against the isolated rig engine in the rig's offscreen window;
// input goes only through CDP to that window. It refuses to run outside
// Session 0, refuses every permission request and replaces each page clipboard
// path with a refusal.
'use strict'
const { session } = require('electron')
const { execFileSync } = require('node:child_process')

// Every page clipboard path refuses, from document start.
const CLIPBOARD = `(() => {
  const calls = []; Object.defineProperty(window, '__clipboardCalls', { value: calls })
  const deny = name => () => { calls.push(name); return Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')) }
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.freeze({ read: deny('read'), readText: deny('readText'), write: deny('write'), writeText: deny('writeText') }) }) } catch { calls.push('stub failed') }
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (command, ...rest) { if (/^(copy|cut|paste)$/i.test(String(command))) { calls.push('execCommand:' + command); return false } return exec.call(this, command, ...rest) }
})()`

module.exports = async (page, { org, args }) => {
  const wc = page.win.webContents, sleep = page.sleep, P = args.panel
  const R = { phase: args.phase, steps: [] }
  const note = (name, detail) => { R.steps.push({ at: new Date().toISOString(), name, ...(detail === undefined ? {} : { detail }) }); page.log(name, detail === undefined ? '' : JSON.stringify(detail)) }
  const sessionId = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
  R.session = { electronPid: process.pid, sessionId, rendererPid: wc.getOSProcessId() }
  if (sessionId !== 0) throw new Error(`refusing to run outside Windows Session 0 (this Electron runs in Session ${sessionId})`)
  const permissions = { requests: [], clipboardChecks: 0 }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => { permissions.requests.push(permission); callback(false) })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => { if (/clipboard/i.test(permission)) { permissions.clipboardChecks++; return false } return true })
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: CLIPBOARD })
  await page.goto('/o/' + org)
  await page.waitFor('.apps-button', { timeout: 30000 })
  R.installed = await page.eval(() => ({ clipboardStub: Array.isArray(window.__clipboardCalls) }))
  if (!R.installed.clipboardStub) throw new Error('the clipboard refusal did not install')
  R.window = await page.eval(() => ({ w: innerWidth, h: innerHeight }))

  const sel = `[data-custom-panel="${P.id}"]`
  const until = async (fn, arg, timeout = 10000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) { if (await page.eval(fn, arg)) return true; await sleep(200) }
    return false
  }
  const panel = () => page.eval(s => {
    const e = document.querySelector(s); if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), inLayer: !!e.closest('.pin-layer'), centered: e.hasAttribute('data-centered'), pinned: e.hasAttribute('data-pinned'), zIndex: getComputedStyle(e).zIndex, pin: e.querySelector('.custom-app-title [aria-pressed]')?.getAttribute('aria-label') ?? null }
  }, sel)
  const area = () => page.eval(() => { const e = document.querySelector('[data-pin-org]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })
  // The user's own node card lives in world space: it moves and scales with the camera.
  const node = () => page.eval(() => { const e = document.querySelector('.sq.user'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })
  const offers = () => page.eval(() => [...document.querySelectorAll('button,[role="menuitem"],[aria-label],[title]')]
    .map(e => [e.getAttribute('aria-label'), e.getAttribute('title'), e.matches('button,[role="menuitem"]') ? e.textContent : ''].filter(Boolean).join(' | '))
    .filter(t => /canvas/i.test(t) && /pin/i.test(t)))
  // An empty canvas point: inside the canvas area, on its background only.
  const empty = () => page.eval(s => {
    const a = document.querySelector('[data-pin-org]')?.getBoundingClientRect(); if (!a) return null
    for (let fy = 0.85; fy > 0.15; fy -= 0.05) for (let fx = 0.85; fx > 0.15; fx -= 0.05) {
      const x = Math.round(a.x + a.width * fx), y = Math.round(a.y + a.height * fy), e = document.elementFromPoint(x, y)
      if (e && e.closest('[data-pin-org]') && !e.closest('.sq,button,a,input,textarea,select,.pin-layer,.overlay,.tray,[role="dialog"],[role="menu"],' + s)) return { x, y, tag: e.tagName.toLowerCase(), cls: String(e.className?.baseVal ?? e.className ?? '').slice(0, 60) }
    }
    return null
  }, sel)
  const drag = async (from, dx, dy) => {
    await page.mouse('mouseMoved', from.x, from.y); await sleep(60)
    await page.mouse('mousePressed', from.x, from.y); await sleep(60)
    for (let i = 1; i <= 8; i++) { await page.mouse('mouseMoved', from.x + dx * i / 8, from.y + dy * i / 8); await sleep(40) }
    await page.mouse('mouseReleased', from.x + dx, from.y + dy); await sleep(500)
  }
  const wheel = async (at, deltaY) => { await page.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY }); await sleep(500) }

  await page.waitFor(`${sel} iframe`, { timeout: 30000 })
  await sleep(800)
  if (args.phase === 'pin') {
    // 1. The alpha.3 canvas pin, migrated, opens as the centered window.
    R.area = await area()
    R.before = await panel()
    R.panelOffers = await offers()
    await page.screenshot('01-upgraded-canvas-pin-opens-floating')
    note('floating', { before: R.before, area: R.area })
    // 2. The title-bar pin pins it to the window, in place.
    await page.click(`${sel} [aria-label="Pin to window"]`, { after: 900 })
    await until(s => document.querySelector(s)?.closest('.pin-layer'), sel)
    await sleep(400)
    R.pinned = await panel()
    R.saved = (await page.api('POST', `/api/orgs/${org}/apps`, { action: 'panel_get', panel: P.id })).placement
    await page.screenshot('02-pinned-to-the-window-in-place')
    note('pinned', { pinned: R.pinned, saved: R.saved })
    // The Apps list and a saved row's menu offer no canvas pin either (checked
    // pinned: a floating panel's backdrop covers the Apps button).
    await page.click('.apps-button', { after: 800 })
    await page.waitFor('.custom-apps-menu', { timeout: 10000 })
    R.menuOffers = await offers()
    const row = await page.eval(() => { const e = document.querySelector('.custom-apps-menu .custom-apps-saved-row'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 } })
    if (row) {
      await page.click(row, { button: 'right', after: 600 })
      R.rowMenu = await page.eval(() => [...document.querySelectorAll('.ctxmenu[role="menu"] [role="menuitem"], .ctxmenu[role="menu"] button')].map(e => e.textContent.trim()))
      R.rowMenuOffers = await offers()
      await page.screenshot('03-apps-list-and-row-menu')
      await page.press('Escape')
    }
    if (await page.eval(() => !!document.querySelector('.custom-apps-menu'))) await page.click('.apps-button', { after: 600 })
    await until(() => !document.querySelector('.custom-apps-menu'), undefined, 5000)
    // 3. The canvas pans and zooms under it; it stays put.
    R.emptyPoint = await empty()
    if (!R.emptyPoint) throw new Error('no empty canvas point to drag')
    R.nodeBefore = await node()
    await drag(R.emptyPoint, -260, -140)
    R.nodeAfterPan = await node(); R.afterPan = await panel()
    await page.screenshot('04-fixed-while-the-canvas-pans')
    const zoomAt = await empty()
    await wheel(zoomAt, -360)
    // already at the zoom limit: zoom the other way instead
    if ((await node())?.w === R.nodeAfterPan?.w) await wheel(zoomAt, 720)
    R.nodeAfterZoom = await node(); R.afterZoom = await panel()
    await page.screenshot('05-fixed-while-the-canvas-zooms')
    // 4. A wheel over the pinned panel's title bar leaves the camera alone.
    const title = await page.eval(s => { const r = document.querySelector(s + ' .custom-app-title strong').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }, sel)
    await wheel(title, -360)
    R.nodeAfterTitleWheel = await node()
    note('camera', { node: [R.nodeBefore, R.nodeAfterPan, R.nodeAfterZoom, R.nodeAfterTitleWheel], panel: [R.pinned, R.afterPan, R.afterZoom] })
  } else {
    // After an engine restart and a fresh renderer: restored pinned in place.
    R.area = await area()
    await until(s => document.querySelector(s)?.closest('.pin-layer'), sel)
    R.restored = await panel()
    R.saved = (await page.api('POST', `/api/orgs/${org}/apps`, { action: 'panel_get', panel: P.id })).placement
    R.panelOffers = await offers()
    await page.screenshot('06-restored-pinned-after-restart')
    note('restored', { restored: R.restored, saved: R.saved })
  }
  R.clipboard = { calls: await page.eval(() => window.__clipboardCalls.slice()), checks: permissions.clipboardChecks, requests: permissions.requests }
  return R
}
