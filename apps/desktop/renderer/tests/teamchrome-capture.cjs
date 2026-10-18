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
      let n=0;const check=()=>{const b=document.querySelector('.tray-toggle');
        if(b){b.click();resolve()}else if(++n<100)setTimeout(check,20);else reject(Error('Missing Agents toggle'))};check()})`)
    let state, image, actual
    for (let attempt = 0; attempt < 5; attempt++) {
      win.webContents.invalidate()
      state = await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>{
        const measure=s=>{const p=document.querySelector(s),t=p.querySelector(':scope > .tray'),f=p.querySelector('.tray-filter'),r=p.querySelector('.tray-row');
          const css=e=>{const c=getComputedStyle(e);return {font:c.fontSize,family:c.fontFamily,padding:c.padding,border:c.borderWidth,overflow:c.overflowY}};
          const rect=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}};
          return {panel:css(p),tray:css(t),filter:css(f),row:css(r),filterRect:rect(f),rect:rect(p),
            activeInHeader:!!p.querySelector('.modalpin-actions [aria-label="Only active agents"]'),
            bottomClose:[...p.querySelectorAll('button')].some(b=>b.textContent==='Close'),
            names:[...p.querySelectorAll('.tray-row')].map(e=>e.dataset.copyAgentName)}};
        const agents=measure('.tray-panel:not(.team-panel)');
        resolve({agents,team:measure('.team-panel'),sample:{x:agents.rect.x+20,y:agents.rect.y+agents.rect.h-20},
          background:getComputedStyle(document.querySelector('.tray-panel:not(.team-panel)')).backgroundColor})},250))))`)
      image = await win.webContents.capturePage()
      if (image.isEmpty()) throw Error('Empty capture')
      const p = image.toBitmap(), size=image.getSize(), offset=(Math.floor(state.sample.y)*size.width+Math.floor(state.sample.x))*4
      actual = `rgb(${p[offset+2]}, ${p[offset+1]}, ${p[offset]})`
      if (actual === state.background) break
    }
    fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify({ ...state, actual }, null, 2))
    if (actual !== state.background) throw Error('Stale/wrong capture palette')
    for (const key of ['panel','tray','filter','row']) {
      if (JSON.stringify(state.agents[key]) !== JSON.stringify(state.team[key])) throw Error('Chrome differs: '+key)
    }
    for (const p of [state.agents, state.team]) {
      if (!p.activeInHeader || p.bottomClose || p.tray.padding !== '0px' || p.tray.border !== '0px'
        || p.rect.x < 0 || p.rect.y < 0 || p.rect.x+p.rect.w>1000 || p.rect.y+p.rect.h>700) throw Error('Panel bounds/chrome invalid')
    }
    if (state.team.names.join(',') !== 'build-team,layout-author,notes-author' || state.agents.names.length !== 4) throw Error('Wrong scoped rows')
    fs.writeFileSync(path.join(root, 'team-panels-dark.png'), image.toPNG())
    // Check the centered state in the same renderer, without another capture.
    await win.webContents.executeJavaScript(`document.querySelector('.team-panel .modalpin-btn[aria-pressed]').click()`)
    const modal = await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const p=document.querySelector('.team-panel'),t=p.querySelector(':scope > .tray'),c=getComputedStyle(t);
      resolve({pinned:p.classList.contains('modalpin-win'),padding:c.padding,border:c.borderWidth,
        bottomClose:[...p.querySelectorAll('button')].some(b=>b.textContent==='Close'),rows:p.querySelectorAll('.tray-row').length})})))`)
    fs.writeFileSync(path.join(root, 'modal.json'), JSON.stringify(modal,null,2))
    if (modal.pinned || modal.padding !== '0px' || modal.border !== '0px' || modal.bottomClose || modal.rows !== 3) throw Error('Modal chrome invalid')
  } finally { win.destroy() }
}).then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1) })
