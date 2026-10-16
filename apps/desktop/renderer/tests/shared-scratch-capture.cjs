const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const [out, evidence] = process.argv.slice(2)
if (!/^C:\\orgtree-build\\/i.test(out || '') || !/^D:\\orgtree-work\\/i.test(evidence || '')) throw Error('expected assigned C outputs and D evidence')
fs.mkdirSync(evidence, { recursive: true })
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const dir = path.join(out, key); fs.mkdirSync(dir, { recursive: true }); app.setPath(key, dir)
}
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const receipts = []
  let win
  const resultFile = path.join(evidence, 'result.json')
  const save = passed => fs.writeFileSync(resultFile, JSON.stringify({ passed, receipts }, null, 2))
  const wait = expression => win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const end=Date.now()+5000;
    const tick=()=>{if(${expression})return resolve(true);if(Date.now()>end)return reject(Error('fixture readiness timeout'));setTimeout(tick,20)};tick()
  })`)
  try {
    for (const entry of ['agent', 'switchboard', 'settings']) {
      // A fresh offscreen page per entry cannot reuse another entry's frame.
      win = new BrowserWindow({ width: 960, height: 700, show: false, useContentSize: true,
        paintWhenInitiallyHidden: true, webPreferences: { offscreen: true, backgroundThrottling: false,
          contextIsolation: true, sandbox: true, nodeIntegration: false } })
      win.webContents.startPainting()
      win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file:|data:)/.test(details.url) }))
      await win.loadFile(path.join(out, 'index.html'), { query: { entry } })
      if (entry !== 'settings') {
        const selector = entry === 'agent' ? '#agent' : '.sq.user'
        await wait(`document.querySelector(${JSON.stringify(selector)})`)
        await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:130}))`)
        await wait('document.querySelector(".ctxmenu")')
        if (entry === 'agent') {
          await win.webContents.executeJavaScript(`(()=>{const open=[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.textContent.trim().replace(/\\s*▸$/,'')==='Open');if(!open)throw Error('agent Open branch missing');open.focus();open.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))})()`)
        }
      }
      const label = entry === 'agent' ? 'Open team scratch folder' : 'Open shared scratch folder'
      await wait(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)})`)
      // Wait for theme/button transitions and two frames before every capture.
      await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      await new Promise(resolve => setTimeout(resolve, 150))
      const state = await win.webContents.executeJavaScript(`(()=>{const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}),r=el.getBoundingClientRect(),css=getComputedStyle(el);return {entry:${JSON.stringify(entry)},label:el.textContent.trim(),rect:{x:r.x,y:r.y,w:r.width,h:r.height},viewport:{w:innerWidth,h:innerHeight},color:css.color.match(/[\\d.]+/g).slice(0,3).map(Number)}})()`)
      const frame = await win.webContents.capturePage(), size = frame.getSize(), bitmap = frame.toBitmap()
      const r = state.rect
      const fullyVisible = r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= state.viewport.w && r.y + r.h <= state.viewport.h
      let ink = 0
      const sx = size.width / state.viewport.w, sy = size.height / state.viewport.h
      for (let y = Math.max(0, Math.ceil(r.y * sy)); y < Math.min(size.height, Math.floor((r.y + r.h) * sy)); y++) {
        for (let x = Math.max(0, Math.ceil(r.x * sx)); x < Math.min(size.width, Math.floor((r.x + r.w) * sx)); x++) {
          const offset = (y * size.width + x) * 4
          if ([bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]].every((value, i) => Math.abs(value - state.color[i]) <= 20)) ink++
        }
      }
      fs.writeFileSync(path.join(evidence, `${entry}.png`), frame.toPNG())
      receipts.push({ ...state, size, fullyVisible, ink, painted: ink >= 20 }); save(false)
      if (!fullyVisible || ink < 20) throw Error('entry clipped or label did not paint')
      win.destroy(); win = null
    }
    save(true); console.log(JSON.stringify({ passed: true, entries: receipts.length })); app.exit(0)
  } catch (error) {
    receipts.push({ error: error.stack }); save(false); console.error(error); if (win && !win.isDestroyed()) win.destroy(); app.exit(1)
  }
})
