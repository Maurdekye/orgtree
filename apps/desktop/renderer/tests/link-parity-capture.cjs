const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.LINK_CAPTURE_ROOT,modules=process.env.ORGTREE_NODE_MODULES||'E:/Libraries/Desktop/orgtree/node_modules'
if(!/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i.test(out||''))throw Error('owned capture output required')
fs.mkdirSync(out,{recursive:true})
require(path.join(modules,'esbuild')).buildSync({entryPoints:[path.join(process.cwd(),'apps/desktop/renderer/tests/linkparity-ui.tsx')],bundle:true,platform:'browser',format:'esm',outfile:path.join(out,'fixture.js'),nodePaths:[modules],loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}})
fs.copyFileSync(path.join(process.cwd(),'apps/desktop/renderer/src/styles.css'),path.join(out,'styles.css'))
fs.writeFileSync(path.join(out,'fixture.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
for(const key of ['userData','sessionData','logs','crashDumps']){const dir=path.join(out,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}
app.disableHardwareAcceleration()
const settle='new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,160))))'
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:700,useContentSize:true,show:false,paintWhenInitiallyHidden:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}})
 const receipts=[],errors=[];win.webContents.on('preload-error',(_,p,e)=>errors.push(String(e)));win.webContents.on('console-message',(_,level,message)=>{if(level===3&&!message.includes('ERR_FILE_NOT_FOUND'))errors.push(message)})
 try{
  win.webContents.session.webRequest.onBeforeRequest((d,done)=>done({cancel:!/^(file:|data:)/.test(d.url)}))
  await win.loadFile(path.join(out,'fixture.html'));win.webContents.setZoomFactor(.85)
  for(const theme of ['dark','light'])for(const target of ['ticket','document','mail','icon','watchdog','user','contact','org','orgrow','sender','file']){
   const seen=await win.webContents.executeJavaScript(`(async()=>{
    document.documentElement.classList.toggle('contrast-light',${theme==='light'})
    const deadline=performance.now()+6000
    while(!document.querySelector('[data-sample="file"]')){if(performance.now()>deadline)throw Error('fixture failed');await new Promise(r=>setTimeout(r,20))}
    document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))
    const holder=document.querySelector('[data-sample="${target}"]'),link=holder.querySelector('button,[role="button"],a')
    link.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));await ${settle}
    const title=link.title
    document.querySelector('#identity-readout').textContent='${target} identity: '+title
    const r=link.getBoundingClientRect();link.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:r.left+8,clientY:r.top+8}))
    await ${settle}
    const root=document.querySelector('.ctxmenu:not(.ctxmenu-submenu)')
    if(!root)throw Error('no menu for ${target}')
    if('${target}'==='sender'){root.querySelector('[role="menuitem"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await ${settle}}
    const items=[...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map(el=>({label:el.textContent.trim(),disabled:el.disabled,title:el.title}))
    const b=root.getBoundingClientRect();return{title,items,box:{x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height},viewport:{width:innerWidth,height:innerHeight}}
   })()`)
   assert.ok(seen.items.length>0);assert.ok(seen.box.width>50&&seen.box.height>20)
   assert.ok(seen.box.x>=0&&seen.box.y>=0&&seen.box.right<=seen.viewport.width+1&&seen.box.bottom<=seen.viewport.height+1)
   if(target==='mail')assert.match(seen.title,/writer.*message/)
   if(target==='icon')assert.match(seen.title,/^open mail\nwriter/)
   if(target==='contact')assert.equal(seen.items[0].disabled,true)
   if(target==='user')assert.deepEqual(seen.items.map(e=>e.label),['Copy mention','Open inbox'])
   let file
   if(['mail','contact','user'].includes(target)){
    await win.webContents.executeJavaScript(settle)
    const frame=await win.webContents.capturePage();assert.equal(frame.isEmpty(),false)
    file=`${target}-${theme}.png`;fs.writeFileSync(path.join(out,file),frame.toPNG())
   }
   receipts.push({target,theme,file,...seen})
  }
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify({receipts,errors},null,2))
 }finally{win.destroy()}
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
