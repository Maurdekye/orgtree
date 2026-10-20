const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.ORGTREE_PROJECT_DOG_CAPTURE_ROOT
assert.match(out||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
for(const key of ['userData','sessionData','logs','crashDumps']){const dir=path.join(out,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{})
const wait=w=>w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,150))))')
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:700,show:false,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}}),cases=[]
 const check=(name,fn,state)=>{try{fn();cases.push({name,passed:true,state})}catch(e){cases.push({name,passed:false,error:e.message,state})}}
 try{
  win.webContents.session.webRequest.onBeforeRequest((d,done)=>done({cancel:!/^(file:|data:)/.test(d.url)}))
  await win.loadFile(path.join(out,'index.html'));await wait(win)
  for(const light of [false,true]){
   const theme=light?'light':'dark'
   await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('contrast-light',${light})`)
   for(const count of [8,9]){
    await win.webContents.executeJavaScript(`window.fixtureRender(${count})`);await wait(win)
    const state=await win.webContents.executeJavaScript(`({canvas:document.querySelectorAll('.wd-chip').length,desk:document.querySelectorAll('.desk-dog-chip').length,groups:Array.from(document.querySelectorAll('[data-watchdog-group]')).map(e=>({text:e.textContent,box:e.getBoundingClientRect().toJSON()}))})`)
    check(theme+'-'+count+'-boundary',()=>{assert.equal(state.canvas,count===8?8:1);assert.equal(state.desk,count===8?8:0);assert.equal(state.groups.length,count===8?0:2);for(const g of state.groups){assert.equal(g.text,'9 watchdogs');assert.ok(g.box.width>=104);assert.ok(g.box.right<=1000)}},state)
    await wait(win);fs.writeFileSync(path.join(out,`watchdog-group-${count}-${theme}.png`),(await win.webContents.capturePage()).toPNG())
   }
   await win.webContents.executeJavaScript(`document.querySelector('[data-watchdog-group]').click()`);await wait(win)
   const list=await win.webContents.executeJavaScript(`(()=>{const d=document.querySelector('[role="dialog"][aria-label="worker watchdogs"]'),links=[...d.querySelectorAll('.watchdog-link')];return{count:links.length,ids:links.map(e=>e.dataset.objectId),kinds:links.map(e=>e.className),bounds:d.getBoundingClientRect().toJSON()}})()`)
   check(theme+'-expanded-all-nine',()=>{assert.equal(list.count,9);assert.equal(list.ids[8],'worker/watch-9');assert.match(list.kinds[8],/listener-watch/);assert.ok(list.bounds.bottom<=700);assert.ok(list.bounds.right<=1000)},list)
   await wait(win);fs.writeFileSync(path.join(out,`watchdog-group-expanded-${theme}.png`),(await win.webContents.capturePage()).toPNG())
   const opened=await win.webContents.executeJavaScript(`(()=>{document.querySelectorAll('[aria-label="worker watchdogs"] .watchdog-link')[8].click();return window.fixtureOpened.slice(-1)})()`)
   check(theme+'-opens-ninth',()=>assert.deepEqual(opened,['worker/watch-9']),opened)
   await wait(win)
  }
 }finally{win.destroy()}
 const receipt={tests:cases.length,passed:cases.filter(c=>c.passed).length,failed:cases.filter(c=>!c.passed).length,cases}
 fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));assert.equal(receipt.tests,8);assert.equal(receipt.failed,0)
}).then(()=>app.exit(0),e=>{console.error(e.stack||e);app.exit(1)})
