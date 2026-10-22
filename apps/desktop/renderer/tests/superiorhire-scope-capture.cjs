const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path')
const root = process.env.SUPERIOR_SCOPE_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(root || '')) throw Error('assigned output required')
app.setPath('userData', path.join(root, 'user-data')); app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  try {
    win.webContents.session.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file:|data:)/.test(d.url) }))
    await win.loadFile(path.join(root, 'index.html'))
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const end=performance.now()+8000;const check=()=>{
      if(document.querySelector('.draft-scope-inherited'))resolve(true);
      else if(performance.now()>end)reject(Error('no inheritance note'));else setTimeout(check,20)};check()})`)
    await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,250))))`)
    const state = await win.webContents.executeJavaScript(`(()=>{const note=document.querySelector('.draft-scope-inherited');
      const apply=[...document.querySelectorAll('button')].find(b=>b.textContent==='apply');const rect=apply.getBoundingClientRect();
      return {note:note.textContent,account:document.querySelector('select[aria-label="Account"]')?.value,
        effort:document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext'),
        overrides:!!document.querySelector('input[placeholder="Add a folder path"], select[aria-label="Visible agents"], [aria-label="Refresh MCP servers, skills and instructions"]'),
        applyVisible:rect.top>=0&&rect.bottom<=innerHeight,background:getComputedStyle(document.body).backgroundColor}})()`)
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(state, null, 2))
    if (!state.note.includes('inherited from coordinator when hired') || state.overrides || state.account !== 'openai-test'
      || !state.effort?.includes('high') || !state.applyVisible) throw Error('modal projection failed: '+JSON.stringify(state))
    const image=await win.webContents.capturePage(),bitmap=image.toBitmap()
    if (image.isEmpty()) throw Error('empty capture')
    const actual=`rgb(${bitmap[2]}, ${bitmap[1]}, ${bitmap[0]})`
    // ModalOverPins composites a 45% black scrim over the body.
    const expected=state.background.match(/\d+/g).slice(0,3).map(v=>Math.round(Number(v)*0.55))
    if(expected.some((v,i)=>Math.abs(v-[bitmap[2],bitmap[1],bitmap[0]][i])>1))throw Error('stale capture palette')
    fs.writeFileSync(path.join(root,'superior-scope.png'),image.toPNG())
    fs.writeFileSync(path.join(root,'capture.json'),JSON.stringify({...state,actualBackground:actual},null,2))
  } finally { win.destroy() }
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
