const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.TEMPLATE_FLICKER_OUT,deps='E:/Libraries/Desktop/orgtree/node_modules'
if(!/^C:[\\/]orgtree-build[\\/]epic-combo-sol[\\/]/i.test(out||''))throw Error('Owned output required')
fs.mkdirSync(out,{recursive:true})
for(const key of ['userData','sessionData','logs','crashDumps']){fs.mkdirSync(out+'/'+key,{recursive:true});app.setPath(key,out+'/'+key)}
app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1')
const esbuild=require(path.join(deps,'esbuild'))
try{
  esbuild.buildSync({entryPoints:['apps/desktop/renderer/tests/template-name-refresh-visual.tsx'],bundle:true,format:'iife',platform:'browser',jsx:'automatic',outfile:out+'/fixture.js',nodePaths:[deps],define:{'process.env.NODE_ENV':'"production"'},loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl','.svg':'dataurl','.png':'dataurl'}})
}catch(error){
  fs.writeFileSync(out+'/setup-error.json',JSON.stringify({error:error.stack||String(error)}));console.error(error);app.exit(1)
}finally{esbuild.stop()}
fs.writeFileSync(out+'/fixture.html','<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
const settle='new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,100))))'
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1920,height:1080,useContentSize:true,frame:false,show:false,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!/^(file:|data:)/.test(details.url)}))
  const records=[],screenshots=[]
  const persist=(passed=false)=>fs.writeFileSync(out+'/typing.json',JSON.stringify({records,screenshots,passed},null,2))
  const deadline=setTimeout(()=>{persist();app.exit(1)},90000)
  try{
    await win.loadFile(out+'/fixture.html')
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=Date.now()+10000;function frame(){if(document.querySelectorAll('.tp-row').length===4)resolve();else if(Date.now()>until)reject(Error('List did not load'));else requestAnimationFrame(frame)}frame()})`)
    await win.webContents.executeJavaScript(settle)
    await win.webContents.executeJavaScript(`(()=>{
      const nodes=[...document.querySelectorAll('.tp-row')],list=document.querySelector('.tp-list');
      const snapshot=()=>nodes.map(el=>({html:el.outerHTML,rect:el.getBoundingClientRect().toJSON()}));
      const initial=snapshot(),changes=[];
      const observer=new MutationObserver(()=>changes.push(snapshot()));observer.observe(list,{subtree:true,attributes:true,childList:true,characterData:true});
      Object.assign(window.templateTyping,{nodes,initial,changes,snapshot,observer});document.querySelector('#shell-create-name').focus();
    })()`)
    const shot=async label=>{await win.webContents.executeJavaScript(settle);const image=await win.webContents.capturePage();assert.equal(image.isEmpty(),false);assert.deepEqual(image.getSize(),{width:1920,height:1080});const filename=label+'.png';fs.writeFileSync(out+'/'+filename,image.toPNG());screenshots.push(filename);persist()}
    const record=async(label,index)=>{
      const r=await win.webContents.executeJavaScript(`(()=>{const t=window.templateTyping,rows=[...document.querySelectorAll('.tp-row')],snapshot=t.snapshot();return{label:${JSON.stringify(label)},name:document.querySelector('#shell-create-name').value,request:t.requests[${index}]?.name??null,rows:snapshot,initial:t.initial,stableIdentity:rows.every((el,i)=>el===t.nodes[i]),mutations:t.changes.length,changes:t.changes,selected:rows.filter(el=>el.getAttribute('aria-selected')==='true').map(el=>el.querySelector('.tp-name').textContent)}})()`)
      records.push(r);persist();assert.equal(r.stableIdentity,true);assert.deepEqual(r.rows,r.initial,'row markup and geometry must stay stable while typing');assert.deepEqual(r.changes,[],'no transient row mutations');assert.deepEqual(r.selected,['Empty']);return r
    }
    await record('before',-1);await shot('before-1920x1080')
    const text='Kite Studio'
    for(let i=0;i<text.length;i++){
      win.webContents.sendInputEvent({type:'char',keyCode:text[i]})
      await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=Date.now()+5000;function frame(){if(window.templateTyping.requests.length===${i+1})resolve();else if(Date.now()>until)reject(Error('Name request missing'));else requestAnimationFrame(frame)}frame()})`)
      await win.webContents.executeJavaScript(settle)
      const pending=await record('pending '+(i+1),i);assert.equal(pending.request,text.slice(0,i+1));assert.equal(pending.name,pending.request)
      if(i===3)await shot('typing-Kite-pending-1920x1080')
      await win.webContents.executeJavaScript(`window.templateTyping.requests[${i}].reply()`)
      await win.webContents.executeJavaScript(settle);await record('replied '+(i+1),i)
    }
    await shot('after-Kite-Studio-1920x1080');await win.webContents.executeJavaScript('window.templateTyping.observer.disconnect()')
    persist(true);console.log(JSON.stringify({characters:text.length,records:records.length,screenshots,passed:true}))
  }finally{clearTimeout(deadline);win.destroy()}
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
