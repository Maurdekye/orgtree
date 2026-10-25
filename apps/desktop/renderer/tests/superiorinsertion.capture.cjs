/* Real-renderer insertion evidence. Session 0 only; deny native/browser clipboard
 * before any window. Own-window DOM/CDP input only; no live engine or OS input.
 */
const { app, BrowserWindow, session, clipboard } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const out = path.resolve(process.argv[2]), errors = []
assert.match(out, /^C:\\orgtree-build\\canvas-sol\\superior-overlap\\capture$/i)
const sessionId = pid => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
const isolation = { childPid: process.pid, childSessionId: sessionId(process.pid), input: 'own-window DOM/CDP; no OS input',
  nativeClipboard: 'empty reads; writes refused', browserClipboard: 'empty reads; writes refused', permissions: 'deny all', realClipboardAccess: false }
assert.equal(isolation.childSessionId, 0, 'capture requires Session 0')
app.setPath('userData', path.join(out, 'profile')); app.setPath('sessionData', path.join(out, 'session'))
for (const key of Object.keys(clipboard)) if (typeof clipboard[key] === 'function') clipboard[key] = () => {
  if (key.startsWith('write')) throw Error('Native clipboard denied')
  return key === 'availableFormats' ? [] : key === 'has' ? false : ''
}
assert.equal(clipboard.readText(), ''); assert.throws(() => clipboard.writeText('denial-control'), /denied/)
app.disableHardwareAcceleration()
let win
app.whenReady().then(async () => {
  const ses = session.fromPartition('superior-insertion-isolated')
  ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_wc, _permission, done) => done(false))
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file:|data:|blob:|about:)/.test(d.url) }))
  win = new BrowserWindow({ width: 1500, height: 1000, show: false, useContentSize: true,
    webPreferences: { session: ses, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message) })
  const js = code => win.webContents.executeJavaScript(code, true)
  const paint = () => js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,120))))')
  await win.loadFile(path.join(out, 'index.html'))
  isolation.rendererPid = win.webContents.getOSProcessId(); isolation.rendererSessionId = sessionId(isolation.rendererPid)
  assert.equal(isolation.rendererSessionId, 0)
  await js(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=>'',read:async()=>[],writeText:async()=>{throw Error('Browser clipboard denied')},write:async()=>{throw Error('Browser clipboard denied')}}})`)
  await js('new Promise(resolve=>setTimeout(resolve,2000))'); await paint()
  assert.equal(await js('window.superiorChoice'), 'centre', 'unset default is still Centre')
  await js(`(()=>{const card=document.querySelector('[data-first-use-agent="copywriter"]');if(!card)throw Error('No anchor');const strip=card.querySelector('.hsof.side-t');const expand=strip.querySelector('.hire-expand');if(expand?.getAttribute('aria-expanded')==='false')expand.click()})()`)
  await paint()
  await js(`document.querySelector('[data-first-use-agent="copywriter"] .hsof.side-t button.t-sol').click()`)
  await js('new Promise(resolve=>setTimeout(resolve,1600))')
  await js(`(()=>{const input=document.querySelector('.sq.draft .df-name');if(!input)throw Error('No draft');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'content-lead');input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.zoomhud button:nth-child(2)').click()})()`)
  await js('new Promise(resolve=>setTimeout(resolve,2000))'); await paint()
  fs.writeFileSync(path.join(out, 'draft.png'), (await win.webContents.capturePage()).toPNG())
  const samples = await js(`new Promise((resolve,reject)=>{
    const frames=[], names=['lead','designer','tester','web-dev','copywriter','copy-assistant','content-lead'];
    const sample=()=>{const boxes=Object.fromEntries(names.flatMap(id=>{const el=document.querySelector('[data-first-use-agent="'+id+'"]');if(!el)return[];const r=el.getBoundingClientRect();return [[id,{x:r.x,y:r.y,w:r.width,h:r.height}]]}));frames.push({at:performance.now(),boxes});if(frames.length<121)requestAnimationFrame(sample);else resolve(frames)};
    document.querySelector('.sq.draft .df-foot .primary').click();requestAnimationFrame(sample)
  })`)
  fs.writeFileSync(path.join(out, 'samples.json'), JSON.stringify(samples, null, 2))
  const failures = []
  for (const [frame, sample] of samples.entries()) {
    const entries = Object.entries(sample.boxes)
    if (entries.length !== 7) failures.push({ frame, missing: 7 - entries.length })
    for (const [id, r] of entries) assert.ok(r.w > 0 && r.h > 0, 'real nonzero layout: ' + id)
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const [a, p] = entries[i], [b, q] = entries[j]
      if (Math.min(p.x+p.w,q.x+q.w)-Math.max(p.x,q.x) > 0.5 && Math.min(p.y+p.h,q.y+q.h)-Math.max(p.y,q.y) > 0.5) failures.push({ frame, a, b })
    }
  }
  await paint(); const image = await win.webContents.capturePage(); assert.equal(image.isEmpty(), false)
  fs.writeFileSync(path.join(out, 'final.png'), image.toPNG())
  const requests = await js('window.superiorRequests')
  const receipt = { isolation, samples: samples.length, failures, requests, errors,
    engineSnapshots: 'before-tree.json and after-tree.json from the green real-engine regression', defaultChoice: 'centre' }
  fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
  assert.equal(requests.length, 1); assert.deepEqual(failures, [], 'siblings and moved subtree never overlap after Hire')
  assert.equal(errors.filter(e => !/Content-Security-Policy|source map/i.test(e)).length, 0)
  console.log(JSON.stringify(receipt)); win.destroy(); app.exit(0)
}).catch(error => { fs.writeFileSync(path.join(out, 'failed-receipt.json'), JSON.stringify({ isolation, errors, error: error.stack }, null, 2)); console.error(error); if (win && !win.isDestroyed()) win.destroy(); app.exit(1) })
