const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path')
const root = process.env.MISSING_PATH_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(root || '')) throw Error('assigned output required')
app.setPath('userData', path.join(root, 'user-data')); app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  try {
    win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!/^(file:|data:)/.test(d.url)}))
    await win.loadFile(path.join(root, 'index.html'))
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const end=performance.now()+8000;const check=()=>{
      const card=[...document.querySelectorAll('.sq')].find(el=>el.querySelector('.name')?.textContent==='coordinator');
      const token=card?.querySelector('.hsof.side-t button.t-sol');if(token){token.click();resolve(true)}
      else if(performance.now()>end)reject(Error('no root superior token'));else setTimeout(check,20)};check()})`)
    await win.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,1200))`)
    await win.webContents.executeJavaScript(`(()=>{const el=document.querySelector('.sq.draft .df-name');if(!el)throw Error('no draft');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'liaison');el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,150))))`)
    await win.webContents.executeJavaScript(`document.querySelector('.sq.draft .df-foot .primary').click()`)
    const state = await win.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({
      requests:window.superiorHireRequests, tree:window.superiorHireTree, text:document.body.innerText,
      draft:!!document.querySelector('.sq.draft'),background:getComputedStyle(document.body).backgroundColor
    }))),1500))`)
    fs.writeFileSync(path.join(root,'state.json'),JSON.stringify(state,null,2))
    if(state.requests.length!==1||state.requests[0].steps.length!==1||state.requests[0].steps[0].above!=='coordinator'
      ||state.requests[0].steps[0].target!=='coordinator'||state.tree.roots[0].id!=='liaison'
      ||state.tree.roots[0].children[0].id!=='coordinator'||!state.text.includes('liaison')||state.draft)
      throw Error('capture projection failed: '+JSON.stringify(state))
    const image=await win.webContents.capturePage(),bitmap=image.toBitmap()
    if(image.isEmpty())throw Error('empty capture')
    const actual=`rgb(${bitmap[2]}, ${bitmap[1]}, ${bitmap[0]})`
    if(actual!==state.background)throw Error('stale capture background')
    fs.writeFileSync(path.join(root,'superior-hire.png'),image.toPNG())
    fs.writeFileSync(path.join(root,'capture.json'),JSON.stringify({...state,actualBackground:actual},null,2))
  } finally { win.destroy() }
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
