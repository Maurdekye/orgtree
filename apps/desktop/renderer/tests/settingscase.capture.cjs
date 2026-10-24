/* Settings-only real-renderer evidence: Session 0, private profile, no engine.
 * No OS input. Own-window DOM/CDP only; Electron and browser clipboard blocked.
 * Every capture records actual child/renderer SessionId and clipboard denial.
 */
const {app,BrowserWindow,session,clipboard}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process')
const out=path.resolve(process.argv[2]),errors=[],shots=[]
const sessionId=pid=>Number(execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${Number(pid)}).SessionId`],{encoding:'utf8',windowsHide:true}).trim())
const mainSession=sessionId(process.pid)
assert.equal(mainSession,0,'capture refuses the signed-in session')
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.setPath('sessionData',path.join(out,'session'))
let clipboardCalls=0
for(const key of Object.keys(clipboard)){if(typeof clipboard[key]!=='function')continue;clipboard[key]=()=>{clipboardCalls++;if(key.startsWith('write'))throw Error('Native clipboard denied');if(key==='availableFormats')return[];if(key==='has')return false;return''}}
assert.equal(clipboard.readText(),'');assert.throws(()=>clipboard.writeText('fixture-denial-control'),/Native clipboard denied/)
const isolation={childPid:process.pid,childSessionId:mainSession,rendererPid:null,rendererSessionId:null,profile:'private fixture',permissionCheck:'deny all',permissionRequest:'deny all',nativeClipboard:'stubbed empty reads; writes refused before first window',browserClipboard:'empty reads and writes refused; permissions denied',realClipboardAccess:false,input:'own-window DOM/CDP only; no OS input'}
app.commandLine.appendSwitch('disable-gpu')
const delay=ms=>new Promise(r=>setTimeout(r,ms))
app.whenReady().then(async()=>{
 const ses=session.fromPartition('settings-case-isolated')
 ses.setPermissionCheckHandler(()=>false);ses.setPermissionRequestHandler((_wc,_permission,done)=>done(false))
 ses.webRequest.onBeforeRequest((details,done)=>done({cancel:! /^(file:|data:|blob:|about:)/.test(details.url)}))
 const win=new BrowserWindow({width:1000,height:750,show:false,webPreferences:{offscreen:true,session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}))
 win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('file:'))event.preventDefault()})
 win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)errors.push(message)})
 win.webContents.on('render-process-gone',(_event,detail)=>errors.push(JSON.stringify(detail)))
 await win.loadFile(path.join(out,'index.html'))
 isolation.rendererPid=win.webContents.getOSProcessId();isolation.rendererSessionId=sessionId(isolation.rendererPid);assert.equal(isolation.rendererSessionId,0)
 const js=source=>win.webContents.executeJavaScript(source,true)
 const paint=()=>js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,100))))')
 let seq=0
 for(const screen of process.argv[3]?[process.argv[3]]:['app','org','agent','project','draft','defaults','neworg']){
  await js(`window.settingsCaseRender(${JSON.stringify(screen)})`);await delay(250);await paint()
  if(screen==='neworg'){
   await js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/New organization/.test(e.textContent));if(b)b.click()})()`);await paint()
   const advanced=await js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/advanced/i.test(e.textContent));if(b)b.click();return !!b})()`);if(!advanced)errors.push('New-org advanced opener unavailable')
   await paint()
  }
  const tabs=await js(`[...document.querySelectorAll('[role="tab"],.adv-tabs button')].filter(e=>e.getClientRects().length).map((e,i)=>{e.id ||= 'capture-tab-'+i;return {id:e.id,label:e.textContent.trim()}})`)
  for(const tab of tabs.length?tabs:[{id:null,label:'Main'}]){
   if(tab.id){await js(`document.getElementById(${JSON.stringify(tab.id)}).click()`);await delay(200);await paint()}
   const groups=await js(`(()=>{document.querySelectorAll('[data-case-capture]').forEach(e=>e.removeAttribute('data-case-capture'));const visible=e=>e.getClientRects().length&&!e.closest('[hidden]');const els=[...document.querySelectorAll('.set-group')].filter(visible);const panels=[...document.querySelectorAll('[role="tabpanel"]:not([hidden])')].filter(visible);const use=els.length?els:panels.length?panels:[...document.querySelectorAll('.settings')].filter(visible);const actual=use.length?use:[document.body];return actual.map((e,i)=>{e.dataset.caseCapture=String(i);return {index:i,title:(e.matches('.set-group')?e.querySelector('.set-group-head')?.textContent?.trim():null)||${JSON.stringify(tab.label)},height:e.getBoundingClientRect().height,text:e.innerText}})})()`)
   for(const group of groups){
    await js(`document.querySelector('[data-case-capture="${group.index}"]').scrollIntoView({block:'start'})`);await paint()
    const rect=await js(`(()=>{const e=document.querySelector('[data-case-capture="${group.index}"]'),r=e.getBoundingClientRect();let s=e;while(s.parentElement&&!(s.scrollHeight>s.clientHeight+2&&/auto|scroll/.test(getComputedStyle(s).overflowY)))s=s.parentElement;e._caseScroller=s;const sr=s.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,contentHeight:s===e?e.scrollHeight:r.height,viewportHeight:s.clientHeight,offset:s===e?0:s.scrollTop+r.top-sr.top}})()`)
    assert.ok(rect.width>0&&rect.height>0,'section has real layout')
    const step=Math.max(200,rect.viewportHeight-80),parts=Math.max(1,Math.ceil(rect.contentHeight/step))
    for(let part=0;part<parts;part++){
     await js(`(()=>{const e=document.querySelector('[data-case-capture="${group.index}"]');e._caseScroller.scrollTop=${rect.offset+part*step}})()`);await paint()
     const file=String(++seq).padStart(3,'0')+'-'+screen+'-'+tab.label.replace(/[^a-z0-9]+/gi,'-')+'-'+group.title.slice(0,48).replace(/[^a-z0-9]+/gi,'-')+'-'+(part+1)+'.png'
     fs.writeFileSync(path.join(out,file),(await win.webContents.capturePage()).toPNG())
     shots.push({file,screen,tab:tab.label,section:group.title,part:part+1,parts,text:group.text,rect,...isolation})
    }
   }
  }
 }
 fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify({isolation,shots,errors,clipboardCalls},null,2))
 assert.ok(shots.length>=(process.argv[3]?1:40),'actual settings sections captured')
 assert.equal(errors.filter(e=>!/Content-Security-Policy|preload|DevTools|Autofill|file.*source map/i.test(e)).length,0,'no renderer errors')
 console.log(JSON.stringify({captures:shots.length,isolation,errors}));win.destroy();app.quit()
}).catch(error=>{fs.writeFileSync(path.join(out,'failed-receipt.json'),JSON.stringify({isolation,shots,errors,error:error.stack},null,2));console.error(error);app.exit(1)})
