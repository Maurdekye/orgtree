const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.RETIRED_HEADER_OUT,deps='E:/Libraries/Desktop/orgtree/node_modules',red=process.env.RETIRED_HEADER_RED==='1'
if(!/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i.test(out||''))throw Error('own output required')
fs.mkdirSync(out,{recursive:true})
require(path.join(deps,'esbuild')).buildSync({entryPoints:['apps/desktop/renderer/tests/rootretiredhire-visual.tsx'],bundle:true,format:'esm',platform:'browser',outfile:out+'/fixture.js',nodePaths:[deps],define:{'process.env.NODE_ENV':'"production"'}})
fs.writeFileSync(out+'/styles.css',['styles.css','shell.css'].map(p=>fs.readFileSync('apps/desktop/renderer/src/'+p,'utf8')).join('\n'))
fs.writeFileSync(out+'/fixture.html','<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
for(const key of ['userData','sessionData','logs','crashDumps']){fs.mkdirSync(out+'/'+key,{recursive:true});app.setPath(key,out+'/'+key)}app.disableHardwareAcceleration()
const settle='new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,160))))'
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:700,useContentSize:true,show:false,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}}),records=[]
 try{
  win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!/^(file:|data:)/.test(d.url)}))
  await win.loadFile(out+'/fixture.html');await new Promise(r=>setTimeout(r,1500))
  for(const theme of ['dark','light']){
   await win.webContents.executeJavaScript(`(async()=>{document.documentElement.classList.toggle('contrast-light',${theme==='light'});const space=document.querySelector('.space'),eye=document.querySelector('.sq.user');if(!eye)throw Error('missing actual eye');space.style.transformOrigin='0 0';space.style.transform='scale(1.6)';space.style.setProperty('--invzf',1/1.6);const r=eye.getBoundingClientRect();space.style.transform='translate('+(300-r.left)+'px,'+(100-r.top)+'px) scale(1.6)';await ${settle}})()`)
   const point=await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.sq.user').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.bottom-3)}})()`)
   win.webContents.sendInputEvent({type:'mouseMove',...point});await win.webContents.executeJavaScript(settle)
   const record=await win.webContents.executeJavaScript(`(()=>{const eye=document.querySelector('.sq.user'),list=document.querySelector('.root-retired-list'),pill=list.querySelector('button'),p=pill.getBoundingClientRect(),strip=eye.querySelector('.hsof');if(strip.classList.contains('hire-compact'))strip.querySelector('.hire-expand')?.click();return{hover:eye.matches(':hover'),listLayer:getComputedStyle(list).zIndex,pill:p.toJSON()}})()`)
   await win.webContents.executeJavaScript(settle)
   record.theme=theme
   record.hits=await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.root-retired-list button').getBoundingClientRect();return [...document.querySelectorAll('.sq.user > .hsof button:not(.hire-expand)')].map(b=>{const r=b.getBoundingClientRect(),left=Math.max(p.left,r.left),right=Math.min(p.right,r.right),top=Math.max(p.top,r.top),bottom=Math.min(p.bottom,r.bottom);if(right-left<1||bottom-top<1)return null;const x=(left+right)/2,y=(top+bottom)/2,hit=document.elementFromPoint(x,y);return{text:b.textContent,x,y,hit:hit?.closest('button')?.textContent,owns:hit===b||b.contains(hit)}}).filter(Boolean)})()`)
   records.push(record)
   fs.writeFileSync(out+'/geometry.json',JSON.stringify(records,null,2))
   assert.equal(record.hover,true,'real eye hover must be active')
   assert.ok(record.hits.length>0,'positive control: hire buttons and pill really overlap')
   if(!red){const im=await win.webContents.capturePage();assert.equal(im.isEmpty(),false);fs.writeFileSync(out+'/'+theme+'.png',im.toPNG())}
  }
  fs.writeFileSync(out+'/geometry.json',JSON.stringify(records,null,2))
  const blocked=records.flatMap(r=>r.hits).filter(h=>!h.owns)
  console.log(JSON.stringify({cases:records.length,overlaps:records.flatMap(r=>r.hits).length,blocked}))
  assert.equal(blocked.length,0,'every overlapped hire button must own its hit target')
 }finally{win.destroy()}
}).then(()=>app.exit(0),e=>{console.error(e.stack||e);app.exit(1)})
