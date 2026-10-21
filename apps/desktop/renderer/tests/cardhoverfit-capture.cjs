const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.RETIRED_HEADER_OUT,deps='E:/Libraries/Desktop/orgtree/node_modules'
if(!/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i.test(out||''))throw Error('own output required')
fs.mkdirSync(out,{recursive:true})
require(path.join(deps,'esbuild')).buildSync({entryPoints:['apps/desktop/renderer/tests/cardhoverfit-visual.tsx'],bundle:true,format:'esm',platform:'browser',outfile:out+'/fixture.js',nodePaths:[deps],define:{'process.env.NODE_ENV':'"production"'}})
fs.writeFileSync(out+'/styles.css',['styles.css','shell.css'].map(p=>fs.readFileSync('apps/desktop/renderer/src/'+p,'utf8')).join('\n'))
fs.writeFileSync(out+'/fixture.html','<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
for(const key of ['userData','sessionData','logs','crashDumps']){fs.mkdirSync(out+'/'+key,{recursive:true});app.setPath(key,out+'/'+key)}app.disableHardwareAcceleration()
const settle='new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))'
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:700,useContentSize:true,show:false,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}}),records=[],failures=[]
 const snapshot=()=>win.webContents.executeJavaScript(`([...document.querySelectorAll('.sq')].map(card=>{const fit=card.querySelector('.card-face'),name=card.querySelector('.name'),full=card.querySelector('.name-full'),badges=card.querySelector('.sq-badges');return{kind:card.closest('[data-kind]').dataset.kind,scale:fit?Number(fit.dataset.cardScale):null,card:card.getBoundingClientRect().toJSON(),clipped:!!name&&name.scrollWidth>name.clientWidth,overlay:full?.textContent,overlayPointer:full&&getComputedStyle(full).pointerEvents,retiredLast:!badges||badges.lastElementChild?.classList.contains('retired-token'),badgeTexts:badges&&[...badges.children].map(el=>el.textContent)}}))`)
 const capture=async name=>{await win.webContents.executeJavaScript(settle);const im=await win.webContents.capturePage();assert.equal(im.isEmpty(),false);fs.writeFileSync(out+'/'+name+'.png',im.toPNG())}
 try{
  win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!/^(file:|data:)/.test(d.url)}));await win.loadFile(out+'/fixture.html');await new Promise(r=>setTimeout(r,300))
  for(const lod of ['norm','mini'])for(const crowded of [false,true])for(const theme of ['dark','light'])for(const zoom of [.7,1.5]){
   await win.webContents.executeJavaScript(`(async()=>{document.documentElement.classList.toggle('contrast-light',${theme==='light'});window.cardHoverFixture.render('${lod}',${crowded});await ${settle};document.querySelector('.space').style.transform='scale(${zoom})';await ${settle}})()`)
   const rest=await snapshot(),take=lod==='norm'&&zoom===1.5&&(!crowded||theme==='dark'),prefix=(crowded?'crowded-':'')+theme
   if(take)await capture(prefix+'-rest')
   await win.webContents.executeJavaScript(`(async()=>{for(const el of document.querySelectorAll('.sq'))el.dispatchEvent(new MouseEvent('pointerover',{bubbles:true,relatedTarget:document.body}));await ${settle};window.cardHoverFixture.refresh();await ${settle}})()`)
   const hover=await snapshot();if(take)await capture(prefix+'-hover')
   await win.webContents.executeJavaScript(`(async()=>{for(const el of document.querySelectorAll('.sq'))el.dispatchEvent(new MouseEvent('pointerout',{bubbles:true,relatedTarget:document.body}));await ${settle};window.cardHoverFixture.refresh();await ${settle}})()`)
   const left=await snapshot();records.push({lod,crowded,theme,zoom,rest,hover,left})
   for(let i=0;i<rest.length;i++){
    const a=rest[i],b=hover[i],c=left[i],context={kind:a.kind,lod,crowded,theme,zoom}
    if(a.scale!==b.scale||a.scale!==c.scale)failures.push({...context,reason:'hover changed fit',scales:[a.scale,b.scale,c.scale]})
    if(lod==='norm'){
     if(!a.clipped||!b.overlay||b.overlayPointer!=='none'||c.overlay)failures.push({...context,reason:'full-name reveal control failed'})
     if(!a.retiredLast)failures.push({...context,reason:'retired chip must be last'})
     if(crowded?!(a.scale<1):a.scale!==1)failures.push({...context,reason:'real content fit control failed',scale:a.scale})
    }else if(a.scale!==null||b.overlay)failures.push({...context,reason:'mini must retain its own layout'})
    if(Math.abs(a.card.width-b.card.width)>.01||Math.abs(a.card.height-b.card.height)>.01)failures.push({...context,reason:'fixed card bounds changed'})
   }
  }
  fs.writeFileSync(out+'/geometry.json',JSON.stringify({records,failures},null,2));console.log(JSON.stringify({cases:records.length,failures}));assert.equal(failures.length,0)
 }finally{win.destroy()}
}).then(()=>app.exit(0),e=>{console.error(e.stack||e);app.exit(1)})
