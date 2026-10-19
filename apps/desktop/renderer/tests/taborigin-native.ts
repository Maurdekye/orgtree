import {app,BrowserWindow,screen} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import * as nativeBounds from '../../main/windows'
const {exactPopoutBounds,popoutDisplayBounds,setExactPopoutBounds}=nativeBounds
// The frozen product baseline has no tab-only clamp; this lets the same
// instrument measure its old behavior rather than failing to bundle.
const tabBounds=(nativeBounds as unknown as Record<string,unknown>).tabPopoutBounds as
 ((features:string,rect:Electron.Rectangle,display:typeof screen)=>Electron.Rectangle)|undefined
const root=process.env.TAB_ORIGIN_OUTPUT!
if(!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(root||''))throw Error('Expected own output')
app.setPath('userData',path.join(root,'user-data'));app.disableHardwareAcceleration()
const windows=new Set<BrowserWindow>(),rows:{label:string;source:unknown;actual:unknown;errors:string[]}[]=[]
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))
const boxScript=`e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}}`
async function painted(w:BrowserWindow){await w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,150))))')}
const near=(a:number,b:number)=>Math.abs(a-b)<=1
const same=(a:object,b:object)=>Object.keys(b).every(k=>near((a as Record<string,number>)[k],(b as Record<string,number>)[k]))
app.whenReady().then(async()=>{
 const files:Record<string,[string,Buffer|string]>={
  '/':['text/html','<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><style>html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font:14px system-ui}.desk-bare{height:100%}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'],
  '/fixture.js':['text/javascript',fs.readFileSync(path.join(root,'fixture.js'))],
  '/styles.css':['text/css',fs.readFileSync(process.env.TAB_ORIGIN_STYLES!)],
  '/katex/dist/katex.min.css':['text/css',fs.readFileSync(process.env.TAB_ORIGIN_KATEX!)]}
 const server=http.createServer((req,res)=>{const f=files[(req.url||'').split('?')[0]];res.writeHead(f?200:404,{'content-type':f?.[0]||'text/plain'});res.end(f?.[1]||'Synthetic fixture only')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const parent=new BrowserWindow({show:false,width:1000,height:700,useContentSize:true,paintWhenInitiallyHidden:true,
  webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
 windows.add(parent)
 let child:BrowserWindow|undefined,features='',nativeTarget:Electron.Rectangle|null=null
 parent.webContents.setWindowOpenHandler(d=>{
  features=d.features;const requested=exactPopoutBounds(features,parent)
  const mapped=requested?popoutDisplayBounds(parent,requested,screen):null
  nativeTarget=mapped?(tabBounds?tabBounds(features,mapped,screen):mapped):null
  return{action:'allow',overrideBrowserWindowOptions:{show:false,frame:false,webPreferences:{backgroundThrottling:false}}}
 })
 parent.webContents.on('did-create-window',w=>{child=w;windows.add(w);if(nativeTarget)setExactPopoutBounds(w,nativeTarget)})
 const deadline=setTimeout(()=>{console.error('Tab origin instrument deadline');for(const w of windows)if(!w.isDestroyed())w.destroy();app.exit(2)},30000)
 try{
  await parent.loadURL('http://127.0.0.1:'+((server.address() as {port:number}).port)+'/')
  await parent.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const tick=()=>{
   if(window.tabOriginReset)resolve();else if(++n<100)setTimeout(tick,20);else reject(Error('Missing actual desk fixture'));};tick()})`)
  for(const isProject of [false,true])for(const action of ['pin','popout']){
   child=undefined
   await parent.webContents.executeJavaScript(`window.tabOriginReset(${isProject},false);true`);await painted(parent)
   await parent.webContents.executeJavaScript(`document.querySelector('[data-tab="team"]').click();true`);await painted(parent)
   const source=await parent.webContents.executeJavaScript(`(${boxScript})(document.querySelector('.origin-desk-host .team-tabpanel'))`)
   await parent.webContents.executeJavaScript(`document.querySelectorAll('.origin-desk-host .panel-corner-btn')[${action==='pin'?0:1}].click();true`,true)
   await painted(parent)
   let actual:unknown,errors:string[]=[]
   if(action==='pin'){
    actual=await parent.webContents.executeJavaScript(`(${boxScript})(document.querySelector('.team-panel.modalpin-win'))`)
    if(!same(actual as Record<string,number>,source))errors.push('New pin did not inherit inline tab position and size')
    if(!isProject){
     await parent.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.origin-desk-host .team-tabpanel').getBoundingClientRect();
      const marker=document.createElement('div');marker.style.cssText='position:fixed;pointer-events:none;z-index:2147483646;border:2px dashed #c884ff;box-sizing:border-box';
      Object.assign(marker.style,{left:(r.x-2)+'px',top:(r.y-2)+'px',width:(r.width+4)+'px',height:(r.height+4)+'px'});document.body.appendChild(marker)})()`)
     await painted(parent);const image=await parent.webContents.capturePage();if(image.isEmpty())throw Error('Empty capture')
     fs.writeFileSync(path.join(root,'tab-origin.png'),image.toPNG())
    }
   }else{
    await sleep(150)
    if(!child||child.isDestroyed())throw Error('Actual adopted child must remain alive (check fixture CSS imports)')
    const mode=await child.webContents.executeJavaScript(`document.querySelector('.team-panel')?.className`)
    if(!String(mode).includes('modalpin-detached'))throw Error('Surface never entered actual child')
    const values=Object.fromEntries(features.split(',').map(p=>p.split('=')))
    if(values.orgtreeExactRect!=='1'||!same({x:Number(values.orgtreeClientX),y:Number(values.orgtreeClientY),w:Number(values.orgtreeClientWidth),h:Number(values.orgtreeClientHeight)},source))errors.push('Popup did not receive original inline client bounds')
    if(values.orgtreeClampDisplay!=='1')errors.push('Inline popup omitted work-area clamp request')
    actual={features,bounds:child.getContentBounds(),target:nativeTarget}
    if(!nativeTarget||!same(child.getContentBounds(),nativeTarget))errors.push('Actual child content bounds differ from exact/clamped native target')
    child.destroy()
   }
   rows.push({label:(isProject?'project':'agent')+'-'+action,source,actual,errors});console.log((errors.length?'FAIL ':'PASS ')+rows.at(-1)!.label+': '+errors.join('; '))
  }
  // The modal's own button must still measure itself after earlier tab requests.
  await parent.webContents.executeJavaScript('window.tabOriginReset(false,true);true');await painted(parent)
  const source=await parent.webContents.executeJavaScript(`(${boxScript})(document.querySelector('.team-panel'))`)
  await parent.webContents.executeJavaScript(`document.querySelector('.team-panel .modalpin-btn').click();true`);await painted(parent)
  const actual=await parent.webContents.executeJavaScript(`(${boxScript})(document.querySelector('.team-panel.modalpin-win'))`)
  const errors=!near(actual.x,source.x)||!near(actual.y,source.y)||!near(actual.w,Math.max(320,source.w))||!near(actual.h,Math.max(240,source.h))?['Modal pin no longer uses its own bounds/minimum']:[]
  rows.push({label:'modal-pin-preserved',source,actual,errors});console.log((errors.length?'FAIL ':'PASS ')+'modal-pin-preserved')
  fs.writeFileSync(path.join(root,'geometry.json'),JSON.stringify({rows,pass:rows.filter(r=>!r.errors.length).length,fail:rows.filter(r=>r.errors.length).length},null,2))
 }finally{clearTimeout(deadline);for(const w of [...windows].reverse())if(!w.isDestroyed())w.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()))}
}).then(()=>app.exit(rows.some(r=>r.errors.length)?1:0),e=>{fs.writeFileSync(path.join(root,'instrument-error.txt'),e.stack||String(e));console.error(e);app.exit(2)})
