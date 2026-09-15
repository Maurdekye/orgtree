// THE NARROW-MODAL LIST OVERLAY, IN A REAL WINDOW.
//
// jsdom has no layout, so it can say a class was applied and nothing about
// whether the result is usable. This mounts the ACTUAL email modal
// (NodeInboxModal) and the ACTUAL presentations modal (DocGalleryModal)
// against fixture API responses, in a real production-shaped Electron window,
// resizes that window across the threshold, and both measures and photographs
// what happens.
//
// What it proves, in order: wide widths are untouched; narrow widths replace
// the column with a rail control; the control opens an overlay panel over the
// reading pane; the list's scroll position and selection survive the round
// trip; the hidden list is out of the tab order; Escape closes the panel and
// leaves the modal open.
import { app, BrowserWindow, ipcMain, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { Preferences } from '../apps/desktop/main/preferences'
import { configureEngineSession, configureWindow } from '../apps/desktop/main/windows'

const root = process.env.ORGTREE_NARROWLIST_TEST_ROOT!
const shots = process.env.ORGTREE_NARROWLIST_SHOTS || root
app.disableHardwareAcceleration()
app.setPath('userData', path.join(root, 'profile'))
let server: http.Server

const iso = (n: number) => new Date(Date.UTC(2026, 8, 15, 12, 0, 0) - n * 60000).toISOString()
const MAIL = {
  pending: Array.from({ length: 6 }, (_, i) => ({
    id: `p${i}`, from: `agent-${i}`, kind: 'message', at: iso(i),
    body: `Pending message ${i}. ` + 'The reading pane needs room for prose like this sentence, which is why a narrow modal cannot afford a permanent column beside it. '.repeat(3),
  })),
  delivered: Array.from({ length: 24 }, (_, i) => ({
    id: `d${i}`, from: `agent-${i % 7}`, kind: 'message', at: iso(i + 10),
    body: `Delivered message ${i}. ` + 'A body long enough to wrap, so the pane width is visible in the capture rather than inferred. '.repeat(4),
  })),
  sent: [],
}
const DOCS = {
  documents: Array.from({ length: 22 }, (_, i) => ({
    id: `doc${i}`, node: `agent-${i % 5}`, title: `Presented document number ${i}`,
    at: iso(i * 7), format: 'markdown', bytes: 900 + i, evicted: false,
    node_state: 'live', tier: i % 2 ? 'opus' : 'astra',
  })),
  total: 22, next_offset: null, offset: 0,
}

app.whenReady().then(async () => {
  async function screenshot(w: BrowserWindow, name: string) {
    // ⚠ WAIT FOR A REAL FRAME. capturePage reads the compositor, which is a
    // step behind the DOM — without this the picture can disagree with what
    // getBoundingClientRect and elementFromPoint both say is on screen, and
    // the picture is the one that is wrong.
    await w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))')
    await new Promise((r) => setTimeout(r, 120))
    let png: Buffer
    try { png = (await w.webContents.capturePage()).toPNG() }
    catch {
      w.webContents.debugger.attach('1.3')
      try {
        const r = await w.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: false })
        png = Buffer.from(r.data, 'base64')
      } finally { w.webContents.debugger.detach() }
    }
    fs.writeFileSync(path.join(shots, name + '.png'), png)
  }
  const prefs = new Preferences(path.join(root, 'preferences.json'))
  ipcMain.handle('desktop:preferences', () => prefs.get())
  ipcMain.handle('desktop:window-state', () => ({ visible: true, restoreWindows: false }))
  ipcMain.handle('desktop:set-effective-theme', () => {})
  ipcMain.handle('desktop:set-preferences', (_e, patch) => prefs.set(patch))

  server = http.createServer((req, res) => {
    const url = req.url || '/'
    if (url === '/narrowlist.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(root, 'narrowlist.js'))); return }
    if (url === '/narrowlist.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(root, 'narrowlist.css'))); return }
    if (url.startsWith('/api/orgs/demo/documents')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(DOCS)); return }
    if (url.includes('/inbox')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(MAIL)); return }
    if (url.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); res.end('{}'); return }
    res.setHeader('Content-Type', 'text/html')
    res.end('<link rel="stylesheet" href="/narrowlist.css"><div id="root"></div><script src="/narrowlist.js"></script>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const register = configureEngineSession(session.defaultSession, origin, 'narrowlist-fixture')
  const win = new BrowserWindow({
    show: true, width: 1100, height: 780, frame: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(root, 'preload.cjs'), additionalArguments: [`--orgtree-ui-origin=${origin}`], sandbox: true, nodeIntegration: false, contextIsolation: true },
  })
  configureWindow(win, origin, true, register, () => {})
  win.webContents.on('console-message', (e) => console.log('renderer', e.message))
  await win.loadURL(origin)

  const waitFor = async (code: string, why: string) => {
    for (let i = 0; i < 200; i++) {
      if (await win.webContents.executeJavaScript(code)) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw Error(`timed out waiting for ${why}: ${code}`)
  }
  const js = <T = any>(code: string): Promise<T> => win.webContents.executeJavaScript(code)
  const resize = async (w: number) => {
    win.setContentSize(w, 780)
    // a VISIBLE window resizes asynchronously: wait for the renderer to agree
    for (let i = 0; i < 60; i++) {
      const got = await win.webContents.executeJavaScript('innerWidth')
      if (Math.abs(got - w) <= 2) break
      await new Promise((r) => setTimeout(r, 50))
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  // the geometry every assertion below is written against
  const probe = `(()=>{
    const m=document.querySelector('.mailer'); if(!m) return null
    const wrap=m.querySelector('.mailer-listwrap')
    const list=m.querySelector('.mailer-list')
    const read=m.querySelector('.mailer-read')
    const rail=m.querySelector('.mailer-listrail')
    const btn=m.querySelector('.mailer-listtoggle')
    const r=(el)=>{ if(!el) return null; const b=el.getBoundingClientRect(); return {x:Math.round(b.x),w:Math.round(b.width),h:Math.round(b.height)} }
    return {
      mailer:r(m), list:r(list), read:r(read), rail:r(rail),
      narrow:m.classList.contains('narrow-list'),
      open:m.classList.contains('narrow-list-open'),
      wrapDisplay:wrap?getComputedStyle(wrap).display:null,
      wrapTransform:wrap?getComputedStyle(wrap).transform:null,
      wrapRect:r(wrap),
      mailerOverflow:getComputedStyle(m).overflow,
      mailerPosition:getComputedStyle(m).position,
      wrapPosition:wrap?getComputedStyle(wrap).position:null,
      inert:wrap?wrap.hasAttribute('inert'):null,
      expanded:btn?btn.getAttribute('aria-expanded'):null,
      controls:btn?btn.getAttribute('aria-controls')===wrap.id:null,
      veil:!!m.querySelector('.mailer-listveil'),
      rows:m.querySelectorAll('.mailrow').length,
      selected:m.querySelector('.mailrow.on')?.textContent?.slice(0,40)??null,
      scrollTop:list?Math.round(list.scrollTop):null,
      panelLabel:wrap?wrap.getAttribute('aria-label'):null,
      modal:!!document.querySelector('.settings'),
    }})()`

  const evidence: Record<string, any> = {}

  // ---------------------------------------------------------------- email
  await js(`window.__mount('mail');true`)
  await waitFor(`document.querySelectorAll('.mailrow').length>0`, 'the email modal to render rows')
  await resize(1100)
  const mailWide = await js(probe)
  assert.equal(mailWide.narrow, false, 'a 1100px window keeps the email modal persistent list')
  assert.ok(mailWide.list.w > 140, 'the persistent list has real width')
  assert.equal(mailWide.wrapDisplay, 'contents', 'wide: the wrapper is not a box at all')
  assert.equal(mailWide.inert, false, 'wide: the list is reachable')
  assert.equal(mailWide.rail, null, 'wide: no rail control')
  await screenshot(win, 'mail-1100-wide')
  evidence.mailWide = mailWide

  // pick a row and scroll the list — this is the state that must survive
  await js(`(()=>{const l=document.querySelector('.mailer-list');l.scrollTop=420;
    document.querySelectorAll('.mailrow')[7].click();return true})()`)
  await new Promise((r) => setTimeout(r, 250))
  const seeded = await js(probe)
  assert.ok(seeded.scrollTop > 200, 'the list really is scrolled before collapsing')
  assert.ok(seeded.selected, 'a row really is selected before collapsing')
  evidence.seeded = seeded

  await resize(560)
  const mailNarrow = await js(probe)
  assert.equal(mailNarrow.narrow, true, 'a 560px window collapses the email modal list')
  assert.equal(mailNarrow.wrapPosition, 'absolute', 'narrow: the list is an overlay panel')
  assert.equal(mailNarrow.inert, true, 'narrow+closed: the hidden list is inert')
  assert.ok(mailNarrow.rail && mailNarrow.rail.w > 0, 'narrow: a rail control is present')
  assert.equal(mailNarrow.expanded, 'false', 'narrow+closed: aria-expanded says so')
  assert.equal(mailNarrow.controls, true, 'the control points at the panel it opens')
  assert.ok(mailNarrow.read.w > mailWide.read.w * 0.55, 'the reading pane gained the list column')
  assert.equal(mailNarrow.selected, seeded.selected, 'collapsing preserved the selection')
  await screenshot(win, 'mail-560-collapsed')
  evidence.mailNarrow = mailNarrow

  // THE HIDDEN LIST IS REALLY UNREACHABLE, not merely styled away. `inert` is
  // what does it, so the check is the one thing `inert` guarantees: a focus
  // call on a descendant that would otherwise take focus does nothing at all.
  const reachable = await js(`(()=>{
    const w=document.querySelector('.mailer-listwrap')
    const cands=[...w.querySelectorAll('input,button,[tabindex]')].filter(e=>e.tabIndex>=0)
    let took=0
    for(const el of cands){ el.focus(); if(document.activeElement===el) took++ }
    return {cands:cands.length, took}})()`)
  assert.ok(reachable.cands > 0, 'the hidden list does hold focusable controls — the check is not vacuous')
  assert.equal(reachable.took, 0, 'narrow+closed: none of them can actually take focus')
  evidence.inertControl = reachable

  await js(`document.querySelector('.mailer-listtoggle').click();true`)
  await new Promise((r) => setTimeout(r, 400))
  const mailOpen = await js(probe)
  assert.equal(mailOpen.open, true, 'the control opens the overlay')
  assert.equal(mailOpen.expanded, 'true', 'open: aria-expanded says so')
  assert.equal(mailOpen.inert, false, 'open: the list is reachable again')
  assert.equal(mailOpen.veil, true, 'open: a veil sits between the panel and the pane')
  assert.ok(Math.abs(mailOpen.wrapRect.x - (mailOpen.rail.x + mailOpen.rail.w)) <= 2,
    `the open panel sits BESIDE the rail, not under it (panel ${mailOpen.wrapRect.x}, rail ends ${mailOpen.rail.x + mailOpen.rail.w})`)
  assert.notEqual(mailOpen.wrapTransform, mailNarrow.wrapTransform, 'closed and open are different transforms')
  assert.ok(mailNarrow.wrapRect.x + mailNarrow.wrapRect.w <= mailNarrow.mailer.x + 2,
    `closed, the panel is entirely off the left edge (right edge ${mailNarrow.wrapRect.x + mailNarrow.wrapRect.w}, modal starts ${mailNarrow.mailer.x})`)
  assert.ok(mailOpen.list.w > 200, 'the open panel is wide enough to read rows in')
  assert.equal(mailOpen.scrollTop, seeded.scrollTop, 'the overlay reopened at the scroll position it was left at')
  assert.equal(mailOpen.selected, seeded.selected, 'the overlay reopened on the same selection')
  const focused = await js(`document.activeElement?.className||''`)
  assert.ok(String(focused).includes('mailer-listwrap'), 'opening moved focus into the panel, got: ' + focused)
  await screenshot(win, 'mail-560-open')
  evidence.mailOpen = mailOpen

  // Escape closes the PANEL and leaves the modal standing
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`)
  await new Promise((r) => setTimeout(r, 350))
  const afterEsc = await js(probe)
  assert.equal(afterEsc.open, false, 'Escape closed the overlay')
  assert.equal(afterEsc.modal, true, 'Escape did NOT also close the modal behind it')
  const backToButton = await js(`document.activeElement?.className||''`)
  assert.ok(String(backToButton).includes('mailer-listtoggle'), 'closing returned focus to the control, got: ' + backToButton)
  evidence.afterEsc = afterEsc

  // a second Escape is the modal's again
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`)
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(await js(`!!document.querySelector('.settings')`), false, 'the next Escape closes the modal as it always did')

  // THE NARROWEST A PINNED MODAL CAN BE — 320px is the floor in
  // windowlayout.ts, so 400px is a width a user can really put this in.
  await js(`window.__mount('mail');true`)
  await waitFor(`document.querySelectorAll('.mailrow').length>0`, 're-mounted email modal')
  await resize(400)
  const mailTiny = await js(probe)
  assert.equal(mailTiny.narrow, true, '400px stays collapsed')
  assert.ok(mailTiny.read.w > 250, 'at 400px the reading pane has the whole modal, got ' + mailTiny.read.w)
  await screenshot(win, 'mail-400-collapsed')
  await js(`document.querySelector('.mailer-listtoggle').click();true`)
  await new Promise((r) => setTimeout(r, 400))
  const tinyOpen = await js(probe)
  assert.equal(tinyOpen.open, true, 'the overlay opens at 400px too')
  assert.ok(tinyOpen.wrapRect.w >= 200, 'even at 400px the panel is readable, got ' + tinyOpen.wrapRect.w)
  assert.ok(tinyOpen.wrapRect.x + tinyOpen.wrapRect.w <= tinyOpen.mailer.x + tinyOpen.mailer.w + 2,
    'the open panel stays inside the modal')
  await screenshot(win, 'mail-400-open')
  evidence.mailTiny = mailTiny
  evidence.tinyOpen = tinyOpen

  // PICKING A ROW IN THE OVERLAY closes it, the way the canvas drawer closes
  // when you pick an org — the panel is covering what the click asked to read.
  await js(`document.querySelectorAll('.mailer-listwrap .mailrow')[3].click();true`)
  await new Promise((r) => setTimeout(r, 350))
  const picked = await js(probe)
  assert.equal(picked.open, false, 'picking a row closed the overlay')
  assert.ok(picked.selected, 'picking a row selected it')
  await screenshot(win, 'mail-400-after-pick')
  evidence.picked = picked

  // widening puts the column back and closes the overlay
  await resize(1100)
  const widened = await js(probe)
  assert.equal(widened.narrow, false, 'widening restores the persistent column')
  assert.equal(widened.open, false, 'widening closes the overlay')
  assert.equal(widened.wrapDisplay, 'contents', 'widening returns the list to the flex layout')
  assert.equal(widened.selected, picked.selected, 'widening preserved the selection made in the overlay')
  assert.ok(widened.list.w > 140 && widened.list.w < widened.mailer.w / 2,
    'widening gave the list its column back')
  evidence.widened = widened
  await screenshot(win, 'mail-1100-restored')

  // -------------------------------------------------------- presentations
  await js(`window.__mount('gallery');true`)
  await waitFor(`document.querySelectorAll('.doc-gallery-row').length>0`, 'the presentations modal to render rows')
  await resize(1100)
  const docWide = await js(probe)
  assert.equal(docWide.narrow, false, 'a 1100px window keeps the presentations list persistent')
  await screenshot(win, 'gallery-1100-wide')
  evidence.docWide = docWide

  await js(`(()=>{const l=document.querySelector('.mailer-list');l.scrollTop=300;
    document.querySelectorAll('.doc-gallery-row')[4].click();return true})()`)
  await new Promise((r) => setTimeout(r, 300))
  const docSeeded = await js(probe)

  await resize(560)
  const docNarrow = await js(probe)
  assert.equal(docNarrow.narrow, true, 'a 560px window collapses the presentations list')
  assert.equal(docNarrow.inert, true, 'narrow+closed: the presentations list is inert')
  assert.ok(docNarrow.rail && docNarrow.rail.w > 0, 'narrow: the presentations modal has a rail control')
  assert.equal(docNarrow.panelLabel, 'document list', 'the panel names itself for a screen reader')
  assert.equal(docNarrow.selected, docSeeded.selected, 'collapsing preserved the open document')
  await screenshot(win, 'gallery-560-collapsed')
  evidence.docNarrow = docNarrow

  await js(`document.querySelector('.mailer-listtoggle').click();true`)
  await new Promise((r) => setTimeout(r, 400))
  const docOpen = await js(probe)
  assert.equal(docOpen.open, true, 'the presentations overlay opens')
  assert.equal(docOpen.scrollTop, docSeeded.scrollTop, 'the presentations overlay kept its scroll position')
  await screenshot(win, 'gallery-560-open')
  evidence.docOpen = docOpen

  // the veil is a real dismissal target
  await js(`document.querySelector('.mailer-listveil').click();true`)
  await new Promise((r) => setTimeout(r, 350))
  const docVeil = await js(probe)
  assert.equal(docVeil.open, false, 'a click off the panel closes it')
  assert.equal(docVeil.modal, true, 'and leaves the modal open')
  assert.equal(docVeil.selected, docSeeded.selected, 'and keeps the document that was open')

  await resize(400)
  await screenshot(win, 'gallery-400-collapsed')
  await js(`document.querySelector('.mailer-listtoggle').click();true`)
  await new Promise((r) => setTimeout(r, 400))
  await screenshot(win, 'gallery-400-open')

  evidence.pass = true
  evidence.shots = fs.readdirSync(shots).filter((f) => f.endsWith('.png'))
  fs.writeFileSync(path.join(shots, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ pass: true, shots: evidence.shots, dir: shots }))
  win.destroy(); server.close(); app.exit(0)
}).catch((e) => { console.error(e); server?.close(); app.exit(1) })
