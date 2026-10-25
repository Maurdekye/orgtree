// Real-renderer phase-1 capture: no engine, live data, OS input or real clipboard.
const {app,BrowserWindow,session,clipboard}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process')
const out=path.resolve(process.argv[2])
if(!out.toLowerCase().startsWith('c:\\orgtree-build\\mention-reply-sol\\'))throw Error('Output outside assigned root')
const sessionId=Number(execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${process.pid}).SessionId`],{encoding:'utf8',windowsHide:true}).trim())
assert.equal(sessionId,0,'Session 0 required before any window')
app.setPath('userData',path.join(out,'profile-'+process.pid));app.setPath('sessionData',path.join(out,'session-'+process.pid))
app.disableHardwareAcceleration()
const clipboardCalls=[]
for(const key of Object.keys(clipboard))if(typeof clipboard[key]==='function')Object.defineProperty(clipboard,key,{value:()=>{clipboardCalls.push(key);return key==='availableFormats'?[]:key==='has'?false:''}})
fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script></html>')
fs.writeFileSync(path.join(out,'clipboard.preload.cjs'),`Object.defineProperty(navigator,'clipboard',{value:Object.freeze({read:()=>Promise.reject(Error('Clipboard denied')),readText:()=>Promise.reject(Error('Clipboard denied')),write:()=>Promise.reject(Error('Clipboard denied')),writeText:()=>Promise.reject(Error('Clipboard denied'))})});window.__clipboardBlocked=true;`)
async function within(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms)})])}finally{clearTimeout(timer)}}
app.whenReady().then(async()=>{
  console.log('Isolated Electron ready: PID '+process.pid+', Session '+sessionId)
  const isolated=session.fromPartition('mail-tag-limit-'+process.pid)
  isolated.setPermissionCheckHandler(()=>false)
  isolated.setPermissionRequestHandler((_wc,_permission,done)=>done(false))
  const win=new BrowserWindow({width:1000,height:720,show:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:false,sandbox:false,nodeIntegration:false,preload:path.join(out,'clipboard.preload.cjs'),session:isolated}})
  const wc=win.webContents
  wc.setWindowOpenHandler(()=>({action:'deny'}))
  for(const method of ['cut','copy','paste','pasteAndMatchStyle'])wc[method]=()=>{throw Error('Clipboard command forbidden')}
  try {
    // Do not await renderer CDP commands before first navigation creates it.
    await within(win.loadFile(path.join(out,'index.html')),15000,'Fixture load timeout')
    console.log('Loaded production mail fixture')
    await wc.executeJavaScript(`new Promise((resolve,reject)=>{const end=Date.now()+5000;function ready(){if(document.querySelector('#read-pane .mailer-head .mail-tag'))return resolve();if(Date.now()>end)return reject(Error('Mail fixture not mounted'));setTimeout(ready,20)}ready()})`)
    await wc.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,150))))`)
    const measured=await wc.executeJavaScript(`(()=>{
      const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
      const inspect=e=>({rect:rect(e),header:rect(e.querySelector('.mfrom')),tags:[...e.querySelectorAll('.l2 .mail-tag[data-tag-key]')].map(t=>({text:t.textContent,rect:rect(t)})),more:e.querySelector('.mail-tag-more')?.textContent,hidden:e.querySelector('.mail-tag-more')?.title});
      return {plain:inspect(document.querySelector('#narrow-row > .mailrow')),filtered:inspect(document.querySelector('#filtered-row .mailrow')),baseline:rect(document.querySelector('#baseline-row .mfrom')),detailTags:document.querySelectorAll('#read-pane .mailer-head .mail-tag[data-tag-key]').length,filterTags:document.querySelectorAll('#narrow-row .mail-list-controls .mail-tag-active').length,clipboardBlocked:window.__clipboardBlocked,viewport:{width:innerWidth,height:innerHeight}};
    })()`)
    assert.deepEqual(measured.plain.tags.map(t=>t.text),['a lengthy build announcement tag','release','alpha build'])
    assert.deepEqual(measured.filtered.tags.map(t=>t.text),['ready','review','engine'])
    for(const item of [measured.plain,measured.filtered]){
      assert.equal(item.more,'(+5)')
      assert(item.rect.width>0&&item.rect.height>0)
      for(const tag of item.tags){assert(tag.rect.width>0&&tag.rect.height>0);assert(tag.rect.x>=item.rect.x-.5&&tag.rect.right<=item.rect.right+.5,'Tags stay within real narrow row')}
    }
    assert.equal(measured.plain.hidden,'review, progress, renderer, engine, ready')
    assert.equal(measured.filtered.hidden,'a lengthy build announcement tag, release, alpha build, progress, renderer')
    assert(Math.abs(measured.plain.header.width-measured.baseline.width)<.5)
    assert.equal(measured.detailTags,8);assert.equal(measured.filterTags,2)
    assert.equal(measured.clipboardBlocked,true)
    // Move only the owned renderer pointer over the real overflow annotation.
    wc.debugger.attach('1.3')
    const hover=await wc.executeJavaScript(`(()=>{const r=document.querySelector('#narrow-row > .mailrow .mail-tag-more').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...hover})
    await wc.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,150))))`)
    fs.writeFileSync(path.join(out,'mail-tag-limit.png'),(await wc.capturePage()).toPNG())
    assert.deepEqual(clipboardCalls,[])
    const receipt={status:'PASS',source:'Production MailRowView and MailList with the full bundled stylesheet',pid:process.pid,sessionId,clipboardInitiallyEmpty:true,clipboardPermissionsDenied:true,nativeClipboardStubbed:true,rendererClipboardBlocked:true,clipboardCalls,measured,nativeTooltipPixels:'Not measured; hidden names verified from the real overflow element title'}
    fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2))
    console.log(JSON.stringify(receipt));app.exit(0)
  }catch(error){console.error(error);app.exit(1)}
}).catch(error=>{console.error(error);app.exit(1)})
