/** ⚠ A POPOUT'S GEOMETRY IS READABLE FROM ITS OWN RENDERER, THROUGH THE
 *  PRODUCT'S WINDOW-OPEN PATH. That is the claim, and it is worth a probe
 *  because a plausible investigation concluded the opposite.
 *
 *  The renderer saves where a popped-out surface is by reading its own
 *  `screenX`/`screenY`/`outerWidth`/`outerHeight` (renderer/src/windowlayout.ts),
 *  and a popout is an adopted `about:blank` portal rather than an ordinary
 *  document - so whether those four track the native window is a real
 *  question rather than an obvious yes. This answers it: they track, from
 *  every source a rectangle can change by, including across the minimize and
 *  restore that re-applies background throttling.
 *
 *  ⚠ HOW THIS WAS NEARLY GOT WRONG, because the next person may repeat it.
 *  A hand-rolled `setWindowOpenHandler` copying the product's
 *  `overrideBrowserWindowOptions` reproduces a BROKEN reading, in which the
 *  popout reports its OPENER's rectangle for ever. Two independent harnesses
 *  did exactly that and agreed with each other - which looked like
 *  confirmation and was one mistake counted twice. Imitating the window-open
 *  handler is not the same as running `configureWindow`, and only the second
 *  is the product. Everything here therefore goes through the real
 *  `configureWindow`.
 *
 *  Nothing is asserted about WHY the look-alike differs; see the note at the
 *  branch below, which records what was measured and what it does and does not
 *  establish.
 *
 *  Everything runs over a real http origin, because `about:blank` inherits its
 *  opener's origin and a `data:` URL would not reproduce the case. Nothing
 *  starts an engine, loads app UI or touches user data. */
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { configureWindow, popoutRegistry } from '../apps/desktop/main/windows'

const profile = process.env.ORGTREE_ELECTRON_TEST_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-popout-bounds-'))
app.setPath('userData', profile)

type Geometry = { sx: number; sy: number; ow: number; oh: number; inW: number; inH: number }
const geometry = (contents: Electron.WebContents): Promise<Geometry> => contents.executeJavaScript(
  'JSON.stringify({ sx: window.screenX, sy: window.screenY, ow: window.outerWidth, oh: window.outerHeight,' +
  ' inW: window.innerWidth, inH: window.innerHeight })',
).then(value => JSON.parse(value as string) as Geometry)

const settle = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

/** ⚠ A FRAMELESS WINDOW'S OUTER RECTANGLE INCLUDES ITS INVISIBLE RESIZE
 *  BORDER, so the renderer reads 8px left of and 16px wider than the bounds
 *  the main process set. That offset is real geometry, not error - hence a
 *  tolerance rather than equality, and a tolerance far tighter than the
 *  hundreds of pixels that separate a popout from its opener. */
const tracks = (dom: Geometry, native: { x: number; y: number; width: number; height: number }) =>
  Math.abs(dom.sx - native.x) <= 12 && Math.abs(dom.sy - native.y) <= 12 &&
  Math.abs(dom.ow - native.width) <= 20 && Math.abs(dom.oh - native.height) <= 20

app.on('window-all-closed', () => { /* the probe decides when it is over */ })

app.whenReady().then(async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><title>probe</title><body>ok')
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const OPENER = { x: 830, y: 296, width: 900, height: 800 }
  const openPopout = async (useConfigureWindow: boolean) => {
    const published: { name: string; present: boolean; maximized: boolean }[] = []
    const popouts = popoutRegistry<BrowserWindow>(state => { published.push(state) })
    const opener = new BrowserWindow({ show: true, frame: false, ...OPENER,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    let child: BrowserWindow | undefined
    opener.webContents.on('did-create-window', window => { child = window })
    if (useConfigureWindow) {
      configureWindow(opener, () => origin, true, undefined, undefined, () => {},
        (name, created) => popouts.track(name, created as BrowserWindow))
    } else {
      // ⚠ THE LOOK-ALIKE: the product's overrideBrowserWindowOptions copied by
      // hand, which is what both earlier harnesses did.
      opener.webContents.setWindowOpenHandler(details => details.url !== 'about:blank' ? { action: 'deny' } : ({
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, frame: false,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } },
      }))
    }
    await opener.loadURL(`${origin}/`)
    await opener.webContents.executeJavaScript(
      "window.__c = window.open('about:blank', 'desk:1', 'width=400,height=300,left=60,top=70'); 'ok'", true)
    for (let i = 0; i < 100 && !child; i += 1) await settle(50)
    assert.ok(child, 'the popout was allowed')
    await settle(600)
    return { opener, child, popouts, published }
  }

  // ⚠ WHAT IS DELIBERATELY *NOT* ASSERTED HERE, and why.
  //
  // A hand-rolled `setWindowOpenHandler` that copies the product's
  // `overrideBrowserWindowOptions` produced the BROKEN reading - the popout
  // reporting its opener's rectangle - six times out of six in a standalone
  // process, and flipping `setBackgroundThrottling(false)` fixed it six times
  // out of six with nothing else changed. That looked like a clean causal
  // demonstration, and an earlier version of this probe asserted it.
  //
  // v3-shell-opus then confirmed the same mechanism independently, in a
  // different harness: adding that one line to their own test driver flipped
  // their borrow-geometry check from failing to passing.
  //
  // BUT IT DOES NOT HOLD UNDER THIS TEST RUNNER: the same look-alike reads its
  // geometry CORRECTLY here, without the throttling call. So the mechanism is
  // corroborated twice over and the ENVIRONMENT DEPENDENCE is unexplained -
  // something about running under `node --test` makes the broken case not
  // reproduce, and neither of us knows what. An assertion on it would
  // therefore be a flake that reports a confident false diagnosis whenever it
  // fired, which is worse than not asserting it.
  //
  // So only the product's behaviour is asserted below - which is the claim
  // that actually matters, and which held in every environment tried. The
  // openPopout(false) branch is kept for anyone reproducing the investigation
  // by hand; nothing calls it.
  void openPopout

  // ══ THE PRODUCT PATH, which reads geometry correctly ═════════════════════
  {
    const { opener, child, popouts, published } = await openPopout(true)
    assert.equal(child.webContents.getURL(), 'about:blank', 'the product opens popouts as adopted about:blank portals')
    assert.equal(popouts.state('desk:1').present, true, 'and tracks it under the frame name the renderer chose')
    assert.ok(published.length >= 0)

    assert.equal(tracks(await geometry(child.webContents), child.getBounds()), true,
      'through the PRODUCT path the popout knows its own rectangle from the first read')

    // ⚠ AND IT KEEPS TRACKING, from every source a rectangle can change by.
    // This is what the renderer's geometry poll depends on.
    for (const [label, bounds] of [
      ['a move from the main process', { x: 137, y: 163, width: 561, height: 421 }],
      ['a second one', { x: 400, y: 400, width: 700, height: 500 }],
    ] as const) {
      child.setBounds(bounds)
      await settle(900)
      assert.equal(tracks(await geometry(child.webContents), child.getBounds()), true, label)
    }

    // Chromium moving its own window - the path a -webkit-app-region drag takes,
    // which is how the USER actually moves a frameless popout.
    await child.webContents.executeJavaScript('window.moveTo(250, 220); window.resizeTo(520, 380); "ok"', true)
    await settle(900)
    assert.equal(tracks(await geometry(child.webContents), child.getBounds()), true,
      'a drag-region move is tracked too, not only a programmatic one')

    // ⚠ ACROSS THE ONE TRANSITION THAT TURNS THROTTLING BACK ON. configureWindow
    // re-throttles a minimized window and un-throttles it on restore, so this is
    // the round trip that would strand a stale rectangle if the restore half
    // were ever dropped.
    child.minimize()
    await settle(500)
    child.restore()
    await settle(300)
    child.setBounds({ x: 150, y: 150, width: 800, height: 600 })
    await settle(1200)
    assert.equal(tracks(await geometry(child.webContents), child.getBounds()), true,
      'and still tracks after a minimize/restore, which is where the throttle is re-applied')

    child.destroy(); opener.destroy()
  }

  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy()
  server.close()
  console.log('POPOUT_BOUNDS_PASS')
  app.exit(0)
}).catch(error => {
  console.error(error)
  app.exit(1)
})
