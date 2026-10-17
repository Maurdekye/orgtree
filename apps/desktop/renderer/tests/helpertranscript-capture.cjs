const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.HELPER_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(root || '')) throw new Error('Expected assigned build scope')
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 650, show: false, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  try {
    await win.loadFile(path.join(root, 'fixture.html'))
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const deadline=performance.now()+8000;const timer=setInterval(()=>{
      if(document.body.dataset.ready==='true'){clearInterval(timer);resolve(true)}else if(performance.now()>deadline){clearInterval(timer);reject(new Error('fixture timeout'))}},20)})`)
    const receipts = []
    for (const theme of ['dark', 'light']) {
      let state, image, actualBackground
      for (let attempt = 0; attempt < 5; attempt++) {
        // Offscreen capture can return its cached frame even after DOM/theme
        // checks pass. Request paint and verify actual pixels before saving.
        win.webContents.invalidate()
        state = await win.webContents.executeJavaScript(`new Promise(resolve=>{
        document.documentElement.classList.toggle('contrast-light',${theme === 'light'});
        requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>resolve({text:document.body.innerText,
          helpers:document.querySelectorAll('.helper-transcript').length,
          markdown:document.querySelectorAll('.helper-transcript .msgtext.md strong').length,
          thoughts:document.querySelectorAll('.helper-transcript .thoughtbody.md').length,
          chips:document.querySelectorAll('.helper-transcript .tline').length,
          inputs:document.querySelectorAll('.helper-transcript .toolinput').length,
          font: getComputedStyle(document.querySelector('.helper-transcript .msgtext')).fontFamily,
          background: getComputedStyle(document.body).backgroundColor}),250)))})`)
        image = await win.webContents.capturePage()
        if (image.isEmpty()) throw new Error('Empty screenshot')
        const bitmap = image.toBitmap()
        actualBackground = `rgb(${bitmap[2]}, ${bitmap[1]}, ${bitmap[0]})`
        if (actualBackground === state.background) break
      }
      if (actualBackground !== state.background) throw new Error('Capture pixels never reached ' + theme + ': ' + JSON.stringify({actualBackground, expected:state.background}))
      if (theme === 'light' && state.background === receipts[0].background) throw new Error('Light theme did not change the computed background')
      if (state.helpers !== 1 || state.markdown < 1 || state.thoughts !== 1 || state.chips !== 2 || state.inputs !== 1)
        throw new Error('Helper visual fixture did not reach the expected normal transcript state: ' + JSON.stringify(state))
      fs.writeFileSync(path.join(root, theme + '.png'), image.toPNG())
      receipts.push({ theme, ...state, actualBackground })
    }
    fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify(receipts, null, 2))
  } finally { win.destroy() }
}).then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1) })
