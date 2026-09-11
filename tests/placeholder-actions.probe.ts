// placeholder-actions.probe.ts — do "Show desk" and "Return here" on the
// "…'s desk is open elsewhere." card placeholder actually DO anything?
// (user report 2026-09-11, uploads/image-78.png: neither one works.)
//
// WHY A REAL WINDOW AND REAL INPUT. Every press here is a Chromium input
// event delivered with `webContents.sendInputEvent`, never `element.click()`.
// That is the whole point: the first defect is that the viewport calls
// `setPointerCapture` on every left press that reaches it, after which
// Chromium retargets the compatibility mouse events — `click` included — at
// the capturing element, so a button that does not stop the pointerdown
// never hears about the press at all. `element.click()` dispatches straight
// at the element and would pass with the bug fully present: it would be a
// VACUOUS PASS, which is exactly the failure this file has to avoid.
//
// The second defect needs a real window for a different reason: revealing a
// popped-out desk means restoring and raising a NATIVE window, and
// `childWindow.focus()` from a renderer cannot do that. Only a real
// BrowserWindow can be asked whether it is still minimized.
//
//   node tools/test-placeholder-actions.mjs
import { app, BrowserWindow, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { popoutRegistry } from '../apps/desktop/main/windows'

const root = process.env.ORGTREE_PLACEHOLDER_ROOT!
const only = process.env.ORGTREE_PROBE_ONLY || ''
app.disableHardwareAcceleration(); app.setPath('userData', path.join(root, 'profile'))
app.on('window-all-closed', () => { /* the probe decides when to exit */ })

const log: string[] = []
const note = (line: string) => { log.push(line); console.log('  · ' + line) }

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    const file = req.url === '/fixture.js' ? 'fixture.js' : req.url === '/fixture.css' ? 'fixture.css' : null
    if (file) {
      res.setHeader('Content-Type', file.endsWith('js') ? 'text/javascript' : 'text/css')
      res.end(fs.readFileSync(path.join(root, file))); return
    }
    // ⚠ `.viewport` is `flex: 1; min-height: 0` (styles.css) — it has NO
    // height of its own and takes it from a flex-column parent. In the app
    // that parent is App.tsx's layout. A bare `#root` gives it nothing, the
    // canvas lays out a couple of px tall and every card falls outside it.
    res.end('<!doctype html><html><head><meta charset="utf-8">'
      + '<link rel="stylesheet" href="/fixture.css">'
      + '<style>html,body{margin:0;padding:0;width:100%;height:100%}'
      + '#root{display:flex;flex-direction:column;width:100%;height:100%}</style>'
      + '</head><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as import('node:net').AddressInfo).port

  // The real registry, wired to the real channel names. `configureWindow`
  // does exactly this in main/index.ts; the probe cannot call configureWindow
  // itself because that also installs navigation policy for a live origin.
  const popouts = popoutRegistry<BrowserWindow>(() => {})
  ipcMain.handle('desktop:popout-state', (_e, name) => typeof name === 'string' ? popouts.state(name) : null)
  ipcMain.handle('desktop:popout-minimize', (_e, name) => { popouts.window(name)?.minimize() })
  ipcMain.handle('desktop:popout-toggle-maximize', (_e, name) => { popouts.window(name)?.maximize() })
  ipcMain.handle('desktop:popout-close', (_e, name) => { popouts.window(name)?.close() })
  ipcMain.handle('desktop:popout-focus', (_e, name) => {
    const window = popouts.window(name)
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show(); window.focus()
  })

  const w = new BrowserWindow({ show: true, x: 40, y: 40, width: 1400, height: 900, frame: false,
    webPreferences: { sandbox: true, preload: path.join(root, 'preload.cjs') } })
  let popup: BrowserWindow | null = null
  w.webContents.setWindowOpenHandler(() => ({ action: 'allow',
    overrideBrowserWindowOptions: { show: true, x: 1500, y: 120, width: 620, height: 460, frame: false } }))
  w.webContents.on('did-create-window', (child, details) => {
    popup = child
    popouts.track(details.frameName, child)
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })

  const js = (code: string) => w.webContents.executeJavaScript(code)
  const settle = (ms: number) => new Promise(r => setTimeout(r, ms))
  const wait = async (code: string, what = code) => {
    for (let i = 0; i < 300; i++) { if (await js(code)) return; await settle(40) }
    throw new Error('timed out waiting for: ' + what)
  }
  const box = (sel: string) => js(`window.probeBox(${JSON.stringify(sel)})`) as Promise<{ x: number; y: number; w: number; h: number } | null>

  /** A REAL press and release at a point, through the browser's own input
   *  pipeline — so pointer capture, hit testing and click retargeting all
   *  behave as they do under a user's hand. */
  const pressAt = async (x: number, y: number) => {
    const at = { x: Math.round(x), y: Math.round(y) }
    w.webContents.sendInputEvent({ type: 'mouseMove', ...at, button: 'left', clickCount: 0 } as never)
    await settle(30)
    w.webContents.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 } as never)
    await settle(40)
    w.webContents.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 } as never)
    await settle(120)
  }
  /** The camera animates. A press aimed at a box that is still moving lands
   *  its mouseDown and its mouseUp on two different elements, and Chromium
   *  then fires `click` at their common ancestor — a harness artefact that
   *  looks exactly like the defect under test. Wait for stillness first. */
  const stillCamera = async () => {
    let last = ''
    for (let i = 0; i < 200; i++) {
      const now = await js(`(document.querySelector('.space')?.style.transform||'')
        + '|' + JSON.stringify(document.querySelector('.desk-over')?.getBoundingClientRect()||null)`) as string
      if (now === last) return
      last = now
      await settle(60)
    }
    throw new Error('the camera never settled')
  }
  /** Press the centre of a selector, first proving the engine agrees that a
   *  press there lands on that element. A "nothing happened" result is only
   *  evidence if the press was actually delivered to the control. */
  const press = async (sel: string, label = sel) => {
    await stillCamera()
    const b = await box(sel)
    assert.ok(b && b.w > 0 && b.h > 0, `${label} is laid out and pressable`)
    const hit = await js(`window.probeHit(${Math.round(b!.x)},${Math.round(b!.y)})`)
    await js(`window.probeClearClicks()`)
    await pressAt(b!.x, b!.y)
    const landed = await js(`window.probeClicks()`) as string[]
    note(`press ${label} at ${Math.round(b!.x)},${Math.round(b!.y)} → hit-test ${hit}`
      + ` → click delivered to ${landed.length ? landed.join(', ') : 'NOTHING'}`)
    return { hit: hit as string | null, landed }
  }

  await w.loadURL(`http://127.0.0.1:${port}`)
  await wait(`window.probeCount('.sq')>0`, 'the canvas renders cards')
  if (process.env.ORGTREE_PROBE_DUMP) {
    await settle(2500)
    note('cards: ' + JSON.stringify(await js(`[...document.querySelectorAll('.sq')].map(e=>e.className+'|'+JSON.stringify(e.getBoundingClientRect()))`)))
    note('space: ' + await js(`document.querySelector('.space')?.style.transform`))
  }

  // ── open the agent's desk the way a reader does: click its card ──────────
  await press('.sq:not(.user)', 'the agent card')
  await wait(`window.probeCount('.desk-over')===1`, 'the card opens its desk')
  note('desk open on the card')

  // desk state that must survive a pop-out and a return
  await js(`(()=>{const t=document.querySelector('.desk-over textarea');
    const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    set.call(t,'PRESERVE-ME'); t.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`)
  await settle(120)
  assert.equal(await js(`window.probeDraft()`), 'PRESERVE-ME', 'the composer holds the draft before the pop-out')

  // ── POSITIVE CONTROL for the whole harness ──────────────────────────────
  // The desk's own ↗ lives inside `.desk-over`, which DOES stop the
  // pointerdown. If a real press cannot work this button, nothing below
  // this line can be read as evidence about the placeholder's buttons.
  const control = await press('.desk-over .popout-button', 'the desk\'s own pop-out button')
  assert.match(String(control.hit), /button/, 'the press really lands on the pop-out button')
  assert.ok(control.landed.some(t => t.startsWith('button')),
    'CONTROL: a real press delivers its click TO the button it landed on')
  if (process.env.ORGTREE_PROBE_DUMP) {
    await settle(1500)
    note('popup window created: ' + !!popup)
    note('popout-placeholder: ' + await js(`window.probeCount('.popout-placeholder')`)
      + ' desk-elsewhere: ' + await js(`window.probeCount('.popout-placeholder.desk-elsewhere')`)
      + ' desk-over: ' + await js(`window.probeCount('.desk-over')`)
      + ' desk-slot: ' + await js(`window.probeCount('.desk-slot')`)
      + ' detached surfaces: ' + await js(`window.probeCount('.movable-surface.detached')`)
      + ' popout-error: ' + await js(`window.probeText('.popout-error')`))
  }
  await wait(`window.probeCount('.popout-placeholder.desk-elsewhere')===1`,
    'CONTROL: a real press works a button that stops its own pointerdown')
  note('CONTROL PASSED: real input can work an in-card button; the desk popped out')
  await settle(400)
  assert.ok(popup, 'the pop-out really opened a native window')

  const NOTICE = '.popout-placeholder.desk-elsewhere'
  const buttons = await js(`window.probeButtons('${NOTICE} > button')`) as string[]
  note('notice buttons: ' + JSON.stringify(buttons))
  assert.deepEqual(buttons, ['Show desk', 'Return here'], 'the notice offers both actions')

  // ── §1 SHOW DESK must reveal the window it points at ────────────────────
  if (only !== 'return') {
    popup!.minimize()
    await settle(300)
    assert.ok(popup!.isMinimized(), 'the popped-out desk is out of sight to begin with')
    const r = await press(`${NOTICE} > button:nth-of-type(1)`, '"Show desk"')
    assert.match(String(r.hit), /button/, 'the press lands on "Show desk", not on something over it')
    assert.ok(r.landed.some(t => t.startsWith('button')),
      '§1a the click on "Show desk" must reach the button, not be retargeted away from it')
    await settle(500)
    assert.ok(!popup!.isMinimized(),
      '§1 "Show desk" must bring the popped-out desk back into view (its window is still minimized)')
    note('§1 PASSED: "Show desk" restored the native window')
    await settle(200)
  }

  // ── §2 RETURN HERE must bring the desk back to the card ─────────────────
  if (only !== 'show') {
    const r = await press(`${NOTICE} > button:nth-of-type(2)`, '"Return here"')
    assert.match(String(r.hit), /button/, 'the press lands on "Return here"')
    assert.ok(r.landed.some(t => t.startsWith('button')),
      '§2a the click on "Return here" must reach the button, not be retargeted away from it')
    for (let i = 0; i < 60; i++) {
      if (await js(`window.probeCount('.desk-over')===1 && window.probeCount('${NOTICE}')===0`)) break
      await settle(50)
    }
    assert.equal(await js(`window.probeCount('${NOTICE}')`), 0,
      '§2 "Return here" must remove the notice (the desk is still elsewhere)')
    assert.equal(await js(`window.probeCount('.desk-over')`), 1,
      '§2 and the real desk must be back on the card')
    note('§2 PASSED: "Return here" redocked the desk')

    // ── §3 the returned desk is the SAME desk, not a fresh one ────────────
    assert.equal(await js(`window.probeDraft()`), 'PRESERVE-ME',
      '§3 the returned desk must still hold what was typed in it')
    note('§3 PASSED: desk state survived the round trip')
  }

  console.log('\nPLACEHOLDER_ACTIONS_PASS Show desk reveals the popped-out window;'
    + ' Return here redocks it to the card; the draft survives;'
    + ' and the harness proved it can work a button that is wired correctly')
  app.exit(0)
}).catch((e) => {
  console.error('\nPLACEHOLDER_ACTIONS_FAIL')
  console.error(e)
  app.exit(1)
})
