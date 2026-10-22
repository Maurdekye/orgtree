const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path')
const root = process.env.MISSING_PATH_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(root || '')) throw Error('assigned output required')
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  try {
    await win.loadFile(path.join(root, 'index.html'))
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{ const deadline=performance.now()+8000;
      const check=()=>{ const link=document.querySelector('[data-local-file-state="missing"]');
        if(document.body.dataset.ready==='true'&&link){link.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:300,clientY:200}));resolve(true)}
        else if(performance.now()>deadline)reject(Error('fixture not ready'));else setTimeout(check,20)};check() })`)
    const state = await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>{
      const links=[...document.querySelectorAll('[data-local-path]')];
      const items=[...document.querySelectorAll('.ctxmenu [role="menuitem"]')];
      resolve({links:links.map(el=>({path:el.dataset.localPath,text:el.textContent,title:el.title,state:el.dataset.localFileState,
        colour:getComputedStyle(el).color,directoryColour:el.querySelector('.dim')&&getComputedStyle(el.querySelector('.dim')).color})),
        menu:items.map(el=>({label:el.textContent,disabled:el.disabled})),
        visible:items.every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight}),
        background:getComputedStyle(document.body).backgroundColor})},250))))`)
    if(state.links.length!==4||state.links.slice(0,3).some(l=>l.text!==l.path)||state.links[3].text!=='README.md'
      ||JSON.stringify(state.menu.map(i=>i.label))!==JSON.stringify(['File no longer exists','Copy path','Copy file name'])
      ||!state.menu[0].disabled||state.menu.slice(1).some(i=>i.disabled)||!state.visible
      ||state.links[0].colour===state.links[0].directoryColour)throw Error('visual state failed: '+JSON.stringify(state))
    const image=await win.webContents.capturePage(),bitmap=image.toBitmap()
    if(image.isEmpty())throw Error('empty capture')
    const actual=`rgb(${bitmap[2]}, ${bitmap[1]}, ${bitmap[0]})`
    if(actual!==state.background)throw Error('stale capture background: '+actual+' expected '+state.background)
    fs.writeFileSync(path.join(root,'missing-path.png'),image.toPNG())
    fs.writeFileSync(path.join(root,'capture.json'),JSON.stringify({...state,actualBackground:actual},null,2))
  } finally { win.destroy() }
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
