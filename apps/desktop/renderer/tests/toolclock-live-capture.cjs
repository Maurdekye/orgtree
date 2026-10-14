const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.CLOCK_VISUAL_ROOT, evidence = process.env.CLOCK_VISUAL_EVIDENCE
if (!/^C:\\orgtree-build\\/i.test(root || '') || !/^D:\\orgtree-work\\/i.test(evidence || '')) throw new Error('Expected C build / D evidence roots')
fs.mkdirSync(evidence, { recursive: true })
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
const receipts = []
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 400, show: false, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.startPainting()
  try {
    for (const version of ['before', 'after']) for (const theme of ['dark', 'light']) {
      await win.loadFile(path.join(root, version + '.html'))
      const state = await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
        const limit=performance.now()+5000;
        const id=setInterval(()=>{if(document.querySelectorAll('[data-clock]').length===3){clearInterval(id);
          document.documentElement.classList.toggle('contrast-light',${theme === 'light'});
          resolve({writing:document.querySelector('[data-clock="writing"]').textContent,
            execution:document.querySelector('[data-clock="execution"]').textContent,
            final:document.querySelector('[data-clock="final"]').textContent,
            background:getComputedStyle(document.body).backgroundColor})
        }else if(performance.now()>limit){clearInterval(id);reject(new Error('fixture timeout'))}},20)})`)
      if (version === 'after' ? !/\b1s\b/.test(state.writing) || !/\b1s\b/.test(state.execution)
        : !/1\.2s/.test(state.writing) || !/1\.2s/.test(state.execution)) throw new Error('live before/after mismatch')
      if (!/1\.2s/.test(state.final) || !/200 ms/.test(state.final)) throw new Error('completed precision changed')
      const paint = () => new Promise((resolve,reject) => {
        const timeout=setTimeout(()=>reject(new Error('paint timeout')),3000)
        win.webContents.once('paint',(_event,_dirty,image)=>{clearTimeout(timeout);resolve(image)})
        win.webContents.invalidate()
      })
      const expected = state.background.match(/\d+/g).slice(0,3).map(Number)
      let frame, captured, matched = false
      for (let attempt=0;attempt<3;attempt++) {
        frame = await paint()
        const bitmap = frame.toBitmap()
        captured = [bitmap[2],bitmap[1],bitmap[0]]
        if (captured.every((value,i)=>Math.abs(value-expected[i])<=6)) { matched=true;break }
      }
      if (!matched) throw new Error('painted background does not match current theme')
      fs.writeFileSync(path.join(evidence, `${version}-${theme}.png`), frame.toPNG())
      receipts.push({ version, theme, ...state, captured })
      fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, receipts }, null, 2))
    }
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, receipts }, null, 2))
  } finally { win.destroy() }
}).then(()=>app.exit(0),error=>{fs.writeFileSync(path.join(evidence,'error.txt'),String(error.stack||error));app.exit(1)})
