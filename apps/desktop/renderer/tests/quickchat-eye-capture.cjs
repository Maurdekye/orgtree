const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.QUICKCHAT_EYE_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/]ordering-sol[\\/]/i.test(root || '')) throw Error('Expected assigned capture scope')
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  try {
    await win.loadFile(path.join(root, 'fixture.html'))
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      let attempts=0; const check=()=>{const button=document.querySelector('#top-sample .quickchat-superior');
        if(button){button.click();resolve()}else if(++attempts<100)setTimeout(check,20);else reject(Error('Missing Quick chat'))};check()})`)
    const state = await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>{
      const selected=document.querySelector('#top-sample .quickchat-superior');
      const option=document.querySelector('.quickchat-top .tray-main');
      const mark=e=>{const icon=e.querySelector('.quickchat-user-mark'), label=e.querySelector('.quickchat-label,.tray-name');
        if(!icon||!label)return null;const r=icon.getBoundingClientRect(),l=label.getBoundingClientRect();
        return {x:r.x,y:r.y,w:r.width,h:r.height,gap:l.x-r.right,color:getComputedStyle(icon.querySelector('path')).stroke,html:icon.outerHTML}};
      const agent=document.querySelector('#agent-sample .quickchat-superior');
      resolve({selected:mark(selected),option:mark(option),agentModel:!!agent.querySelector('.tier.t-sonnet'),agentEye:!!agent.querySelector('.eye'),
        selectedLabel:selected.textContent,optionLabel:option.textContent});},250))))`)
    fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify(state, null, 2))
    if (!state.selected || !state.option || !state.agentModel || state.agentEye || state.selectedLabel !== 'top level' || state.optionLabel !== 'top level') throw Error('Wrong Quick chat identity state')
    for (const key of ['w', 'h', 'gap', 'color', 'html']) if (state.selected[key] !== state.option[key]) throw Error('Mismatched shared eye: ' + key)
    if (state.selected.w !== 16 || state.selected.h !== 16 || state.selected.gap !== 8) throw Error('Wrong icon size/spacing')
    const image = await win.webContents.capturePage()
    if (image.isEmpty()) throw Error('Empty capture')
    fs.writeFileSync(path.join(root, 'quickchat-eye.png'), image.toPNG())
  } finally { win.destroy() }
}).then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1) })
