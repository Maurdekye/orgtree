const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.TEAM_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(root || '')) throw Error('Expected assigned build scope')
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  try {
    await win.loadFile(path.join(root, 'fixture.html'))
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      let attempts=0; const check=()=>{const tab=document.querySelector('[data-tab="team"]');
        if(tab){tab.click();resolve()}else if(++attempts<100)setTimeout(check,20);else reject(Error('Missing Team tab'))};check()})`)
    let state, image, actual
    for (let attempt = 0; attempt < 5; attempt++) {
      win.webContents.invalidate()
      state = await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>{
        const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
        resolve({names:Array.from(document.querySelectorAll('.tray-row')).map(e=>e.dataset.copyAgentName),
          filter:!!document.querySelector('.tray-filter'),active:!!document.querySelector('[aria-label="Only active agents"]'),
          actions:Array.from(document.querySelectorAll('.panel-corner button')).map(e=>({label:e.getAttribute('aria-label'),...rect(e)})),
          selected:document.querySelector('[data-tab="team"]').classList.contains('on'),
          filterRect:rect(document.querySelector('.tray-filter-row')),background:getComputedStyle(document.body).backgroundColor})},250))))`)
      image = await win.webContents.capturePage()
      if (image.isEmpty()) throw Error('Empty capture')
      const p = image.toBitmap(); actual = `rgb(${p[2]}, ${p[1]}, ${p[0]})`
      if (actual === state.background) break
    }
    fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify({ ...state, actual }, null, 2))
    if (actual !== state.background || !state.selected || !state.filter || !state.active || state.actions.length !== 3
      || state.names.join(',') !== 'website,lead,frontend,renderer,writer') throw Error('Team capture state is invalid')
    if (state.actions.some(b => b.x < 0 || b.y < 0 || b.x + b.w > 1000 || b.y + b.h > 700)
      || state.filterRect.x + state.filterRect.w > state.actions[0].x + 2) throw Error('Team controls overlap or leave the viewport')
    fs.writeFileSync(path.join(root, 'team-dark.png'), image.toPNG())
  } finally { win.destroy() }
}).then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1) })
