const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.PROJECT_DRAFT_OUT,deps='E:/Libraries/Desktop/orgtree/node_modules'
if(!/^C:[\\/]orgtree-build[\\/]compaction-cmds-sol[\\/]/i.test(out||''))throw Error('own output required')
fs.mkdirSync(out,{recursive:true})
require(path.join(deps,'esbuild')).buildSync({entryPoints:['apps/desktop/renderer/tests/projectdraft-response-visual.tsx'],bundle:true,format:'esm',platform:'browser',outfile:out+'/fixture.js',nodePaths:[deps],define:{'process.env.NODE_ENV':'"production"'}})
fs.writeFileSync(out+'/styles.css',['styles.css','shell.css'].map(p=>fs.readFileSync('apps/desktop/renderer/src/'+p,'utf8')).join('\n'))
fs.writeFileSync(out+'/fixture.html','<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
for(const key of ['userData','sessionData','logs','crashDumps']){fs.mkdirSync(out+'/'+key,{recursive:true});app.setPath(key,out+'/'+key)}app.disableHardwareAcceleration()
const settle='new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,160))))'
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:700,useContentSize:true,show:false,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}}),records=[]
 try{
  win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!/^(file:|data:)/.test(d.url)}))
  for(const theme of ['dark','light']){
   await win.loadFile(out+'/fixture.html');await new Promise(r=>setTimeout(r,700))
   await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('contrast-light',${theme==='light'});document.querySelector('.sq.user button.project-token').click()`)
   await new Promise(r=>setTimeout(r,1200))
   const type=(name,summary)=>win.webContents.executeJavaScript(`(()=>{for(const [s,v,p] of [['.df-name',${JSON.stringify(name)},HTMLInputElement],['.df-charter',${JSON.stringify(summary)},HTMLTextAreaElement]]){const e=document.querySelector('.sq.draft '+s);Object.getOwnPropertyDescriptor(p.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}))}})()`)
   await type('project-a','Summary A');await win.webContents.executeJavaScript(settle)
   await win.webContents.executeJavaScript(`document.querySelector('.sq.draft .primary').click()`);await win.webContents.executeJavaScript(settle)
   const pending=await win.webContents.executeJavaScript(`(()=>{const d=document.querySelector('.sq.draft');return{pending:d.querySelector('.primary').disabled,cancel:d.querySelector('button:not(.primary)').disabled,name:d.querySelector('.df-name').value}})()`)
   assert.equal(pending.pending,true);assert.equal(pending.cancel,false)
   fs.writeFileSync(out+'/'+theme+'-pending.png',(await win.webContents.capturePage()).toPNG())
   await win.webContents.executeJavaScript(`document.querySelector('.sq.draft .df-foot button:not(.primary)').click()`);await win.webContents.executeJavaScript(settle)
   await win.webContents.executeJavaScript(`document.querySelector('.sq.user button.project-token').click()`);await new Promise(r=>setTimeout(r,1200))
   await type('project-b','Unsaved Summary B');await win.webContents.executeJavaScript(settle)
   await win.webContents.executeJavaScript('window.finishProject()');await win.webContents.executeJavaScript(settle)
   const kept=await win.webContents.executeJavaScript(`(()=>{const d=document.querySelector('.sq.draft');return{name:d?.querySelector('.df-name').value,summary:d?.querySelector('.df-charter').value,pending:d?.querySelector('.primary').disabled}})()`)
   assert.equal(kept.name,'project-b');assert.equal(kept.summary,'Unsaved Summary B');assert.equal(kept.pending,false)
   fs.writeFileSync(out+'/'+theme+'-replacement.png',(await win.webContents.capturePage()).toPNG());records.push({theme,pending,kept})
  }
  fs.writeFileSync(out+'/checks.json',JSON.stringify(records,null,2));console.log(JSON.stringify(records))
 }finally{win.destroy()}
}).then(()=>app.exit(0),e=>{console.error(e.stack||e);app.exit(1)})
