const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.MATH_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(root || '')) throw Error('Expected own output')
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const requests = []
  session.defaultSession.webRequest.onBeforeRequest((details, next) => {
    if (/^https?:/.test(details.url)) { requests.push(details.url); next({ cancel: true }) }
    else next({})
  })
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  try {
    await win.loadFile(path.join(root, 'fixture.html'))
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=performance.now()+8000;const timer=setInterval(()=>{
      if(document.body.dataset.ready==='true'){clearInterval(timer);resolve(true)}else if(performance.now()>until){clearInterval(timer);reject(Error('fixture timeout'))}},20)})`)
    const receipts = []
    for (const theme of ['dark', 'light']) {
      let state, image, actualBackground
      for (let attempt = 0; attempt < 5; attempt++) {
        win.webContents.invalidate()
        state = await win.webContents.executeJavaScript(`new Promise(resolve=>{
          document.documentElement.classList.toggle('contrast-light',${theme === 'light'});
          document.fonts.ready.then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>resolve({
            formulas:document.querySelectorAll('.katex').length,display:document.querySelectorAll('.katex-display').length,
            mathml:document.querySelectorAll('math').length,text:document.body.innerText,
            font:document.fonts.check('16px KaTeX_Main'),background:getComputedStyle(document.body).backgroundColor,
            width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight
          }),250))))})`)
        image = await win.webContents.capturePage()
        if (image.isEmpty()) throw Error('Empty image')
        const bitmap = image.toBitmap()
        actualBackground = `rgb(${bitmap[2]}, ${bitmap[1]}, ${bitmap[0]})`
        if (actualBackground === state.background) break
      }
      if (actualBackground !== state.background) throw Error('Stale palette: '+JSON.stringify(state))
      if (state.formulas !== 4 || state.display !== 1 || state.mathml !== 4 || !state.font || state.width > 1000 || state.height > 700)
        throw Error('Math fixture did not reach expected layout: '+JSON.stringify(state))
      if (requests.length) throw Error('Unexpected network requests: '+JSON.stringify(requests))
      fs.writeFileSync(path.join(root, theme+'.png'), image.toPNG())
      receipts.push({theme,...state,actualBackground,networkRequests:requests})
    }
    if (receipts[0].background === receipts[1].background) throw Error('Identical themes')
    fs.writeFileSync(path.join(root,'capture.json'),JSON.stringify(receipts,null,2))
  } finally { win.destroy() }
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
