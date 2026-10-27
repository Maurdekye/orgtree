const {app,BrowserWindow,session,clipboard}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process')
const out=path.resolve(process.argv[2]),sid=pid=>Number(execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${Number(pid)}).SessionId`],{encoding:'utf8',windowsHide:true}).trim())
assert.equal(sid(process.pid),0,'Session0 required before creating a window')
app.setPath('userData',out+'/profile-'+process.pid);app.setPath('sessionData',out+'/session-'+process.pid)
app.disableHardwareAcceleration();app.commandLine.appendSwitch('mute-audio')
let clipboardCalls=0;for(const k of Object.keys(clipboard))if(typeof clipboard[k]==='function')clipboard[k]=()=>{clipboardCalls++;return k==='availableFormats'?[]:k==='has'?false:''}
async function within(p,ms){let timer;try{return await Promise.race([p,new Promise((_r,j)=>{timer=setTimeout(()=>j(Error('Capture deadline')),ms)})])}finally{clearTimeout(timer)}}
app.whenReady().then(async()=>{
 const ses=session.fromPartition('mention-wrap-'+process.pid);ses.setPermissionCheckHandler(()=>false);ses.setPermissionRequestHandler((_w,_p,done)=>done(false));ses.webRequest.onBeforeRequest((d,done)=>done({cancel:! /^(file:|data:|blob:|about:)/.test(d.url)}))
 const win=new BrowserWindow({width:1024,height:768,show:false,frame:false,webPreferences:{session:ses,offscreen:true,backgroundThrottling:false,nodeIntegration:false,sandbox:true,contextIsolation:true}}),wc=win.webContents,errors=[]
 wc.setAudioMuted(true);wc.setWindowOpenHandler(()=>({action:'deny'}));for(const k of ['copy','cut','paste','pasteAndMatchStyle'])wc[k]=()=>{throw Error('Clipboard denied')}
 wc.on('console-message',(_e,level,message)=>{if(level>=2)errors.push(message)})
 const js=s=>wc.executeJavaScript(s),wait=s=>js(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function check(){if(${s})return resolve();if(Date.now()>end)return reject(Error('Wait: '+${JSON.stringify(s)}));setTimeout(check,20)}check()})`)
 const paint=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,100))))')
 const shot=async name=>{await paint();fs.writeFileSync(path.join(out,name),(await wc.capturePage()).toPNG())}
 const measure=()=>js(`(()=>{const rect=r=>({x:r.x,y:r.y,width:r.width,height:r.height,right:r.right});return [...document.querySelectorAll('#wrap-examples [data-object-nav]')].map(e=>({kind:e.dataset.objectNav,tag:e.tagName,role:e.getAttribute('role'),label:e.textContent,title:e.getAttribute('title'),fragments:[...e.getClientRects()].map(rect),row:rect(e.closest('p').getBoundingClientRect()),decoration:getComputedStyle(e).boxDecorationBreak,shadow:getComputedStyle(e).boxShadow,underline:getComputedStyle(e).textDecorationLine}));})()`)
 try{
  await within(win.loadFile(out+'/index.html'),15000);await wait("document.querySelectorAll('#wrap-examples [data-object-nav]').length===10");await paint()
  const initial=await measure();assert.equal(initial.every(e=>e.tag==='BUTTON'&&e.fragments.length===1),true)
  await shot('01-wrap-default-off.png')
  await js('window.wrapFixture.settings(true)');await wait("document.querySelector('input[aria-label=\"Wrap object mentions\"]')&&!document.querySelector('input[aria-label=\"Wrap object mentions\"]').disabled")
  assert.equal(await js("document.querySelector('input[aria-label=\"Wrap object mentions\"]').checked"),false)
  await js("document.querySelector('input[aria-label=\"Wrap object mentions\"]').click()")
  await wait("document.querySelectorAll('#wrap-examples span[role=button][data-object-nav]').length===10")
  await shot('02-display-wrap-on.png');await js('window.wrapFixture.settings(false)');await paint()
  const on=await measure();assert.equal(on.length,10)
  for(const e of on){assert(e.fragments.length>1,`${e.kind} must fragment`);assert(e.fragments[0].x>e.row.x+20,'link starts within the sentence');for(const r of e.fragments){assert(r.width>0&&r.height>0);assert(r.x>=e.row.x-.5&&r.right<=e.row.right+.5,'fragment fits paragraph')}assert.equal(e.decoration,'clone')}
  wc.debugger.attach('1.3');const first=on[0].fragments[0];await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:first.x+10,y:first.y+first.height/2})
  await js("document.querySelector('#react-links [data-object-nav=document]').focus()")
  await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  assert.equal(await js('window.wrapFixture.opened.length'),1)
  const decorated=await measure();assert.equal(decorated[0].underline,'underline');assert.equal(decorated[1].underline,'underline')
  await shot('03-wrap-on-inline.png')
  await js('window.wrapFixture.settings(true)');await wait("document.querySelector('input[aria-label=\"Wrap object mentions\"]')&&!document.querySelector('input[aria-label=\"Wrap object mentions\"]').disabled")
  await js("document.querySelector('input[aria-label=\"Wrap object mentions\"]').click()")
  await wait("document.querySelectorAll('#wrap-examples button[data-object-nav]').length===10")
  await js('window.wrapFixture.settings(false)');await paint();const off=await measure();assert.equal(off.every(e=>e.tag==='BUTTON'&&e.fragments.length===1),true);await shot('04-wrap-restored-off.png')
  const writes=await js('window.wrapFixture.writes');assert.deepEqual(writes,[{wrap_object_mentions:true},{wrap_object_mentions:false}]);assert.equal(clipboardCalls,0)
  const result={status:'PASS',pid:process.pid,sessionId:sid(process.pid),rendererPid:wc.getOSProcessId(),rendererSessionId:sid(wc.getOSProcessId()),muted:wc.isAudioMuted(),clipboardCalls,clipboardPermissionsDenied:true,clipboardNativeStubbed:true,input:'owned DOM/CDP only',source:'production AccountsPanel, RefChip, RefMdBody, WorkRefText, styles.css and shell.css; synthetic settings/app-feed transport',initial,on,decorated,off,writes,errors}
  fs.writeFileSync(out+'/receipt.json',JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,pid:result.pid,sessionId:result.sessionId,muted:result.muted,fragments:on.map(e=>e.fragments.length),errors}));app.exit(0)
 }catch(e){console.error(e);fs.writeFileSync(out+'/failure.json',JSON.stringify({error:String(e),errors},null,2));app.exit(1)}
}).catch(e=>{console.error(e);app.exit(1)})
