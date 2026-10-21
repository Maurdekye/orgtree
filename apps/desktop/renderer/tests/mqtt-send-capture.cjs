const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.RETIRED_HEADER_OUT,deps='E:/Libraries/Desktop/orgtree/node_modules'
if(!/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i.test(out||''))throw Error('owned output required')
fs.mkdirSync(out,{recursive:true})
require(path.join(deps,'esbuild')).buildSync({entryPoints:['apps/desktop/renderer/tests/mqtt-send-visual.tsx'],bundle:true,format:'esm',platform:'browser',outfile:out+'/fixture.js',nodePaths:[deps],define:{'process.env.NODE_ENV':'"production"'}})
fs.writeFileSync(out+'/styles.css',['styles.css','shell.css'].map(p=>fs.readFileSync('apps/desktop/renderer/src/'+p,'utf8')).join('\n'))
fs.writeFileSync(out+'/fixture.html','<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
for(const key of ['userData','sessionData','logs','crashDumps']){fs.mkdirSync(out+'/'+key,{recursive:true});app.setPath(key,out+'/'+key)}app.disableHardwareAcceleration()
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:700,useContentSize:true,show:false,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}}),receipts=[]
 const settle='new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))'
 try{win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!/^(file:|data:)/.test(d.url)}));await win.loadFile(out+'/fixture.html');await new Promise(r=>setTimeout(r,250))
 for(const theme of ['dark','light']){
  const r=await win.webContents.executeJavaScript(`(async()=>{document.documentElement.classList.toggle('contrast-light',${theme==='light'});const el=document.querySelector('.wd-send-description');el.scrollIntoView({block:'center'});await ${settle};const r=el.getBoundingClientRect();return{text:el.textContent,visible:r.top>=0&&r.bottom<=innerHeight}})()`)
  assert.equal(r.visible,true);for(const word of ['3 messages sent','topic','64 KB','existing broker connection','QoS 0'])assert.ok(r.text.includes(word),word)
  await win.webContents.executeJavaScript(settle);const frame=await win.webContents.capturePage();assert.equal(frame.isEmpty(),false);fs.writeFileSync(out+'/'+theme+'.png',frame.toPNG());receipts.push({theme,...r})
 }fs.writeFileSync(out+'/capture.json',JSON.stringify(receipts,null,2))
 }finally{win.destroy()}
}).then(()=>app.exit(0),e=>{console.error(e.stack||e);app.exit(1)})
