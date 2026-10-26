'use strict'
const {app,BrowserWindow,session,clipboard}=require('electron')
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process')
const root=process.env.HELPER_BADGE_CAPTURE
assert.match(root||'',/^C:\/orgtree-build\/helper-transcript-sol\/helper-badge\/visual$/)
const measured=pid=>{const s=Number(execFileSync('powershell.exe',['-NoProfile','-Command','(Get-Process -Id '+pid+').SessionId'],{encoding:'utf8',windowsHide:true}).trim());assert.equal(s,0);return{pid,session:s}}
const receipt={source:process.env.HELPER_BADGE_SOURCE,parent:measured(process.pid),checks:[],clipboard:'Private empty reads; writes/edit operations blocked; permissions denied',input:'CDP to owned Session0 window only',limits:'Actual desk header/badge/panel/transcript components and stylesheet with synthetic API; no live harness/engine or native file reads'}
for(const key of ['userData','sessionData','logs','crashDumps']){const p=path.join(root,'profile',key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}
for(const key of ['readText','readHTML','readRTF','readImage','readBookmark','readFindText','availableFormats'])clipboard[key]=()=>key==='availableFormats'?[]:''
for(const key of ['write','writeText','writeHTML','writeRTF','clear','writeImage','writeBookmark','writeFindText'])clipboard[key]=()=>{throw Error('Clipboard denied')}
app.disableHardwareAcceleration()
let win,server,timer,reads=0
app.whenReady().then(async()=>{
 timer=setTimeout(()=>finish(Error('Capture deadline')),45000)
 server=http.createServer((req,res)=>{
  const route=req.url.split('?')[0]
  if(route.endsWith('/helpers')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({count:2,items:[
   {id:'claude:a',harness:'claude',kind:'Explore',description:'Inspect widget rendering',model:'small',started_at:'2026-10-26T10:00:00Z',status:'running',live:true,transcript:true,seq:7,tool:'call-a'},
   {id:'codex:b',harness:'codex',kind:'Helper agent',description:'Check edge conditions',model:'codex',started_at:'2026-10-26T10:00:01Z',status:'running',live:true,transcript:false}]}));return}
  if(route.includes('/helpertranscript/')){reads++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({live:true,messages:[{id:'helper-msg',text:reads>1?'**Live update:** widget bounds checked; inspecting the next case.':'**Working:** inspecting the widget layout.'}]}));return}
  if(route==='/ui.js'||route==='/ui.css'){res.setHeader('Content-Type',route.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(root+route));return}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><link rel="stylesheet" href="/ui.css"><div id="root"></div><script src="/ui.js"></script>')
 })
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port
 const ses=session.fromPartition('helper-badge-'+process.pid);ses.setPermissionRequestHandler((_a,_b,cb)=>cb(false));ses.setPermissionCheckHandler(()=>false);ses.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith(origin+'/')&&!/^(data:|about:blank|blob:)/.test(d.url)}))
 win=new BrowserWindow({width:1000,height:700,useContentSize:true,show:false,focusable:false,webPreferences:{session:ses,offscreen:true,sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}})
 for(const action of ['copy','cut','paste','pasteAndMatchStyle','selectAll'])win.webContents[action]=()=>{throw Error('Native edit denied')}
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));await win.loadURL(origin+'/o/fixture');receipt.renderer=measured(win.webContents.getOSProcessId());win.webContents.debugger.attach('1.3')
 const js=code=>win.webContents.executeJavaScript(code)
 const ready=async code=>{const t=Date.now();while(!await js(code)){if(Date.now()-t>10000)throw Error('Not ready: '+code);await new Promise(r=>setTimeout(r,50))}}
 const painted=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,180))))')
 const box=selector=>js(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().toJSON()`)
 const onScreen=b=>{assert(b&&b.width>0&&b.height>0);assert(b.left>=0&&b.top>=0&&b.right<=1000&&b.bottom<=700)}
 await ready('!!document.querySelector(".live-helpers-badge")');await painted();const badge=await box('.live-helpers-badge');onScreen(badge)
 assert.equal(await js('document.querySelector(".live-helpers-badge").textContent.trim()'),'2 helpers');fs.writeFileSync(root+'/badge.png',(await win.webContents.capturePage()).toPNG())
 for(const type of ['mouseMoved','mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:badge.x+badge.width/2,y:badge.y+badge.height/2,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})})
 await ready('document.querySelector(".helper-transcript")?.textContent.includes("Live update:")');await painted()
 const panel=await box('.live-helpers-panel');onScreen(panel)
 const state=await js(`({items:document.querySelectorAll('.live-helpers-list button').length,description:document.querySelector('.live-helper-details h3')?.textContent,text:document.querySelector('.helper-transcript')?.textContent,markdown:document.querySelectorAll('.helper-transcript strong').length})`)
 assert.equal(state.items,2);assert.equal(state.description,'Inspect widget rendering');assert.match(state.text,/Live update:/);assert(state.markdown>0);assert(reads>=2)
 fs.writeFileSync(root+'/panel-live.png',(await win.webContents.capturePage()).toPNG());receipt.checks.push({badge,panel,...state,transcriptReads:reads});finish()
}).catch(finish)
function finish(error){if(receipt.finished)return;receipt.finished=new Date().toISOString();clearTimeout(timer);if(win&&!win.isDestroyed())win.destroy();if(server)server.close();receipt.status=error?1:0;if(error)receipt.error=String(error.stack||error);fs.writeFileSync(root+'/receipt.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));app.exit(receipt.status)}
