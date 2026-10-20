const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.WS_CONNECT_CAPTURE_ROOT,modules=process.env.ORGTREE_NODE_MODULES||'E:/Libraries/Desktop/orgtree/node_modules'
if(!/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i.test(out||''))throw Error('owned output required')
try{
fs.mkdirSync(out,{recursive:true})
require(path.join(modules,'esbuild')).buildSync({entryPoints:[path.join(process.cwd(),'apps/desktop/renderer/tests/ws-connect-visual.tsx')],bundle:true,platform:'browser',format:'esm',outfile:path.join(out,'fixture.js'),nodePaths:[modules],loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}})
fs.copyFileSync(path.join(process.cwd(),'apps/desktop/renderer/src/styles.css'),path.join(out,'styles.css'))
fs.writeFileSync(path.join(out,'fixture.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
for(const key of ['userData','sessionData','logs','crashDumps']){const dir=path.join(out,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}
app.disableHardwareAcceleration()
const settle='new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,180))))'
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:700,useContentSize:true,show:false,paintWhenInitiallyHidden:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}}),receipts=[]
 try{
  win.webContents.session.webRequest.onBeforeRequest((d,done)=>done({cancel:!/^(file:|data:)/.test(d.url)}))
  for(const theme of ['dark','light']){
   await win.loadFile(path.join(out,'fixture.html'));win.webContents.setZoomFactor(.8)
   await win.webContents.executeJavaScript(`(async()=>{document.documentElement.classList.toggle('contrast-light',${theme==='light'});const end=performance.now()+5000;while(!document.querySelector('input[aria-label="Notify on (re)connect"]')){if(performance.now()>end)throw Error('switch missing');await new Promise(r=>setTimeout(r,20))}})()`)
   for(const enabled of [false,true]){
    const seen=await win.webContents.executeJavaScript(`(async()=>{
     const toggle=document.querySelector('input[aria-label="Notify on (re)connect"]');if(toggle.checked!==${enabled})toggle.click()
     const end=performance.now()+5000;while(toggle.disabled||toggle.checked!==${enabled}){if(performance.now()>end)throw Error('save never settled');await new Promise(r=>setTimeout(r,20))}
     toggle.scrollIntoView({block:'center'});await ${settle};const r=toggle.getBoundingClientRect()
     return {checked:toggle.checked,request:window.lastConnectRequest??null,visible:r.top>=0&&r.bottom<=innerHeight,text:document.body.innerText}
    })()`)
    assert.equal(seen.checked,enabled);assert.equal(seen.visible,true);assert.match(seen.text,/server messages still follow the pattern/)
    if(enabled)assert.equal(seen.request.notify_on_connect,true)
    await win.webContents.executeJavaScript(settle)
    const file=`notify-${enabled?'on':'off'}-${theme}.png`,frame=await win.webContents.capturePage();assert.equal(frame.isEmpty(),false)
    fs.writeFileSync(path.join(out,file),frame.toPNG());receipts.push({theme,enabled,file,...seen})
   }
  }
  fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify(receipts,null,2))
 }finally{win.destroy()}
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
}catch(error){console.error(error.stack||error);app.exit(1)}
