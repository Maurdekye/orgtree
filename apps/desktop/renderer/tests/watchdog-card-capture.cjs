const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.WATCHDOG_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(root || '')) throw Error('Expected assigned C build scope')
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  try {
    await win.loadFile(path.join(root, 'fixture.html'))
    const receipts = []
    const cases = process.env.WATCHDOG_CAPTURE_SINGLE === 'true' ? [['queue', 'dark']] : ['queue', 'command', 'silence', 'event'].flatMap(name => ['dark', 'light'].map(theme => [name, theme]))
    for (const [name, theme] of cases) {
      let state, image, actualBackground
      await win.webContents.executeJavaScript(`window.setWatchdogCase(${JSON.stringify(name)})`)
      for (let attempt = 0; attempt < 5; attempt++) {
        win.webContents.invalidate()
        state = await win.webContents.executeJavaScript(`new Promise(resolve=>{
          document.documentElement.classList.toggle('contrast-light',${theme === 'light'});
          requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>{
            const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
            const ctx=canvas.getContext('2d');
            ctx.fillStyle=getComputedStyle(document.body).backgroundColor;ctx.fillRect(0,0,1,1);
            const overlay=document.querySelector('.overlay');
            if(overlay){ctx.fillStyle=getComputedStyle(overlay).backgroundColor;ctx.fillRect(0,0,1,1)}
            const pixel=ctx.getImageData(0,0,1,1).data;
            resolve({
            text:document.body.innerText,type:document.querySelector('.wd-type')?.textContent,
            description:document.querySelector('.wd-description')?.textContent,
            panels:document.querySelectorAll('.wd-cmd').length,
            controls:Array.from(document.querySelectorAll('.settings button')).filter(b=>/^(pause|remove|close)$/i.test(b.textContent.trim())).map(b=>({label:b.textContent.trim(),top:b.getBoundingClientRect().top,bottom:b.getBoundingClientRect().bottom})),
            panelTop:document.querySelector('.settings').getBoundingClientRect().top,
            panelBottom:document.querySelector('.settings').getBoundingClientRect().bottom,
            background:getComputedStyle(document.body).backgroundColor,
            expectedBackground:'rgb('+pixel[0]+', '+pixel[1]+', '+pixel[2]+')'})},250)))})`)
        image = await win.webContents.capturePage()
        if (image.isEmpty()) throw Error('Empty screenshot')
        const bitmap = image.toBitmap()
        actualBackground = `rgb(${bitmap[2]}, ${bitmap[1]}, ${bitmap[0]})`
        if (actualBackground === state.expectedBackground) break
      }
      if (actualBackground !== state.expectedBackground) {
        fs.writeFileSync(path.join(root,'capture-failure.json'),JSON.stringify({name,theme,state,actualBackground},null,2))
        throw Error('Stale capture '+name+'/'+theme)
      }
      if (state.panels < 1 || !state.text.includes('test-proj-worker-b')) throw Error('Panel not rendered')
      if (process.env.WATCHDOG_CAPTURE_RICH === 'true' && (!state.type || !state.description)) throw Error('Missing explanation')
      if (process.env.WATCHDOG_CAPTURE_RICH === 'true' && name === 'queue' && (state.controls.length < 3 || state.controls.some(b=>b.top<Math.max(0,state.panelTop)||b.bottom>Math.min(700,state.panelBottom-2))))
        throw Error('Queue controls need scrolling in the default fixture: '+JSON.stringify(state.controls))
      fs.writeFileSync(path.join(root, name+'-'+theme+'.png'), image.toPNG())
      receipts.push({ name, theme, ...state, actualBackground })
    }
    fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify(receipts, null, 2))
  } finally { win.destroy() }
}).then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1) })
