const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.PRESENTATION_CAPTURE_ROOT,modules=process.env.ORGTREE_NODE_MODULES||'E:/Libraries/Desktop/orgtree/node_modules'
if(!/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i.test(out||''))throw Error('owned capture output required')
try {
fs.mkdirSync(out,{recursive:true})
require(path.join(modules,'esbuild')).buildSync({entryPoints:[path.join(process.cwd(),'apps/desktop/renderer/tests/presentationscroll-ui.tsx')],
 bundle:true,platform:'browser',format:'esm',outfile:path.join(out,'fixture.js'),nodePaths:[modules],loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}})
fs.copyFileSync(path.join(process.cwd(),'apps/desktop/renderer/src/styles.css'),path.join(out,'styles.css'))
fs.writeFileSync(path.join(out,'fixture.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
for(const key of ['userData','sessionData','logs','crashDumps']){const dir=path.join(out,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}
app.disableHardwareAcceleration()
const settle='new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,180))))'
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:700,useContentSize:true,show:false,paintWhenInitiallyHidden:true,
  webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}})
 const receipts=[]
 try{
  win.webContents.session.webRequest.onBeforeRequest((d,done)=>done({cancel:!/^(file:|data:)/.test(d.url)}))
  await win.loadFile(path.join(out,'fixture.html'))
  win.webContents.setZoomFactor(.8)
  for(const theme of ['dark','light'])for(const surface of ['modal','agent','project']){
   const seen=await win.webContents.executeJavaScript(`(async()=>{
    const deadline=performance.now()+5000
    while(!window.openGallery){if(performance.now()>deadline)throw Error('fixture failed to render');await new Promise(r=>setTimeout(r,20))}
    document.documentElement.classList.toggle('contrast-light',${theme==='light'})
    const key=window.openGallery(${JSON.stringify(surface)},true)
    while(document.body.dataset.fixture!==String(key)||!document.querySelector('.doc-gallery-row.on')||!document.querySelector('.mailer-read')?.textContent.includes('Opening the collection')){
     if(performance.now()>deadline)throw Error('opening never settled');await new Promise(r=>setTimeout(r,20))
    }
    await ${settle}
    const list=document.querySelector('.mailer-list'),r=list.getBoundingClientRect()
    return {first:document.querySelector('.doc-gallery-row .mfrom')?.textContent,
     selected:document.querySelector('.doc-gallery-row.on .mfrom')?.textContent,
     newer:!!document.querySelector('.doc-list-newer'),rows:document.querySelectorAll('.doc-gallery-row').length,
     list:{width:r.width,height:r.height,scrollTop:list.scrollTop},selectedBox:(()=>{const b=document.querySelector('.doc-gallery-row.on').getBoundingClientRect();return {top:b.top,bottom:b.bottom,listTop:r.top,listBottom:r.bottom}})(),read:document.querySelector('.mailer-read')?.textContent}
   })()`)
   assert.equal(seen.first,'Newest presentation');assert.equal(seen.newer,false)
   assert.equal(seen.selected,'Oldest unread presentation — selected')
   assert.ok(seen.list.width>100&&seen.list.height>100);assert.ok(seen.list.scrollTop>0);assert.ok(seen.selectedBox.top>=seen.selectedBox.listTop-1&&seen.selectedBox.bottom<=seen.selectedBox.listBottom+1,'selected row is visible: '+JSON.stringify(seen));
   await win.webContents.executeJavaScript(settle)
   const file=`${surface}-${theme}.png`,frame=await win.webContents.capturePage();assert.equal(frame.isEmpty(),false)
   fs.writeFileSync(path.join(out,file),frame.toPNG());receipts.push({surface,theme,file,...seen})
  }
  fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify(receipts,null,2))
 }finally{win.destroy()}
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
}catch(error){console.error(error.stack||error);app.exit(1)}
