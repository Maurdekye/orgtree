import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
const root = process.env.ORGTREE_PLACEHOLDER_ROOT!
app.disableHardwareAcceleration(); app.setPath('userData', path.join(root, 'profile'))
app.on('window-all-closed', () => { /* the probe decides when to exit */ })
app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    const file = req.url === '/fixture.js' ? 'fixture.js' : req.url === '/fixture.css' ? 'fixture.css' : null
    if (file) { res.setHeader('Content-Type', file.endsWith('js') ? 'text/javascript' : 'text/css'); res.end(fs.readFileSync(path.join(root, file))); return }
    res.end('<!doctype html><link rel="stylesheet" href="/fixture.css"><body style="margin:0"><div id="root"></div><script src="/fixture.js"></script>')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const w = new BrowserWindow({ show: false, width: 1000, height: 760, frame: false, webPreferences: { sandbox: true } })
  // the real popout path calls window.open, so the DETACHED state under test is
  // the application's own rather than a flag this probe sets by hand
  w.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, width: 600, height: 400 } }))
  const js = (code: string) => w.webContents.executeJavaScript(code)
  const settle = (ms: number) => new Promise(r => setTimeout(r, ms))
  await w.loadURL(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`)
  const wait = async (code: string) => { for (let i = 0; i < 200; i++) { if (await js(code)) return; await settle(30) } throw Error(code) }

  await wait(`!!document.querySelector('#pinned .pin-placeholder')`)
  assert.ok(await js(`window.popOut()`), 'the fixture offers a real pop-out control')
  await wait(`window.count('.popout-placeholder')===2`)
  await settle(300)

  const CARD = '#card .popout-placeholder', BARE = '#bare .popout-placeholder', PIN = '#pinned .pin-placeholder'
  assert.ok(await js(`window.count('${CARD} > button')`) >= 2,
    'the detached notice really offers both Show desk and Return here')

  // THE CHECK. A card's desk is authored at 900px and counter-scaled into the
  // 120px interior; a notice standing in its place must be scaled the same way
  // or it renders at the CAMERA's scale instead - 7.5x oversized, with its
  // buttons hanging outside the card (user report 2026-09-11). The pinned
  // placeholder in the same frame is the reference, so this compares two real
  // components rather than a hand-computed number.
  const onCard = await js(`window.scaleOf('${CARD}')`) as number
  const onPin = await js(`window.scaleOf('${PIN}')`) as number
  assert.ok(onCard && onPin, 'both placeholders measured')
  assert.ok(Math.abs(onCard - onPin) / onPin < 0.02,
    `the popped-out notice must be scaled like the pinned one (${onCard} vs ${onPin})`)
  assert.ok(await js(`window.insideCard('${CARD} > button:last-of-type','#card')`),
    'and its last control must sit inside the card, not beside it')

  // The OTHER half of the rule, and the reason the scale is not simply applied
  // to every notice: a switchboard panel and a pinned window's body host the
  // desk at 1:1, so their notice must NOT be counter-scaled. Without this, a
  // fix that scaled every .popout-placeholder would pass the check above and
  // shrink those two to nothing.
  const onBare = await js(`window.scaleOf('${BARE}')`) as number
  assert.ok(onBare / onPin > 5,
    `a bare slot's notice must stay at its host's scale (${onBare} vs ${onPin})`)
  assert.equal(await js(`window.count('${BARE}.desk-elsewhere')`), 0,
    'and must not carry the counter-scaled class at all')

  // POSITIVE CONTROL for the detector itself: remove the counter-scale and the
  // first check must fail. A comparison that cannot fail is not a check.
  await js(`(()=>{const e=document.querySelector('${CARD}');e.style.transform='none';return 1})()`)
  await settle(120)
  const broken = await js(`window.scaleOf('${CARD}')`) as number
  assert.ok(Math.abs(broken - onPin) / onPin > 0.02,
    'the detector must be able to see a missing counter-scale')

  console.log('\nPLACEHOLDER_SCALE_PASS a popped-out desk notice is scaled like the desk it replaces'
    + '; bare hosts keep 1:1; positive control detected')
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
