const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.RETIRED_HEADER_OUT,deps='E:/Libraries/Desktop/orgtree/node_modules'
if(!/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i.test(out||''))throw Error('own output required')
fs.mkdirSync(out,{recursive:true})
require(path.join(deps,'esbuild')).buildSync({entryPoints:['apps/desktop/renderer/tests/projectjumpworking-visual.tsx'],bundle:true,format:'esm',platform:'browser',outfile:out+'/fixture.js',nodePaths:[deps],define:{'process.env.NODE_ENV':'"production"'}})
fs.writeFileSync(out+'/styles.css',['styles.css','shell.css'].map(p=>fs.readFileSync('apps/desktop/renderer/src/'+p,'utf8')).join('\n'))
fs.writeFileSync(out+'/fixture.html','<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
for(const key of ['userData','sessionData','logs','crashDumps']){fs.mkdirSync(out+'/'+key,{recursive:true});app.setPath(key,out+'/'+key)}app.disableHardwareAcceleration()
const settle='new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,150))))'
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:400,useContentSize:true,show:false,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}}),records=[]
 try{
  win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!/^(file:|data:)/.test(d.url)}));await win.loadFile(out+'/fixture.html')
  for(const theme of ['dark','light'])for(const busy of [true,false]){
   await win.webContents.executeJavaScript(`(async()=>{document.documentElement.classList.toggle('contrast-light',${theme==='light'});window.projectJumpFixture.setBusy(${busy});await ${settle}})()`)
   const chips=await win.webContents.executeJavaScript(`([...document.querySelectorAll('.desk-nav-chip')].map(b=>{const spin=b.querySelector('.cc-spin'),r=b.getBoundingClientRect();return{text:b.textContent,spinning:!!spin,animation:spin&&getComputedStyle(spin).animationName,width:r.width,height:r.height}}))`)
   records.push({theme,busy,chips});assert.deepEqual(chips.map(c=>c.spinning),busy?[true,true,false,true]:[false,false,false,false]);assert.ok(chips.every(c=>c.width>0&&c.height>0));if(busy){assert.ok(chips[0].animation&&chips[0].animation!=='none');assert.equal(chips[0].animation,chips[1].animation)}
   const im=await win.webContents.capturePage();assert.equal(im.isEmpty(),false);fs.writeFileSync(out+'/'+theme+'-'+(busy?'working':'idle')+'.png',im.toPNG())
  }
  fs.writeFileSync(out+'/results.json',JSON.stringify(records,null,2));console.log(JSON.stringify({cases:records.length,passed:true}))
 }finally{win.destroy()}
}).then(()=>app.exit(0),e=>{console.error(e.stack||e);app.exit(1)})
