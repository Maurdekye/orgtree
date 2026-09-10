import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (process.platform !== 'win32') throw Error('INERT: Windows native hit testing is required')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-pin-hit-'))
fs.copyFileSync('apps/desktop/renderer/src/styles.css', path.join(root, 'styles.css'))
fs.writeFileSync(path.join(root, 'hit.py'), `import ctypes, json, sys
from ctypes import wintypes
user = ctypes.WinDLL('user32', use_last_error=True)
user.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM, wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
user.SendMessageTimeoutW.restype = wintypes.LPARAM
answer = []
for point in json.loads(sys.argv[2]):
    result = ctypes.c_size_t()
    packed = (int(point['x']) & 65535) | ((int(point['y']) & 65535) << 16)
    if not user.SendMessageTimeoutW(int(sys.argv[1]), 0x84, 0, packed, 2, 2000, ctypes.byref(result)):
        raise ctypes.WinError(ctypes.get_last_error())
    answer.append(result.value)
print(json.dumps(answer))
`)
fs.writeFileSync(path.join(root, 'probe.cjs'), `
const {app, BrowserWindow, screen} = require('electron')
const {spawn} = require('node:child_process')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = process.env.ORGTREE_PIN_HIT_PROBE
app.setPath('userData', path.join(root, 'profile'))
app.disableHardwareAcceleration()
const pause = () => new Promise(resolve => setTimeout(resolve, 300))
app.whenReady().then(async () => {
  const w = new BrowserWindow({show:false, frame:false, width:1000, height:500, x:80, y:80, webPreferences:{backgroundThrottling:false}})
  const html = '<style>' + fs.readFileSync(path.join(root,'styles.css'),'utf8') + '</style>' +
    '<header class="orgbar native-header" style="height:90px"><div class="native-header-main"><span class="orgname-wrap">Orgtree drag area</span></div></header>' +
    '<div class="overlay overlay-pinned" style="position:fixed;inset:0;z-index:999"><section class="modalpin-win" style="position:absolute;left:40px;top:10px;width:500px;height:70px"><div class="modalpin-bar on" style="height:40px"><span id="handle">Drag pinned panel</span><button id="close">Close</button></div><div id="content" style="height:25px">Panel content</div></section></div>'
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  w.showInactive()
  await pause()
  const native = w.getNativeWindowHandle()
  const hwnd = native.length === 8 ? native.readBigUInt64LE().toString() : native.readUInt32LE().toString()
  const hit = async (relativePoints) => {
    const bounds = w.getContentBounds()
    const relative = relativePoints || await w.webContents.executeJavaScript('Array.from(document.querySelectorAll("#handle,#close,#content")).map(e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})')
    const points = relative.map(point => screen.dipToScreenPoint({x:Math.round(point.x+bounds.x),y:Math.round(point.y+bounds.y)}))
    return new Promise((resolve,reject) => {
      const child = spawn(process.env.ORGTREE_PROBE_PYTHON || 'python', [path.join(root,'hit.py'), hwnd, JSON.stringify(points)], {windowsHide:true})
      let out='', err=''; child.stdout.on('data', b=>out+=b); child.stderr.on('data', b=>err+=b)
      child.on('error',reject); child.on('exit', code=>code ? reject(Error(err)) : resolve(JSON.parse(out)))
    })
  }
  const got = await hit()
  console.log('Pinned modal native hit results:', JSON.stringify(got))
  assert.deepEqual(got, [1,1,1], 'pinned panel handle, close and content must be HTCLIENT')
  const baseline = html.replace(/\\r\\n/g, '\\n').replace('.overlay.overlay-pinned .modalpin-win,\\n.overlay.overlay-pinned .modalpin-win * { -webkit-app-region: no-drag; }', '')
  assert.notEqual(baseline, html, 'positive control must remove the actual pinned-panel exclusion')
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(baseline))
  await pause()
  const old = await hit()
  assert.ok(old.includes(2), 'positive control: the unprotected pin must expose HTCAPTION under at least one button')
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await w.webContents.executeJavaScript('document.querySelector(".overlay-pinned").style.display="none"')
  await pause()
  assert.deepEqual(await hit([{x:400,y:30}]), [2], 'closing the pin must restore native header dragging')
  console.log('PASS native pinned-panel input; removed protection exposes caption hits; uncovered header remains draggable')
  w.destroy(); app.quit()
}).catch(e=>{console.error(e);app.exit(1)})
`)
const env = {...process.env, ORGTREE_PIN_HIT_PROBE:root}
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(process.env.ORGTREE_HISTORY_ELECTRON || createRequire(import.meta.url)('electron'), [path.join(root,'probe.cjs')], {env,windowsHide:true,stdio:'inherit'})
const timer = setTimeout(()=>{child.kill();process.exitCode=1}, 25000)
child.on('error',e=>{clearTimeout(timer);console.error(e);process.exitCode=1})
child.on('exit',code=>{clearTimeout(timer);process.exitCode=code ?? 1})
